// ============================================================
// 词典采集器（collect.ts）
//
// 职责：调用 AI 按词条 schema（见 docs/ai-dictionary-schema.md）生成
//       词典词条，BFS 广度遍历扩展词表，校验通过后入库
//       data/dict.db 并落盘 YAML（data/words/）。
//
// 遍历策略（CEFR 优先级）：
//   队列按等级分桶 A1 < A2 < B1 < B2 < C1 < C2 < unknown；
//   桶内按权威词表连续分数升序（二分插入，简单词优先）。
//   入队时优先查权威词表（data/word_cefr_minified.db，含真实词频 freq）；
//   词表未覆盖的新词回退到继承父词/AI 估计。--seed-cefr 可按等级全量入队。
//   --max-cefr 关卡：超过目标等级即停止（unknown 桶同样被挡住）。
//   建议线下预采 A1→B2（常用词全覆盖）；C1/C2 与未收录词适合 on-demand
//   （在线查阅时实时生成，管线核心 callModel/validate/ingest 可复用）。
//
// 可靠性：
//   - 校验失败把报错回喂模型重试（≤2 次），最终失败输出存 data/failed/
//   - state.json 断点续跑；--fresh 清空重来
//   - 并发可调：--limit N / COLLECT_CONCURRENCY（默认 5，网关限 5）
//
// 用法：
//   bun run src/collect.ts                          # 默认 10 词
//   bun run src/collect.ts --max 100000 --limit 15 --auto-audit
//   bun run src/collect.ts --seed-cefr A1 --max 8000   # 按权威词表全量入队 A1
//   bun run src/collect.ts --yaml                   # 额外落盘 YAML（默认关，省 IO）
//   bun run src/collect.ts --max 5000 --limit 5 --max-cefr B2
//   bun run src/collect.ts --fresh                  # 清空数据重新开始
//
// 无人值守：
//   --auto-audit：队列耗尽时自动审计自洽缺口（findUncovered）并写回队列，
//                 直到真正闭环（缺口全部可查）才停止。
//   429 用 5/10/20/40s 退避；worker 池各词独立，单词重试不阻塞其他词。
//
// 过滤层（防止长尾垃圾词膨胀队列）：
//   规则层：词表 lemma 链接把屈折形式归原（meaner→mean，形式由原形覆盖）；
//           词表未收录的词挂起（suspects），攒够一批交给 AI 批量过滤，
//           拒绝词入 rejects 黑名单（持久化），幸存入 unknown 桶。
//           词表内的词信任词表（含少量有界噪声，如专名/缩写）。
// ============================================================
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { createDb, ingest, parseYaml, validate } from "./schema.ts";
import { findUncovered } from "./closure.ts";
import { loadCefr, loadLemmaLinks } from "./cefrList.ts";
import { loadEnv } from "./env.ts";

const env = loadEnv();
const API_ENTRY = env.API_ENTRY;
const API_TOKEN = env.API_TOKEN;
if (!API_ENTRY || !API_TOKEN) {
  console.error("缺少 API_ENTRY / API_TOKEN（检查项目根 .env.dev）");
  process.exit(1);
}

const MODEL = env.COLLECT_MODEL ?? "deepseek-v4-flash";
const DEFAULT_SEEDS = ["run", "apple", "happy", "book", "water"];

// 数据目录：默认项目根 data/，可用 COLLECT_DATA_DIR 覆盖
const DIR = import.meta.dir;
const DATA_DIR = env.COLLECT_DATA_DIR ?? join(DIR, "..", "data");
const WORDS_DIR = join(DATA_DIR, "words");
const FAIL_DIR = join(DATA_DIR, "failed");
const DB_PATH = join(DATA_DIR, "dict.db");
const STATE_PATH = join(DATA_DIR, "state.json");
const PROGRESS_PATH = join(DATA_DIR, "progress.json");

// 权威 CEFR 词表：入队优先级与最终标注的来源；未覆盖词回退到继承/AI 估计
const CEFR_DB = env.COLLECT_CEFR_DB ?? join(DATA_DIR, "word_cefr_minified.db");
const cefrMap = existsSync(CEFR_DB) ? loadCefr(CEFR_DB) : new Map();
// 词表 lemma 链接：屈折形式归原（规则层）+ 入库补全变形
const { lemmaOf, formsOf } = existsSync(CEFR_DB)
  ? loadLemmaLinks(CEFR_DB)
  : { lemmaOf: new Map<string, string>(), formsOf: new Map<string, { surface: string; label: string }[]>() };

// ---------- CLI / 环境配置 ----------
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const maxWords = parseInt(arg("max") ?? env.COLLECT_MAX_WORDS ?? "10", 10);
const concurrency = parseInt(arg("limit") ?? env.COLLECT_CONCURRENCY ?? "5", 10);
const seeds = (arg("seed") ?? DEFAULT_SEEDS.join(" ")).split(/\s+/).filter(Boolean).map((s) => s.toLowerCase());
const fresh = process.argv.includes("--fresh");
const autoAudit = process.argv.includes("--auto-audit");
const seedCefr = arg("seed-cefr")?.toUpperCase();
// 默认不落盘 YAML（万级词条 IO 浪费），调试/人工校对时 --yaml 打开
const saveYaml = process.argv.includes("--yaml");

// CEFR 等级顺序与关卡：A1(0) … C2(5)，unknown(6) 放最后
const LEVEL_ORDER = ["A1", "A2", "B1", "B2", "C1", "C2", "unknown"] as const;
const LEVEL_RANK: Record<string, number> = Object.fromEntries(LEVEL_ORDER.map((l, i) => [l, i]));
const argMaxCefr = arg("max-cefr")?.toUpperCase();
const maxRank = argMaxCefr ? (LEVEL_RANK[argMaxCefr] ?? Infinity) : Infinity;

if (fresh) {
  for (const p of [DB_PATH, STATE_PATH, WORDS_DIR, FAIL_DIR]) rmSync(p, { recursive: true, force: true });
}
mkdirSync(WORDS_DIR, { recursive: true });
mkdirSync(FAIL_DIR, { recursive: true });

const db = createDb(new Database(DB_PATH));

// 黑名单（AI 批量过滤拒绝的词）与挂起候选（词表外，等批量过滤）
const rejects = new Set<string>();
for (const r of db.query("SELECT surface FROM rejects").all() as any[]) rejects.add(String(r.surface).toLowerCase());
const suspects: string[] = [];
const suspectSet = new Set<string>();
const FILTER_BATCH = 100; // 每批交给 AI 过滤的词数

// ---------- BFS 状态：按 CEFR 分桶的队列 ----------
// visited 防重复入队；processed 计已处理词数（失败也计，防死循环）
const buckets: Record<string, string[]> = Object.fromEntries(LEVEL_ORDER.map((l) => [l, []]));
const visited = new Set<string>();
// 桶内排序依据：权威词表连续分数（无分数词按 Infinity 排末尾）
const scoresOf = new Map<string, number>();
let processed = 0;
let failures = 0;
let rateLimit429 = 0;

// 进度心跳：输出一行进度并原子落盘 progress.json（外部监控 tail/jq 均可用）
function heartbeat(level: string | null, t0: number) {
  const elapsed = (Date.now() - t0) / 1000;
  const speed = processed / Math.max(elapsed, 1);
  const queueStats = LEVEL_ORDER.filter((l) => buckets[l].length > 0).map((l) => `${l}:${buckets[l].length}`).join(" ");
  const queueTotal = LEVEL_ORDER.reduce((n, l) => n + buckets[l].length, 0);
  console.log(`[进度] ${processed}/${maxWords} 词 并发=${concurrency} 429=${rateLimit429} 失败=${failures} ${speed.toFixed(2)}词/s 等级=${level ?? "-"} 队列${queueTotal}[${queueStats || "空"}]`);
  writeFileSync(PROGRESS_PATH, JSON.stringify({
    processed, maxWords, failures, rateLimit429, level,
    elapsedSec: Math.round(elapsed),
    buckets, at: new Date().toISOString(),
  }, null, 2));
}

function enqueue(word: string, fallbackLevel: string) {
  const w = word.toLowerCase();
  if (visited.has(w) || rejects.has(w)) return;
  if (w.length < 2 && !["a", "i"].includes(w)) return;
  // 规则层①：屈折形式归原（词表 lemma 链接）。形式由原形词条的变形补全覆盖
  // （completeInflections），故可安全跳过并标记 visited，不再单独收录
  const lemma = lemmaOf.get(w);
  if (lemma && lemma !== w) {
    visited.add(w);
    enqueue(lemma, fallbackLevel);
    return;
  }
  visited.add(w);
  const entry = cefrMap.get(w);
  if (!entry) {
    // 规则层②：词表未收录 → 挂起，攒够一批交给 AI 过滤（不直接入桶）
    if (!suspectSet.has(w)) {
      suspectSet.add(w);
      suspects.push(w);
    }
    return;
  }
  // 优先权威词表等级，未覆盖则回退（父词继承/AI 估计）
  const lvl = entry.level ?? fallbackLevel;
  const bucket = buckets[LEVEL_RANK[lvl] === undefined ? "unknown" : lvl];
  const score = entry.score ?? Infinity;
  scoresOf.set(w, score);
  // 二分插入，保持桶内按分数升序（分数低 = 更简单，优先处理）
  let lo = 0;
  let hi = bucket.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((scoresOf.get(bucket[mid]) ?? Infinity) <= score) lo = mid + 1;
    else hi = mid;
  }
  bucket.splice(lo, 0, w);
}

// 通过 AI 批量过滤的词表外词：入 unknown 桶（等级未知，最后处理）
function enqueueApproved(w: string) {
  const bucket = buckets.unknown;
  scoresOf.set(w, Infinity);
  let lo = 0;
  let hi = bucket.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((scoresOf.get(bucket[mid]) ?? Infinity) <= Infinity) lo = mid + 1;
    else hi = mid;
  }
  bucket.splice(lo, 0, w);
}

// AI 批量过滤：一批候选词 → 返回应拒绝（skip）的词集合
// 排除式问法（"挑出不该收录的"）比正向问"哪些是真词"更能让模型下判断
const FILTER_PROMPT = `你是英语词典编纂助手。下面是候选词列表，请判断其中哪些**不应该**作为英语词典词条收录，逐行给出结论。

应该收录：正常的英语单词、已被英语吸收的借词（cafe、sushi）、常用缩略词（ok、tv）。
不应该收录：缩写/首字母词（fbi、adhd、atm）、人名地名品牌（mozart、saratoga、iphone）、拼写错误、非英语借词的纯外语词（bonjour、der）、意义不明的衍生组合（a-levels、about-faced）。

输出格式：每行一个词，\`词|keep\` 或 \`词|skip|简短理由\`。只输出这些行，不要任何其它内容。`;

async function filterWords(words: string[]): Promise<Set<string>> {
  const messages = [
    { role: "system", content: FILTER_PROMPT },
    { role: "user", content: words.join("\n") },
  ];
  const res = await fetch(API_ENTRY, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${API_TOKEN}`,
      accept: "text/event-stream",
    },
    body: JSON.stringify({ model: MODEL, messages, max_tokens: 8000, temperature: 0, stream: true }),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const content = await readSse(res);
  const skip = new Set<string>();
  for (const line of content.split("\n")) {
    const m = line.trim().match(/^([a-z'-]+)\|skip(?:\|(.*))?$/i);
    if (m) skip.add(m[1].toLowerCase());
  }
  return skip;
}

// 跑一批过滤：拒绝词入黑名单（持久化），幸存词入 unknown 桶
async function runFilterBatch() {
  const batch = suspects.splice(0);
  suspectSet.clear();
  try {
    const skip = await filterWords(batch);
    for (const s of skip) {
      rejects.add(s);
      db.query("INSERT OR IGNORE INTO rejects (surface, reason) VALUES (?,?)").run(s, "AI 批量过滤");
    }
    for (const w of batch) if (!skip.has(w)) enqueueApproved(w);
    console.log(`[过滤] ${batch.length} 词，拒绝 ${skip.size}（如 ${[...skip].slice(0, 5).join(", ") || "无"}）`);
  } catch (e) {
    // 过滤失败：词放回挂起列表，下轮再试（不丢词）
    for (const w of batch) {
      if (!suspectSet.has(w)) {
        suspectSet.add(w);
        suspects.push(w);
      }
    }
    console.log(`  ⚠ 批量过滤失败: ${e}，${batch.length} 词下轮重试`);
  }
}

// 规则层配套：用词表 lemma 链接补全该词缺失的变形（零 API 成本）。
// enqueue 已把屈折形式归到原形，这里保证"形式 → 原形"的检索闭环
function completeInflections(lemma: string) {
  const forms = formsOf.get(lemma);
  if (!forms) return;
  const wordId = (db.query("SELECT id FROM words WHERE lemma=? AND variant=0").get(lemma) as any)?.id;
  if (!wordId) return;
  for (const f of forms) {
    db.query(`INSERT OR IGNORE INTO terms (word_id, sense_id, surface, kind, label)
      SELECT ?, NULL, ?, 'inflection', ? WHERE NOT EXISTS (
        SELECT 1 FROM terms WHERE word_id=? AND sense_id IS NULL AND surface=? AND kind='inflection')`)
      .run(wordId, f.surface, f.label, wordId, f.surface);
  }
}

// 取当前应处理的等级桶：低于等于关卡的最低非空桶
function nextLevel(): string | null {
  for (const l of LEVEL_ORDER) {
    if (LEVEL_RANK[l] > maxRank) return null;
    if (buckets[l].length > 0) return l;
  }
  return null;
}

function saveState() {
  writeFileSync(STATE_PATH, JSON.stringify({ buckets, visited: [...visited], suspects, processed }, null, 2));
}
function loadState() {
  // 注意：断点恢复时桶里的词直接取回即可，visited 只是去重集合，
  // 不能再用 visited 过滤（否则队列会被整个滤空）。
  const s = JSON.parse(readFileSync(STATE_PATH, "utf8"));
  for (const w of s.visited) visited.add(w);
  // 存量队列：按权威词表重新分桶（升级优先级）；词表外的屈折形式由原形覆盖，剔除
  for (const l of LEVEL_ORDER) {
    for (const w of s.buckets?.[l] ?? []) {
      const e = cefrMap.get(w);
      if (e) {
        scoresOf.set(w, e.score);
        buckets[e.level].push(w);
      } else if (lemmaOf.get(w) && lemmaOf.get(w) !== w) {
        visited.add(w); // 存量队列里的屈折形式：归原后由原形词条覆盖
      } else {
        buckets[l].push(w);
      }
    }
  }
  // 桶内按分数升序（简单词优先）
  for (const l of LEVEL_ORDER) buckets[l].sort((a, b) => (scoresOf.get(a) ?? Infinity) - (scoresOf.get(b) ?? Infinity));
  suspects.push(...(s.suspects ?? []));
  for (const w of suspects) suspectSet.add(w);
  processed = s.processed ?? 0;
}

// ---------- BFS 扩展：从释义/例句/同反义/搭配提取新词 ----------
// 自洽（closure）目标：词条里出现的每个词都应可查。因此不再过滤功能词
// （the/of/to…）——它们本身是词典条目，缺少它们会破坏"遇到不懂的词就
// 能点"的闭环。只剔除占位符类（sb./sth.）。完整缺口由 src/audit.ts 审计。
const STOPWORDS = new Set(["sb", "sth", "sb.", "sth.", "e.g.", "etc."]);
function extractWords(data: any): string[] {
  const out: string[] = [];
  const push = (t: string) => {
    let w = t.toLowerCase().replace(/^['-]+|['-]+$/g, "");
    // 所有格 "animal's" → "animal"；残余撇号的缩写（we've/don't）整体
    // 剔除，其成分词（we/have/do/not）会作为独立 token 出现
    if (w.endsWith("'s")) w = w.slice(0, -2);
    if (w.includes("'")) return;
    if (STOPWORDS.has(w) || /^\d/.test(w)) return;
    if (w.length < 2 && !["a", "i"].includes(w)) return;
    out.push(w);
  };
  const texts: string[] = [];
  for (const e of data.entries ?? []) {
    if (e.def_en) texts.push(e.def_en);
    if (e.example_en) texts.push(e.example_en);
    for (const s of [...(e.synonyms ?? []), ...(e.antonyms ?? []), ...(e.collocations ?? [])]) texts.push(s);
  }
  for (const t of texts) for (const m of t.match(/[a-zA-Z][a-zA-Z'-]*/g) ?? []) push(m);
  return out;
}

// ---------- API（SSE 流式） ----------
// 契约要点（探测确认）：网关不支持非流式（返回空 body），必须
// stream:true + Accept:text/event-stream；SSE 中推理文本在
// reasoning_content、正文在 delta.content（推理阶段为 null），
// 只累加非空 delta.content。
const SYSTEM_PROMPT = `你是英语词典编纂助手。为给定的英语单词生成一个学习型词条，严格输出 YAML，不要输出任何多余文字。

硬性规则：
1. 直接输出 YAML 正文，不加 \`\`\`yaml 围栏、不加 --- 文档头、不加说明文字。
2. 所有集合一律 block 风格（- item 每条一行），禁止 flow 风格（[a, b] / {a: b}）。
3. 一条 entry 只有一个义项，至多一个例句；例句必须 example_en / example_zh 成对。
4. 没有把握的字段就整体省略该键，不输出 null、不输出空字符串。
5. 义项按常用度降序排列。
6. 主音标（phonetic_uk/phonetic_us）填最常见读音，尽量必填；变形尽量列全（尤其不规则动词/复数），若不同义项的变形不同（如 lie 躺→lay / 说谎→lied），inflections 每项用 sense 字段标明归属义项序号，无法归属的省略 sense。特殊/次要读音、同形词多读音等零碎说明写进顶层 other_notes（block scalar），例如：tear 有 /tɪər/（眼泪）与 /teər/（撕裂）两个读音。
7. 词性用全称：noun, verb, adjective, adverb, preposition, conjunction, pronoun, interjection, article, phrase, idiom。
8. 若该词有常用短语或习语（如 run → run into、run out of；look → look forward to；clear → clear up），必须输出为 idiom / phrase 义项，每个带 pattern 字段（base form + sb./sth. 占位），不单独成词。
9. 顶层输出 cefr 字段（A1/A2/B1/B2/C1/C2），大概估计即可（用于遍历优先级），不确定可省略。

输出结构（entries 是列表，一条 = 一个词性 + 一个义项）：

word: <目标单词原样>
cefr: A1                 # 可选，大概估计
phonetic_uk: /音标/      # 主音标（最常见读音），尽量必填
phonetic_us: /音标/      # 主音标
other_notes: |           # 可选，零碎说明（特殊发音/多读音等）
  特殊说明
entries:
  - pos: verb
    def_en: 英文释义（简洁单句）
    def_zh: 中文释义
    example_en: 例句       # 可选，与 example_zh 成对
    example_zh: 例句翻译
    synonyms:             # 可选
      - sprint
    antonyms:             # 可选
      - walk
    collocations:         # 可选
      - run a marathon
    register: informal    # 可选
    usage_notes: |        # 可选，多行说明
      用法要点
inflections:             # 可选，放在 entries 之后（便于用 sense 引用刚写过的义项序号）
  - form: past           # plural / third_person_singular / present_participle / past / past_participle / comparative / superlative
    value: lay
    sense: 1             # 可选，归属义项序号；不同义项变形不同时必须标明`;

async function readSse(res: Response): Promise<string> {
  if (!res.body) throw new Error("无响应体");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") return content;
      try {
        const chunk = JSON.parse(payload);
        const delta = chunk.choices?.[0]?.delta;
        if (typeof delta?.content === "string") content += delta.content;
        if (chunk.choices?.[0]?.finish_reason === "stop") return content;
      } catch {
        /* 跳过无法解析的行 */
      }
    }
  }
  return content;
}

async function callModel(word: string, feedback: { role: string; content: string }[] = []): Promise<string> {
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: `目标单词：${word}` },
    ...feedback,
  ];
  // 网络错误退避重试：429 用 5/10/20/40s 长退避（最多 4 次重试），
  // 普通传输错误（超时/空响应/Malformed）用 3/6/9s；校验类失败由 processWord 处理
  let attempt = 0;
  for (;;) {
    try {
      const res = await fetch(API_ENTRY, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${API_TOKEN}`,
          accept: "text/event-stream",
        },
        // max_tokens 只是输出上限：词条 YAML 实际只消耗几百到一两千 token，
        // 设大（200k）防义项多/用法说明长的词条被截断；若网关对超长上限
        // 报错，回落为 8192 即可
        body: JSON.stringify({ model: MODEL, messages, max_tokens: 200000, temperature: 0.3, stream: true }),
        signal: AbortSignal.timeout(120000),
      });
      if (res.status === 429) {
        rateLimit429++;
        throw new Error("HTTP 429 限流");
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const content = await readSse(res);
      if (content.trim() === "") throw new Error("空响应");
      return content;
    } catch (e) {
      if (++attempt >= 5) throw e;
      const is429 = String(e).includes("429");
      // 普通错误退避加随机抖动，避免 10 个 worker 同步重试造成二次风暴
      const wait = is429 ? [5000, 10000, 20000, 40000][attempt - 1] : 3000 * attempt + Math.floor(Math.random() * 2000);
      console.log(`  ⚠ ${word} 重试 ${attempt}/4${is429 ? " (429限流)" : ""}: ${e}`);
      await Bun.sleep(wait);
    }
  }
}

// 单个词的处理：生成 → 校验 → 失败回喂重试（≤2 次）→ 入库 + 落盘 + BFS 扩展
async function processWord(word: string, parentLevel: string) {
  processed++;
  let feedback: { role: string; content: string }[] = [];
  let lastRaw = "";
  for (let retry = 0; retry <= 2; retry++) {
    try {
      lastRaw = await callModel(word, feedback);
    } catch (e) {
      failures++;
      console.log(`  ✗ ${word} API 错误: ${e}`);
      return;
    }
    const p = parseYaml(lastRaw);
    if (!p.ok) {
      // 解析失败：把报错回喂，要求重新输出完整 YAML
      feedback = [...feedback,
        { role: "assistant", content: lastRaw },
        { role: "user", content: `YAML 解析失败：${p.error}\n请修正后重新输出完整 YAML。` },
      ];
      continue;
    }
    const r = validate(word + ".yaml", p.doc);
    if (r.errors.length === 0) {
      // YAML 落盘默认关（万级词条 IO 浪费），调试时 --yaml 打开；
      // 原始输出改存 words.raw_yaml（DB 内），审计/回放不丢数据
      if (saveYaml) writeFileSync(join(WORDS_DIR, word + ".yaml"), lastRaw.trimEnd() + "\n");
      // ingest 包 try/catch：SQLite 并发写锁竞争时 SQLITE_BUSY 不能崩 worker
      try {
        ingest(db, r.data, r.word, r.variant, MODEL, cefrMap.get(r.word.toLowerCase()), lastRaw);
      } catch (e) {
        failures++;
        console.log(`  ✗ ${word} DB 写入失败: ${e}`);
        return;
      }
      // 子词回退等级：父词生成值 → 桶等级；权威词表命中时 enqueue 内自动纠正
      const childLevel = r.data.cefr ?? parentLevel ?? "unknown";
      for (const w of extractWords(r.data)) enqueue(w, childLevel);
      // 规则层配套：补全该词缺失的词表变形（零 API 成本）
      completeInflections(r.word.toLowerCase());
      // 每词成功日志在万级规模下过吵，已注释；进度看心跳即可
      // console.log(`  ✓ ${word} (cefr=${r.data.cefr ?? "?"}) ${r.data.entries.length} senses`);
      return;
    }
    feedback = [...feedback,
      { role: "assistant", content: lastRaw },
      { role: "user", content: `校验失败：\n${r.errors.join("\n")}\n请修正后重新输出完整 YAML。` },
    ];
  }
  failures++;
  writeFileSync(join(FAIL_DIR, word + ".yaml"), lastRaw + "\n");
  console.log(`  ✗ ${word}: 2 次重试后仍失败（原始输出已存 failed/${word}.yaml）`);
}

// ---------- 主循环 ----------
if (fresh || !existsSync(STATE_PATH)) {
  if (seedCefr) {
    // 按权威词表全量入队指定等级（仅收纯字母词）；无词表时无效
    if (cefrMap.size === 0) {
      console.error(`--seed-cefr 需要权威词表（未找到 ${CEFR_DB}）`);
    } else {
      let n = 0;
      for (const [w, entry] of cefrMap) {
        if (entry.level !== seedCefr || !/^[a-z'-]+$/.test(w)) continue;
        enqueue(w, entry.level);
        n++;
      }
      console.log(`按权威词表入队 ${seedCefr}：${n} 词`);
    }
  }
  for (const s of seeds) enqueue(s, "A1"); // 种子词回退 A1，词表命中时自动纠正
} else {
  loadState();
}

console.log(`模型=${MODEL} 并发=${concurrency} 处理上限=${maxWords} CEFR关卡=${argMaxCefr ?? "∞"} 自洽补采=${autoAudit ? "开" : "关"} 权威词表=${cefrMap.size ? cefrMap.size + " 词" : "未加载"}`);
const t0 = Date.now();
let inFlight = 0;
let done = false;
let lastHeartbeatAt = 0;
heartbeat(null, t0);

function totalQueued(): number {
  return LEVEL_ORDER.reduce((n, l) => n + buckets[l].length, 0);
}

// worker 池：每词独立拉取处理，单词重试（429/空响应）只拖累自己，
// 不阻塞其他词——避免 batch 等待最慢词导致的高并发下吞吐反而下降
async function worker() {
  for (;;) {
    if (done || processed >= maxWords) return;
    const level = nextLevel();
    const word = level === null ? undefined : buckets[level].shift();
    if (word === undefined) {
      await Bun.sleep(500); // 队列瞬时为空：等 BFS 子词或监督循环补采
      continue;
    }
    inFlight++;
    try {
      await processWord(word, level);
    } finally {
      inFlight--;
      saveState(); // 每词落盘，防中途被杀丢进度
      if (Date.now() - lastHeartbeatAt > 10000) {
        lastHeartbeatAt = Date.now();
        heartbeat(level, t0);
      }
    }
  }
}

const workers = Array.from({ length: concurrency }, () => worker());

// 监督循环：队列耗尽且无在途时触发自洽补采；闭环后收尾；无进度超时告警
let lastSeenProcessed = processed;
let lastProgressAt = Date.now();
for (;;) {
  await Bun.sleep(2000);
  if (processed >= maxWords) break;
  // AI 批量过滤：挂起词攒够一批就过滤（拒绝入黑名单，幸存入 unknown 桶）
  if (suspects.length >= FILTER_BATCH) await runFilterBatch();
  if (totalQueued() === 0 && inFlight === 0) {
    if (argMaxCefr !== undefined || !autoAudit) break;
    const gaps = findUncovered(db);
    let added = 0;
    for (const w of gaps) {
      if (visited.has(w)) continue;
      enqueue(w, "unknown");
      added++;
    }
    console.log(`[自洽补采] 缺口 ${gaps.length} 词，入队 ${added} 词`);
    if (added === 0) break; // 真正闭环：缺口全部可查
    saveState();
  }
  // 无进度告警：5 分钟零进展多半是网关全在重试，输出给监控看（不干预）
  if (processed !== lastSeenProcessed) {
    lastSeenProcessed = processed;
    lastProgressAt = Date.now();
  } else if (Date.now() - lastProgressAt > 300000) {
    console.log(`[警告] ${((Date.now() - lastProgressAt) / 60000).toFixed(1)} 分钟无进度，仍在等待重试`);
    lastProgressAt = Date.now(); // 每 5 分钟只报一次
  }
}
done = true;
if (suspects.length > 0) await runFilterBatch(); // 收尾：清空挂起词，不丢词
saveState();
while (inFlight > 0) await Bun.sleep(1000);
await Promise.all(workers);

db.close();
console.log(`完成：处理 ${processed} 词（失败 ${failures}，429 共 ${rateLimit429}），耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
const remain = LEVEL_ORDER.filter((l) => buckets[l].length > 0).map((l) => `${l}:${buckets[l].length}`).join("  ");
console.log(`剩余队列：${remain || "空"}（断点 ${STATE_PATH}；自洽缺口审计：bun run src/audit.ts）`);

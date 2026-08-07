// ============================================================
// 词典采集器（collect.ts）
//
// 职责：调用 AI 按词条 schema（见 docs/ai-dictionary-schema.md）生成
//       词典词条，BFS 广度遍历扩展词表，校验通过后入库
//       data/dict.db 并落盘 YAML（data/words/）。
//
// 遍历策略（CEFR 优先级）：
//   队列按等级分桶 A1 < A2 < B1 < B2 < C1 < C2 < unknown，
//   每次取最低非空桶的一批词并发处理。
//   新词在生成前等级未知（生成后才输出 CEFR），因此入队时继承
//   父词生成的 CEFR 作为临时等级——A1 词的近邻词大多也常用，
//   粗略但满足"常用词优先"的目标。
//   --max-cefr 关卡：超过目标等级即停止（CEFR 缺失的 unknown 桶
//   同样被挡住），避免遍历陷入生僻冷门词打转。
//
// 可靠性：
//   - 校验失败把报错回喂模型重试（≤2 次），最终失败输出存 data/failed/
//   - state.json 断点续跑；--fresh 清空重来
//   - 并发可调：--limit N / COLLECT_CONCURRENCY（默认 5，网关限 5）
//
// 用法：
//   bun run src/collect.ts                          # 默认 10 词
//   bun run src/collect.ts --max 5000 --limit 5 --max-cefr B2
//   bun run src/collect.ts --fresh                  # 清空数据重新开始
// ============================================================
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { createDb, ingest, parseYaml, validate } from "./schema.ts";
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

// ---------- CLI / 环境配置 ----------
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const maxWords = parseInt(arg("max") ?? env.COLLECT_MAX_WORDS ?? "10", 10);
const concurrency = parseInt(arg("limit") ?? env.COLLECT_CONCURRENCY ?? "5", 10);
const seeds = (arg("seed") ?? DEFAULT_SEEDS.join(" ")).split(/\s+/).filter(Boolean).map((s) => s.toLowerCase());
const fresh = process.argv.includes("--fresh");

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

// ---------- BFS 状态：按 CEFR 分桶的队列 ----------
// visited 防重复入队；processed 计已处理词数（失败也计，防死循环）
const buckets: Record<string, string[]> = Object.fromEntries(LEVEL_ORDER.map((l) => [l, []]));
const visited = new Set<string>();
let processed = 0;
let failures = 0;

// 进度心跳：每批输出一行进度并原子落盘 progress.json（外部监控 tail/jq 均可用）
function heartbeat(level: string | null, t0: number) {
  const elapsed = (Date.now() - t0) / 1000;
  const speed = processed / Math.max(elapsed, 1);
  const eta = maxWords > processed ? (maxWords - processed) / speed : 0;
  const queueStats = LEVEL_ORDER.filter((l) => buckets[l].length > 0).map((l) => `${l}:${buckets[l].length}`).join(" ");
  console.log(`[进度] ${processed}/${maxWords} 词 失败=${failures} ${speed.toFixed(2)}词/s ETA=${(eta / 60).toFixed(1)}min 等级=${level ?? "-"} 队列[${queueStats || "空"}]`);
  writeFileSync(PROGRESS_PATH, JSON.stringify({
    processed, maxWords, failures, level,
    elapsedSec: Math.round(elapsed), etaSec: Math.round(eta),
    buckets, at: new Date().toISOString(),
  }, null, 2));
}

function enqueue(word: string, level: string) {
  const w = word.toLowerCase();
  if (visited.has(w)) return;
  if (w.length < 2 && !["a", "i"].includes(w)) return;
  visited.add(w);
  buckets[LEVEL_RANK[level] === undefined ? "unknown" : level].push(w);
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
  writeFileSync(STATE_PATH, JSON.stringify({ buckets, visited: [...visited], processed }, null, 2));
}
function loadState() {
  // 注意：断点恢复时桶里的词直接取回即可，visited 只是去重集合，
  // 不能再用 visited 过滤（否则队列会被整个滤空）。
  const s = JSON.parse(readFileSync(STATE_PATH, "utf8"));
  for (const w of s.visited) visited.add(w);
  for (const l of LEVEL_ORDER) buckets[l].push(...(s.buckets?.[l] ?? []));
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
6. 音标、变形不确定时宁缺勿编，尤其不要编造词源。
7. 词性用全称：noun, verb, adjective, adverb, preposition, conjunction, pronoun, interjection, article, phrase, idiom。
8. 若该词有常用短语或习语（如 run → run into、run out of；look → look forward to；clear → clear up），必须输出为 idiom / phrase 义项，每个带 pattern 字段（base form + sb./sth. 占位），不单独成词。
9. 顶层输出 cefr 字段（A1/A2/B1/B2/C1/C2），大概估计即可（用于遍历优先级），不确定可省略。

输出结构（entries 是列表，一条 = 一个词性 + 一个义项）：

word: <目标单词原样>
cefr: A1                 # 可选，大概估计
phonetic_uk: /音标/      # 可选
phonetic_us: /音标/      # 可选
inflections:             # 可选，词级变形
  - form: past           # plural / third_person_singular / present_participle / past / past_participle / comparative / superlative
    value: ran
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
      用法要点`;

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
  // 网络抖动/HTTP 错误退避重试（≤3 次）；校验类失败由 processWord 处理
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
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const content = await readSse(res);
      if (content.trim() === "") throw new Error("空响应");
      return content;
    } catch (e) {
      if (++attempt >= 3) throw e;
      console.log(`  ⚠ ${word} 传输重试 ${attempt}/3: ${e}`);
      await Bun.sleep(3000 * attempt);
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
      writeFileSync(join(WORDS_DIR, word + ".yaml"), lastRaw.trimEnd() + "\n");
      ingest(db, r.data, r.word, r.variant, MODEL);
      // 子词继承父词的 CEFR 作为临时等级（父词没给则继承桶等级）
      const childLevel = r.data.cefr ?? parentLevel ?? "unknown";
      for (const w of extractWords(r.data)) enqueue(w, childLevel);
      const terms = db.query("SELECT COUNT(*) c FROM terms t JOIN words w ON w.id=t.word_id WHERE w.lemma=?").get(r.word) as any;
      console.log(`  ✓ ${word} (cefr=${r.data.cefr ?? "?"}) ${r.data.entries.length} senses, ${terms.c} terms`);
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
  for (const s of seeds) enqueue(s, "A1"); // 种子词按 A1 处理（都是简单常用词）
} else {
  loadState();
}

console.log(`模型=${MODEL} 并发=${concurrency} 处理上限=${maxWords} CEFR关卡=${argMaxCefr ?? "∞"}`);
const t0 = Date.now();
heartbeat(null, t0);

while (processed < maxWords) {
  const level = nextLevel();
  if (level === null) break; // 队列耗尽或达到 CEFR 关卡
  // 批次大小受剩余预算约束，否则 --max 会被一批打穿
  const batch = buckets[level].splice(0, Math.min(concurrency, maxWords - processed));
  await Promise.all(batch.map((w) => processWord(w, level)));
  saveState();
  heartbeat(level, t0);
}

db.close();
console.log(`完成：处理 ${processed} 词（失败 ${failures}），耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
const remain = LEVEL_ORDER.filter((l) => buckets[l].length > 0).map((l) => `${l}:${buckets[l].length}`).join("  ");
console.log(`剩余队列：${remain || "空"}（断点 ${STATE_PATH}；自洽缺口审计：bun run src/audit.ts）`);

// ============================================================
// 清洗 Step 2：AI 多分类复核（clean_ai.ts）
//
// 只读 clean_tags.json，对 ambiguous 词（outside / hyphen_outside /
// short_abbr，约 1.3 万）做多分类，产出 data/clean_ai.json。
//
// 标签（docs/data-cleaning-plan.md §二）：
//   keep            英语真词（含归化借词 taco/sushi、常用缩写 ok/tv/dvd）
//   foreign_common  常见外源词（gracias/amigo/ramen/despacito，学习者会查）
//   foreign_rare    纯外语长尾（abandonar/abbiamo/abierto，西/意/法变位生僻词）
//   name            人名/地名/品牌/乐队/专辑/作品
//   abbr            缩写/首字母词（fbi/adhd/atm）
//   coined          临时组合/派生（two-for-one/electron-withdrawing）
//   misspelling     拼写错误
//
// 对抗 yes-man：按类别分批（不与好词混批）；多分类强制选标签；
// 断点续跑（live 落盘 data/clean_ai.json.live，重跑跳过已判词）。
//
// 用法：bun run src/clean_ai.ts [--limit N]   # --limit 限制每类处理词数（试跑）
// ============================================================
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadEnv } from "./env.ts";

const DIR = import.meta.dir;
const DATA_DIR = process.env.COLLECT_DATA_DIR ?? join(DIR, "..", "data");
const TAGS_PATH = join(DATA_DIR, "clean_tags.json");
const OUT_PATH = join(DATA_DIR, "clean_ai.json");
const LIVE_PATH = join(DATA_DIR, "clean_ai.live.json");

const env = loadEnv();
const API_ENTRY = env.API_ENTRY, API_TOKEN = env.API_TOKEN;
const MODEL = env.API_MODEL ?? env.COLLECT_MODEL ?? "deepseek-v4-flash";
if (!API_ENTRY || !API_TOKEN) {
  console.error("缺少 API_ENTRY / API_TOKEN（检查 .env.dev）");
  process.exit(1);
}

const CLASSIFY_PROMPT = `你是英语词典编纂助手，同时熟悉当代英语环境（美国流行文化、多语言现实）。下面是候选词列表，请对每个词选一个唯一标签：

keep - 正常的英语词，或已被英语吸收的常用词（cafe、sushi、taco、ok、tv、dvd）
foreign_common - 非英语但当代英语环境真实常见、学习者会查的词（gracias、amigo、bratwurst、ramen、despacito、bonjour）
foreign_rare - 纯外语生僻词/变位（abandonar、abbiamo、abierto 这类西/意/法语的变位或生僻词）
name - 人名、地名、品牌、乐队、专辑、作品名（mozart、saratoga、metallica、iphone）
abbr - 缩写/首字母词（fbi、adhd、atm、ibm）
coined - 临时合成/派生词（two-for-one、electron-withdrawing、about-faced）
misspelling - 拼写错误

输出格式：每行 \`词|标签\`（标签必须是上面 7 个之一），只输出这些行，不要任何其它内容。`;

const LABELS = ["keep", "foreign_common", "foreign_rare", "name", "abbr", "coined", "misspelling"];

async function readSse(res: Response): Promise<string> {
  if (!res.body) throw new Error("无响应体");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "", content = "";
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
      } catch { /* 跳过无法解析的行 */ }
    }
  }
  return content;
}

async function classifyBatch(words: string[]): Promise<Map<string, string>> {
  const res = await fetch(API_ENTRY, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${API_TOKEN}`, accept: "text/event-stream" },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: CLASSIFY_PROMPT },
        { role: "user", content: words.join("\n") },
      ],
      max_tokens: 20000,
      temperature: 0,
      stream: true,
    }),
    signal: AbortSignal.timeout(180000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const content = await readSse(res);
  const out = new Map<string, string>();
  for (const line of content.split("\n")) {
    const m = line.trim().match(/^([a-z'-]+)\|([a-z_]+)$/i);
    if (m && LABELS.includes(m[2].toLowerCase())) out.set(m[1].toLowerCase(), m[2].toLowerCase());
  }
  return out;
}

// ---------- 读分类清单 ----------
if (!existsSync(TAGS_PATH)) throw new Error(`找不到 ${TAGS_PATH}（先跑 clean_classify.ts）`);
const tags: Record<string, { tag: string }> = JSON.parse(readFileSync(TAGS_PATH, "utf8")).tags;
const ambiguous = Object.entries(tags)
  .filter(([, t]) => ["outside", "hyphen_outside", "short_abbr"].includes(t.tag))
  .map(([w]) => w);

// 断点：已判词加载
const results = new Map<string, string>();
if (existsSync(LIVE_PATH)) {
  for (const [w, label] of Object.entries(JSON.parse(readFileSync(LIVE_PATH, "utf8")))) results.set(w, String(label));
}
let pending = ambiguous.filter((w) => !results.has(w));
console.log(`ambiguous 共 ${ambiguous.length}，已完成 ${results.size}，待处理 ${pending.length}`);

const limitIdx = process.argv.indexOf("--limit");
const limit = limitIdx >= 0 ? parseInt(process.argv[limitIdx + 1], 10) : Infinity;
if (pending.length > limit) {
  console.log(`--limit ${limit}: 本轮只处理前 ${limit} 词（按字母序）`);
  pending = pending.slice(0, limit);
}

// ---------- 分批并发 ----------
// free 模型输出慢：40 词/批不易截断超时；断点存档每 ~200 词落一次
const BATCH = 40, CONC = 3;
const BATCHES: string[][] = [];
for (let i = 0; i < pending.length; i += BATCH) BATCHES.push(pending.slice(i, i + BATCH));

let done = 0, failedBatches = 0;
// 断点存档只存已分类词（unclassified 不写，确保重跑会重试失败词）
const saveLive = () => {
  const clean: Record<string, string> = {};
  for (const [w, l] of results) if (l !== "unclassified") clean[w] = l;
  return Bun.write(LIVE_PATH, JSON.stringify(clean, null, 2));
};

async function worker() {
  for (;;) {
    const batch = BATCHES.shift();
    if (!batch) return;
    try {
      const labels = await classifyBatch(batch);
      for (const w of batch) {
        if (labels.has(w)) results.set(w, labels.get(w)!);
        else results.set(w, "unclassified");
      }
    } catch (e) {
      failedBatches++;
      console.log(`  ⚠ 批失败（${batch[0]}…）：${e}`);
      for (const w of batch) results.set(w, "unclassified"); // 留待重跑（unclassified 不入 live）
      continue;
    }
    done += batch.length;
    if (done % 200 < BATCH * CONC) await saveLive(); // 每 ~200 词落一次断点
    console.log(`[进度] ${done}/${pending.length} 批失败 ${failedBatches}`);
  }
}
await Promise.all(Array.from({ length: CONC }, () => worker()));
await saveLive();

// ---------- 汇总 ----------
const stat: Record<string, number> = {};
for (const [, label] of results) stat[label] = (stat[label] ?? 0) + 1;
console.log("\n=== AI 分类统计 ===");
for (const [label, n] of Object.entries(stat).sort((a, b) => b[1] - a[1])) console.log(`  ${label.padEnd(16)} ${n}`);
const unclassified = [...results.entries()].filter(([, l]) => l === "unclassified");
console.log(`\nunclassified（需重跑或人工）: ${unclassified.length}`);

// 合并写最终结果：live 全部 + 本轮
const final: Record<string, string> = {};
for (const [w, l] of results) if (l !== "unclassified") final[w] = l;
await Bun.write(OUT_PATH, JSON.stringify(final, null, 2));
console.log(`结果已写 ${OUT_PATH}`);
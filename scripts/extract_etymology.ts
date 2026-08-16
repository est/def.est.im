// ============================================================
// 词源抽取（extract_etymology.ts）
//
// other_notes 里已混有模型写的词源/趣闻（"源自拉丁语 abstemius…"），
// 抽到独立 words.etymology，与用法说明分离。
// 判定：句子同时含【词源信号词】+【语言/古典来源词】。
//
// 用法：
//   bun run scripts/extract_etymology.ts          # dry-run（统计+样例）
//   bun run scripts/extract_etymology.ts --apply  # 写入 dict_clean.db words.etymology
// ============================================================
import { join } from "node:path";
import { Database } from "bun:sqlite";

const DIR = import.meta.dir;
const DATA_DIR = process.env.COLLECT_DATA_DIR ?? join(DIR, "..", "data");
const DST_DB = join(DATA_DIR, "dict_clean.db");
const APPLY = process.argv.includes("--apply");

const db = new Database(DST_DB);

// 词源判定：来源动词【紧邻】语言词（"源自拉丁语…"），
// 防误报（"拉丁语法术语"无来源动词 → 不抽）
const CLOSE_RE = /(源自|借自|出自|源于|来源|来自|同源|同根|词源自|词来自)(拉丁语|拉丁|希腊语|古希腊语|法语|德语|西班牙语|意大利语|葡萄牙语|俄语|梵语|希伯来语|阿拉伯语|日语|古英语|中古英语|古法语|古挪威语|古诺曼语|孟加拉语|印地语|波斯语|土耳其语|罗马|日耳曼)/;

let hit = 0;
if (APPLY) {
  const has = (db.query("PRAGMA table_info(words)").all() as any[]).some((c) => c.name === "etymology");
  if (!has) db.run("ALTER TABLE words ADD COLUMN etymology TEXT");
}
const samples: string[] = [];
for (const w of db.query("SELECT id, lemma, other_notes FROM words WHERE other_notes IS NOT NULL AND other_notes<>''").all() as any[]) {
  const text = String(w.other_notes);
  // 分句：中文句号/换行
  const sentences = text.split(/(?<=[。！？]\s*|\n)/).map((s) => s.trim()).filter(Boolean);
  const et = sentences.find((s) => CLOSE_RE.test(s));
  if (!et) continue;
  hit++;
  if (!APPLY) {
    if (samples.length < 14) samples.push(`${w.lemma} ⇒ ${et.slice(0, 70)}`);
  } else {
    db.query("UPDATE words SET etymology=? WHERE id=?").run(et, w.id);
  }
}

console.log(`other_notes 非空 ${(db.query("SELECT COUNT(*) c FROM words WHERE other_notes IS NOT NULL AND other_notes<>''").get() as any).c}`);
console.log(`hits 命中词源句: ${hit}`);
if (!APPLY) {
  console.log("\n样例:");
  for (const s of samples) console.log("  " + s);
  console.log("\ndry-run（加 --apply 写入 dict_clean.db）");
} else {
  console.log("已写入 words.etymology");
}
db.close();
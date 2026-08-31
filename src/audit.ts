// ============================================================
// 自洽审计（audit.ts）
//
// 目标：词典 closure —— 词条（释义/例句/同反义/搭配/pattern）里出现的
//       每个英文词都应当可查。缺口列表来自 src/closure.ts 的 findUncovered
//       （直接扫数据库，不依赖 YAML 文件）。
//
// 用法：
//   bun run src/audit.ts             # 只报告缺口
//   bun run src/audit.ts --enqueue   # 把缺口词写回 state.json 队列（unknown 桶）
//
// 配合采集器形成闭环：跑一批 → audit --enqueue → 再跑 → … 直到缺口为零。
// （采集器加 --auto-audit 可无人值守自动执行这一闭环）
// ============================================================
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { createDb } from "./schema.ts";
import { findUncovered } from "./closure.ts";

const DIR = import.meta.dir;
const DATA_DIR = process.env.COLLECT_DATA_DIR ?? join(DIR, "..", "data");
const STATE_PATH = join(DATA_DIR, "state.json");
const db = createDb(new Database(join(DATA_DIR, "dict.db")));

const gaps = findUncovered(db);
const coveredCount = (db.query("SELECT COUNT(DISTINCT lower(surface)) c FROM terms").get() as any).c;
console.log(`已可查词数：${coveredCount}，自洽缺口：${gaps.length}`);
console.log(`缺口示例（前 80）：${gaps.slice(0, 80).join(", ")}`);

if (process.argv.includes("--enqueue")) {
  // 保留现有队列/断点，把缺口词加入 unknown 桶（等级未知，放末位由优先级自然处理）
  const state = existsSync(STATE_PATH) ? JSON.parse(readFileSync(STATE_PATH, "utf8")) : { processed: 0 };
  const buckets: Record<string, string[]> = { A1: [], A2: [], B1: [], B2: [], C1: [], C2: [], unknown: [] };
  for (const k of Object.keys(buckets)) buckets[k] = state.buckets?.[k] ?? [];
  const visited = new Set<string>(state.visited ?? []);
  let added = 0;
  for (const w of gaps) {
    if (visited.has(w)) continue;
    visited.add(w);
    buckets.unknown.push(w);
    added++;
  }
  writeFileSync(STATE_PATH, JSON.stringify({ buckets, visited: [...visited], processed: state.processed ?? 0 }, null, 2));
  console.log(`已写回队列：${added} 词（unknown 桶），下次运行自动补齐`);
}
db.close();

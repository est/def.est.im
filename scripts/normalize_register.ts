// ============================================================
// register 规范化（scripts/normalize_register.ts）
//
// 现状：register 自由文本，367 个取值（组合值 formal/technical、
// 变体 dated/dialectal、领域词 business/computing、噪声 common 等）。
// 目标：收敛到展示层 REGISTER_CN 白名单 19 值 + 少量保留值
// （美英标记 US/UK、euphemistic、polite、figurative）。
//
// 映射优先级：精确表 → 变体表 → 组合拆分(取主标签) → 领域归 technical → 噪声置 NULL
// 用法：bun run scripts/normalize_register.ts [--dry-run]
// ============================================================
import { join } from "node:path";
import { Database } from "bun:sqlite";

const DIR = import.meta.dir;
const DATA_DIR = process.env.COLLECT_DATA_DIR ?? join(DIR, "..", "data");
const DB_PATH = join(DATA_DIR, "dict_clean.db");
const DRY = process.argv.includes("--dry-run");
const db = new Database(DB_PATH);
db.run("PRAGMA busy_timeout = 5000");

// 受控词表（展示层 REGISTER_CN 白名单）
const STD = new Set(["formal", "informal", "neutral", "technical", "slang", "literary", "archaic",
  "vulgar", "offensive", "disapproving", "dialect", "medical", "old-fashioned", "humorous",
  "rare", "academic", "colloquial", "poetic", "historical"]);

// 精确映射表（变体/噪声 → 标准值或 NULL）
const MAP: Record<string, string | null> = {
  // 变体
  "dated": "old-fashioned", "old fashioned": "old-fashioned", "dialectal": "dialect", "regional": "dialect",
  "spoken": "informal", "everyday": "informal", "written": "literary", "nonstandard": "slang",
  "taboo": "vulgar", "derogatory": "disapproving", "pejorative": "disapproving", "obsolete": "archaic",
  "formal": "formal", "informal": "informal", "neutral": "neutral", "technical": "technical",
  // 领域词 → technical / medical
  "business": "technical", "computing": "technical", "finance": "technical", "financial": "technical",
  "legal": "technical", "law": "technical", "sports": "technical", "sport": "technical",
  "music": "technical", "religious": "technical", "nautical": "technical", "culinary": "technical",
  "cooking": "technical", "journalism": "technical", "journalistic": "technical", "biology": "technical",
  "scientific": "technical", "specialized": "technical", "specialist": "technical", "technical/medical": "technical",
  "accounting": "technical", "medicine": "medical", "education": "technical", "politics": "technical",
  "military": "technical", "mathematics": "technical", "botany": "technical", "psychology": "technical",
  "media": "technical", "professional": "technical",
  // 保留值（展示层显示英文原文，对学习者有价值）
  "euphemistic": "euphemistic", "polite": "polite", "figurative": "figurative", "idiomatic": "idiomatic",
  "approving": "approving",
  "us": "US", "american": "US", "american english": "US", "mainly us": "US", "chiefly us": "US",
  "uk": "UK", "british": "UK", "british english": "UK", "mainly uk": "UK", "mainly british": "UK", "chiefly british": "UK",
  "australian": "Australian", "canadian": "Canadian", "scottish": "Scottish", "indian english": "Indian English",
  "especially american english": "US", "especially us": "US", "especially british english": "UK", "especially uk": "UK",
  // 噪声（非 register）→ NULL
  "standard": null, "general": null, "common": null, "normal": null, "foreign": null,
  "foreign word": null, "proper noun": null, "abbreviation": null, "written abbreviation": null,
  "trademark": null, "saying": null, "informal written": null, "proverb": null, "idiom": null, "一般": null,
  "descriptive": null, "from spanish": null, "grammar": null, "usually capitalized": null, "literal": null,
  // 领域/其他补充
  "jargon": "technical", "official": "formal", "musical": "technical", "fashion": "technical", "retail": "technical",
};

// 组合拆分：先按分隔符取主标签；无分隔符时剥掉程度词前缀（sometimes/often/occasionally/slightly/rather/chiefly/mainly/now/usually + 空格）
const DEGREE = /^(sometimes|often|occasionally|slightly|rather|chiefly|mainly|now|usually|very|quite)\s+(.+)$/;
function splitMain(raw: string): string | null {
  const s = raw.toLowerCase().trim();
  for (const sep of ["/", ",", " or "]) {
    if (s.includes(sep)) {
      const first = s.split(sep)[0].trim();
      return first.replace(DEGREE, "$2") || null;
    }
  }
  const m = DEGREE.exec(s);
  if (m) return m[2];
  // "vulgar slang"/"offensive slang" → 取第一个词（vulgar/offensive 是主标签）
  const slangM = /^([a-z]+)\s+slang$/.exec(s);
  if (slangM && STD.has(slangM[1])) return slangM[1];
  return null;
}

// ---------- 执行 ----------
const rows = db.query("SELECT id, register FROM senses WHERE register IS NOT NULL").all() as any[];
const stat: Record<string, number> = { keep_std: 0, mapped: 0, split: 0, domain: 0, to_null: 0, unmapped: 0 };
const unmapped = new Map<string, number>();
const updates: { id: number; reg: string | null }[] = [];

for (const r of rows) {
  const raw = String(r.register).toLowerCase().trim();
  const base = raw.replace(/^["']|["']$/g, "");
  let target: string | null;
  if (STD.has(base)) { target = base; stat.keep_std++; }
  else if (base in MAP) { target = MAP[base]; stat[target === null ? "to_null" : "mapped"]++; }
  else {
    const m = splitMain(base);
    if (m && (STD.has(m) || m in MAP)) {
      target = m in MAP ? MAP[m] : m;
      stat[target === null ? "to_null" : "split"]++;
    } else if (m && !STD.has(m) && !(m in MAP)) {
      // 主标签仍是未知值：按领域/噪声再判一次
      target = null; // 保守：不猜，标记 unmapped
      stat.unmapped++;
      unmapped.set(base, (unmapped.get(base) ?? 0) + 1);
      continue;
    } else {
      target = null; stat.unmapped++; unmapped.set(base, (unmapped.get(base) ?? 0) + 1); continue;
    }
  }
  if (target !== r.register) updates.push({ id: r.id, reg: target });
}

console.log(`register 共 ${rows.length}，非标准 ${rows.length - stat.keep_std}`);
console.log("统计:", stat);
console.log(`将更新 ${updates.length} 行`);
if (unmapped.size) {
  console.log("\n=== 未映射取值（保守保留原文） ===");
  for (const [k, n] of [...unmapped.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30)) console.log(`  ${k} (${n})`);
}
if (!DRY && updates.length) {
  const upd = db.prepare("UPDATE senses SET register=? WHERE id=?");
  const tx = db.transaction(() => { for (const u of updates) upd.run(u.reg, u.id); });
  tx();
  console.log(`\n已写回 ${updates.length} 行`);
}
db.close();
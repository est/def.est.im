// 修复 inflection 空 label：规则+反查推断后写回数据库
// 用法: bun run scripts/fix_inflection_labels.ts [db路径]
// 推断优先级：同词同面已标 → 全库同面已标 → 后缀规则 → 兜底 null
import Database from 'bun:sqlite';

const DB = process.argv[2] ?? 'data/dict_clean.db';
const db = new Database(DB);
db.run('PRAGMA busy_timeout = 5000');

// 1. 全库 surface→label 统计（排除自身，多数票）
const labelVotes = new Map();
for (const r of db.query('SELECT surface, label FROM surfaces WHERE kind = ? AND label IS NOT NULL').all('inflection')) {
  const k = String(r.surface).toLowerCase();
  if (!labelVotes.has(k)) labelVotes.set(k, new Map());
  const m = labelVotes.get(k);
  m.set(r.label, (m.get(r.label) ?? 0) + 1);
}
const surfaceLabel = (s) => {
  const m = labelVotes.get(String(s).toLowerCase());
  if (!m) return null;
  return [...m.entries()].sort((a, b) => b[1] - a[1])[0][0];
};

// 2. 收集需修复的行（兼容 dict_clean.db 有 id / D1 复合主键两种 schema）
const cols = db.query('PRAGMA table_info(surfaces)').all().map((c) => c.name);
const hasId = cols.includes('id');
const rows = hasId
  ? db.query('SELECT id, surface, word_id FROM surfaces WHERE kind = ? AND label IS NULL').all('inflection')
  : db.query('SELECT surface, word_id, sense_id FROM surfaces WHERE kind = ? AND label IS NULL').all('inflection');
let fixed = 0, noInfer = 0;

const inferLabel = (surface, wordId) => {
  // ① 同词内其他 inflection 中同 surface 的已标 label
  const same = db.query(
    'SELECT label FROM surfaces WHERE word_id = ? AND kind = ? AND surface = ? AND label IS NOT NULL LIMIT 1'
  ).get(wordId, 'inflection', surface);
  if (same?.label) return same.label;
  // ② 全库同 surface 多数票
  const global = surfaceLabel(surface);
  if (global) return global;
  // ③ 后缀规则
  const s = String(surface).toLowerCase();
  if (/ing$/.test(s)) return 'present_participle';
  if (/ed$/.test(s)) return 'past';
  if (/s$/.test(s) && !/ss$/.test(s)) return 'plural';
  return null;
};

const update = db.transaction(() => {
  for (const r of rows) {
    const label = inferLabel(r.surface, r.word_id);
    if (label) {
      if (hasId) {
        db.query('UPDATE surfaces SET label = ? WHERE id = ?').run(label, r.id);
      } else {
        db.query('UPDATE surfaces SET label = ? WHERE surface = ? AND word_id = ? AND sense_id = ? AND kind = ?')
          .run(label, r.surface, r.word_id, r.sense_id, 'inflection');
      }
      fixed++;
    } else {
      noInfer++;
    }
  }
});
update();

console.log(`inflection 空 label 共 ${rows.length}: 修复 ${fixed}，无法推断 ${noInfer}`);
if (noInfer) {
  const left = db.query('SELECT surface FROM surfaces WHERE kind = ? AND label IS NULL LIMIT 30').all('inflection');
  console.log('剩余示例:', left.map((r) => r.surface).join(', '));
}
db.close();

// ============================================================
// 权威 CEFR 词表加载（data/word_cefr_minified.db）
//
// 结构：words(word_id, word, stem_word_id) × word_pos(word_id,
// pos_tag_id, lemma_word_id, frequency_count, level)。每个词×词性
// 一行，含独立的 CEFR 等级与语料词频。
//
// level：连续实数 1=A1 … 6=C2（X.0 确定档，X.5 相邻档边界），
//        可作精确排序优先级（比离散分桶更精细）。
// frequency_count：真实语料词频（稀有词统一为 10000 兜底）。
// 每词取：最低 level（学习者最友好）、最高 freq（最常用用法）。
//
// 用途：入队优先级（level 分桶 + score 桶内排序）、最终词条的
//       权威 cefr/cefr_score/freq 标注（AI 估计仅作回退）。
// ============================================================
import { Database } from "bun:sqlite";

const BUCKETS = ["A1", "A2", "B1", "B2", "C1", "C2"];

export type CefrEntry = { level: string; score: number; freq: number };

export function loadCefr(dbPath: string): Map<string, CefrEntry> {
  const db = new Database(dbPath, { readonly: true });
  const rows = db.query(`
    SELECT w.word AS word, MIN(p.level) AS lvl, MAX(p.frequency_count) AS freq
    FROM words w JOIN word_pos p ON p.word_id = w.word_id
    GROUP BY w.word_id
  `).all() as { word: string; lvl: number; freq: number }[];
  db.close();
  const map = new Map<string, CefrEntry>();
  for (const r of rows) {
    const idx = Math.min(5, Math.max(0, Math.floor(r.lvl) - 1));
    map.set(r.word.toLowerCase(), { level: BUCKETS[idx], score: r.lvl, freq: r.freq });
  }
  return map;
}

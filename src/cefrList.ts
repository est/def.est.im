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

// 家族词频汇总：lemma → 全族（含屈折形式）最高词频。
// 单个形式可能比原形更高频（encapsulated 1.9M > encapsulate 527k），
// 门槛判定/入库 freq 都应以家族 max 为准，避免高频形式被低频原形拖累。
export function loadFamilyFreq(dbPath: string): Map<string, number> {
  const db = new Database(dbPath, { readonly: true });
  const rows = db.query(`
    SELECT COALESCE(l.word, w.word) AS lemma, MAX(p.frequency_count) AS famfreq
    FROM word_pos p
    JOIN words w ON w.word_id = p.word_id
    LEFT JOIN words l ON l.word_id = p.lemma_word_id
    GROUP BY lemma
  `).all() as { lemma: string; famfreq: number }[];
  db.close();
  const map = new Map<string, number>();
  for (const r of rows) map.set(String(r.lemma).toLowerCase(), r.famfreq);
  return map;
}

// 词表 lemma 链接（规则层过滤用）：
//   lemmaOf  surface → 原形（meaner→mean、yanked→yank）：屈折形式归原
//   formsOf  lemma → 变形清单：入库时补全缺失变形，保证"形式→原形"检索闭环
export function loadLemmaLinks(dbPath: string): {
  lemmaOf: Map<string, string>;
  formsOf: Map<string, { surface: string; label: string }[]>;
} {
  const db = new Database(dbPath, { readonly: true });
  const TAG_TO_LABEL: Record<string, string> = {
    NNS: "plural", VBD: "past", VBG: "present_participle", VBZ: "third_person_singular",
    VBN: "past_participle", JJR: "comparative", JJS: "superlative", RBR: "comparative", RBS: "superlative",
  };
  const lemmaOf = new Map<string, string>();
  const formsOf = new Map<string, { surface: string; label: string }[]>();
  for (const r of db.query(`
    SELECT l.word AS lemma, w.word AS surface, t.tag AS tag
    FROM word_pos p
    JOIN words w ON w.word_id = p.word_id
    JOIN words l ON l.word_id = p.lemma_word_id
    JOIN pos_tags t ON t.tag_id = p.pos_tag_id
    WHERE p.lemma_word_id IS NOT NULL`).all() as any[]) {
    const lemma = String(r.lemma).toLowerCase();
    const surface = String(r.surface).toLowerCase();
    if (surface === lemma) continue;
    // 只采纳真屈折 tag（NNS/VBD/VBG/VBZ/VBN/JJR/JJS/RBR/RBS）的链接。
    // 词表存在噪声链（interest→inter 是 JJ 形容词，实为 inter- 前缀分析，
    // 会吞掉核心词）；只有屈折 tag 才建立"形式→原形"映射
    const label = TAG_TO_LABEL[r.tag];
    if (!label) continue;
    lemmaOf.set(surface, lemma);
    if (!formsOf.has(lemma)) formsOf.set(lemma, []);
    const arr = formsOf.get(lemma)!;
    if (!arr.some((f) => f.surface === surface && f.label === label)) arr.push({ surface, label });
  }
  db.close();
  return { lemmaOf, formsOf };
}

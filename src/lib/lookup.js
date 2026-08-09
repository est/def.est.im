// 查询组装：surface 命中 → 主词判定 → 数据组装（senses/surfaces 分组 + 可点词集合）
'use strict';
import { tokensOf } from './render.js';

async function loadEntry(env, word) {
  const d1 = env.def_dict;
  const low = word.toLowerCase();

  // 1. 表面命中（组合主键）
  const hits = await d1.prepare('SELECT word_id, kind FROM surfaces WHERE surface = ?').bind(low).all();
  const rows = hits.results || [];
  if (rows.length === 0) {
    const rej = await d1.prepare('SELECT 1 FROM rejects WHERE surface = ?').bind(low).first();
    return rej ? { type: 'rejected' } : { type: 'missing' };
  }
  // 主词判定：surface 恰为自己的 lemma 行（正主词）优先；
  // 无 lemma 行时：若该表面是某词条 phrase/idiom 义项的 pattern（run into → run），指向它；
  // 否则退到全候选（变形/同反义命中，如 ate→eat）
  const lemmaIds = rows.filter((r) => r.kind === 'lemma').map((r) => r.word_id);
  let ids;
  if (lemmaIds.length) {
    ids = [...new Set(lemmaIds)];
  } else {
    const pat = await d1.prepare("SELECT word_id FROM senses WHERE pos IN ('phrase','idiom') AND pattern = ?").bind(low).all();
    const patIds = (pat.results || []).map((r) => r.word_id);
    ids = [...new Set(patIds.length ? patIds : rows.map((r) => r.word_id))];
  }

  // 2. 主词排序：entity_type 0 优先 → freq 降序
  const metas = [];
  for (const id of ids) {
    const w = await d1.prepare('SELECT * FROM words WHERE word_id = ?').bind(id).first();
    if (w) metas.push(w);
  }
  metas.sort((a, b) => (a.entity_type === 0 ? 0 : 1) - (b.entity_type === 0 ? 0 : 1)
    || (b.freq ?? -1) - (a.freq ?? -1));
  const main = metas[0];
  if (!main) return { type: 'missing' };

  // 3. senses + surfaces 反查
  const sensesRes = await d1.prepare('SELECT * FROM senses WHERE word_id = ? ORDER BY sense_no').bind(main.word_id).all();
  const senses = sensesRes.results || [];
  const surfRes = await d1.prepare('SELECT surface, kind, sense_id, label FROM surfaces WHERE word_id = ?').bind(main.word_id).all();
  const groups = { inflection: [], synonym: [], antonym: [], collocation: [] };
  const allSurfaces = [];
  for (const s of surfRes.results || []) {
    if (groups[s.kind]) groups[s.kind].push({ surface: s.surface, sense_id: s.sense_id, label: s.label });
    if (s.kind !== 'lemma') allSurfaces.push(s.surface);
  }

  // 4. 可点词集合：def_en/example_en/pattern token + 关联表面自身（小批量 IN 查询）
  const tokens = new Set();
  for (const s of senses) {
    for (const t of tokensOf(s.def_en)) tokens.add(t);
    for (const t of tokensOf(s.example_en)) tokens.add(t);
    for (const t of tokensOf(s.pattern)) tokens.add(t);
  }
  for (const s of allSurfaces) for (const t of tokensOf(s)) tokens.add(t);
  const discoverable = new Set();
  const arr = [...tokens];
  for (let i = 0; i < arr.length; i += 100) { // D1 SQL 变量上限：IN 分批 ≤100
    const sliceArr = arr.slice(i, i + 100);
    const marks = sliceArr.map(() => '?').join(',');
    const res = await d1.prepare(`SELECT DISTINCT surface FROM surfaces WHERE surface IN (${marks})`).bind(...sliceArr).all();
    for (const r of res.results || []) discoverable.add(String(r.surface).toLowerCase());
  }

  return {
    type: 'entry',
    entry: {
      word_id: main.word_id,
      lemma: main.lemma,
      entity_type: main.entity_type,
      cefr: main.cefr,
      freq: main.freq,
      phonetic_uk: main.phonetic_uk,
      phonetic_us: main.phonetic_us,
      other_notes: main.other_notes,
      etymology: main.etymology,
    },
    senses: senses.map((s) => ({
      sense_no: s.sense_no, pos: s.pos, pattern: s.pattern,
      def_en: s.def_en, def_zh: s.def_zh,
      example_en: s.example_en, example_zh: s.example_zh,
      register: s.register, usage_notes: s.usage_notes,
    })),
    groups,
    discoverable,
  };
}

export { loadEntry };
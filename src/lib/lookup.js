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
    // collocation（搭配词组）：无 lemma、无 phrase/idiom pattern 匹配 → 跳转到主词条并高亮
    // 优先 inflection（变形）→ 否则取第一个候选
    if (!patIds.length && rows.length) {
      const infRow = rows.find((r) => r.kind === 'inflection');
      const targetId = infRow ? infRow.word_id : rows[0].word_id;
      const target = await d1.prepare('SELECT lemma FROM words WHERE word_id = ?').bind(targetId).first();
      if (target && target.lemma.toLowerCase() !== low) {
        return { type: 'redirect', lemma: target.lemma, highlight: word };
      }
    }
  }

  // 2. 主词排序：entity_type 0 优先 → freq 降序（批量 IN 查询，避免 N+1）
  let metas = [];
  if (ids.length) {
    const marks = ids.map(() => '?').join(',');
    const allWords = await d1.prepare(`SELECT * FROM words WHERE word_id IN (${marks})`).bind(...ids).all();
    metas = (allWords.results || []).filter(Boolean);
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

  // 3b. 双向链接：反查其他词条中以当前词为 synonym/antonym 的记录，翻转方向合并
  const reverseRows = await d1.prepare(
    "SELECT word_id, kind, sense_id FROM surfaces WHERE surface = ? AND kind IN ('synonym','antonym')"
  ).bind(main.lemma).all();
  const flipped = { synonym: 'synonym', antonym: 'antonym' };
  const reverseIds = [...new Set((reverseRows.results || []).map((r) => r.word_id))];
  const reverseMap = new Map();
  for (const r of reverseRows.results || []) {
    if (!reverseMap.has(r.word_id)) reverseMap.set(r.word_id, r);
  }
  if (reverseIds.length) {
    const wordRows = await d1.prepare(
      `SELECT word_id, lemma FROM words WHERE word_id IN (${reverseIds.map(() => '?').join(',')})`
    ).bind(...reverseIds).all();
    for (const w of wordRows.results || []) {
      const r = reverseMap.get(w.word_id);
      if (!r) continue;
      const revKind = flipped[r.kind];
      if (!revKind || !groups[revKind]) continue;
      if (w.lemma.toLowerCase() === low) continue;
      if (groups[revKind].some((g) => g.surface === w.lemma)) continue;
      groups[revKind].push({ surface: w.lemma, sense_id: r.sense_id, label: null });
    }
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
  // 多词 surface 也加入 discoverable（供短语链接判断）
  for (const s of allSurfaces) discoverable.add(s.toLowerCase());

  // 短语收录检查：phrase/idiom 的 pattern 是否在 surfaces 表中
  const phraseSenses = senses.filter((s) => s.pos === 'phrase' || s.pos === 'idiom');
  const phraseLinked = new Set();
  for (const s of phraseSenses) {
    const p = (s.pattern || '').toLowerCase()
      .replace(/\s*\(?\s*(?:from\s+)?(?:sb|sth)\.?(?:\/(?:sb|sth)\.?)?\s*\)?\s*/gi, ' ')
      .replace(/\s+/g, ' ').trim();
    if (p && !phraseLinked.has(p)) {
      const found = await d1.prepare('SELECT 1 FROM surfaces WHERE surface = ?').bind(p).first();
      if (found) phraseLinked.add(p);
    }
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
    phraseLinked,
  };
}

export { loadEntry };
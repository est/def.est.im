// 查询组装：surface 命中 → 主词判定 → 数据组装（senses/surfaces 分组 + 可点词集合）
'use strict';
import { tokensOf } from './render.js';
import { suggestCandidates } from './suggest.js';

// 拼写归一跳转：未命中时生成候选拼写，命中 surfaces 则 302（错误拼写不再触发 on-demand 烧 LLM）
async function suggestRedirect(d1, low) {
  const cands = suggestCandidates(low);
  if (!cands.length) return null;
  const marks = cands.map(() => '?').join(',');
  const hits = await d1.prepare(`SELECT DISTINCT surface FROM surfaces WHERE surface IN (${marks})`).bind(...cands).all();
  const hitSet = new Set((hits.results || []).map((r) => String(r.surface).toLowerCase()));
  // 按候选优先级（常见表 > 美英规则 > 换位）取第一个命中，不依赖查询返回顺序
  for (const c of cands) {
    if (hitSet.has(c)) return { lemma: c, highlight: low };
  }
  return null;
}

async function loadEntry(env, word) {
  const d1 = env.def_dict;
  const low = word.toLowerCase();

  // 1. 表面命中（组合主键）
  const hits = await d1.prepare('SELECT word_id, kind FROM surfaces WHERE surface = ?').bind(low).all();
  const rows = hits.results || [];
  if (rows.length === 0) {
    const rej = await d1.prepare('SELECT 1 FROM rejects WHERE surface = ?').bind(low).first();
    if (rej) return { type: 'rejected' };
    const cand = await suggestRedirect(d1, low);
    if (cand) return { type: 'redirect', lemma: cand.lemma, highlight: cand.highlight };
    return { type: 'missing' };
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

  // 2. 主词排序：entity_type 0 优先 → freq 降序（批量 IN 查询，避免 N+1；分批 ≤90 避开 D1 绑定变量上限）
  let metas = [];
  if (ids.length) {
    const chunk = 90;
    const batches = [];
    for (let i = 0; i < ids.length; i += chunk) {
      const slice = ids.slice(i, i + chunk);
      const marks = slice.map(() => '?').join(',');
      batches.push(d1.prepare(`SELECT * FROM words WHERE word_id IN (${marks})`).bind(...slice).all());
    }
    const results = await Promise.all(batches);
    metas = results.flatMap((r) => r.results || []).filter(Boolean);
  }
  metas.sort((a, b) => (a.entity_type === 0 ? 0 : 1) - (b.entity_type === 0 ? 0 : 1)
    || (b.freq ?? -1) - (a.freq ?? -1));
  const main = metas[0];
  if (!main) return { type: 'missing' };

  // 3. senses + surfaces + reverse 查询并行（三者均只依赖 main.word_id/main.lemma，无互相依赖）
  const [sensesRes, surfRes, reverseRows] = await Promise.all([
    d1.prepare('SELECT * FROM senses WHERE word_id = ? ORDER BY sense_no').bind(main.word_id).all(),
    d1.prepare('SELECT surface, kind, sense_id, label FROM surfaces WHERE word_id = ?').bind(main.word_id).all(),
    d1.prepare(
      "SELECT word_id, kind, sense_id FROM surfaces WHERE surface = ? AND kind IN ('synonym','antonym')"
    ).bind(main.lemma).all(),
  ]);
  const senses = sensesRes.results || [];
  const groups = { inflection: [], synonym: [], antonym: [], collocation: [] };
  const allSurfaces = [];
  for (const s of surfRes.results || []) {
    if (groups[s.kind]) groups[s.kind].push({ surface: s.surface, sense_id: s.sense_id, label: s.label });
    if (s.kind !== 'lemma') allSurfaces.push(s.surface);
  }
  const flipped = { synonym: 'synonym', antonym: 'antonym' };
  const reverseIds = [...new Set((reverseRows.results || []).map((r) => r.word_id))];
  const reverseMap = new Map();
  for (const r of reverseRows.results || []) {
    if (!reverseMap.has(r.word_id)) reverseMap.set(r.word_id, r);
  }
  if (reverseIds.length) {
    const chunk = 90;
    const wordBatches = [];
    for (let i = 0; i < reverseIds.length; i += chunk) {
      const slice = reverseIds.slice(i, i + chunk);
      const marks = slice.map(() => '?').join(',');
      wordBatches.push(d1.prepare(`SELECT word_id, lemma FROM words WHERE word_id IN (${marks})`).bind(...slice).all());
    }
    const wordResults = await Promise.all(wordBatches);
    const wordRowsAll = wordResults.flatMap((r) => r.results || []);
    for (const w of wordRowsAll) {
      const r = reverseMap.get(w.word_id);
      if (!r) continue;
      const revKind = flipped[r.kind];
      if (!revKind || !groups[revKind]) continue;
      if (w.lemma.toLowerCase() === low) continue;
      if (groups[revKind].some((g) => g.surface === w.lemma)) continue;
      groups[revKind].push({ surface: w.lemma, sense_id: r.sense_id, label: null });
    }
  }

  // 4. 可点词集合：def_en/example_en/pattern token + 关联表面自身
  // 停用词与长度过滤 + 截断至 40，避免长词条 80 token 全量扫 D1
  const STOPWORDS = new Set([
    'the','and','for','with','that','this','from','have','has','had','are','was','were','been','being',
    'will','would','could','should','might','must','shall','may','can','also','such','than','then','when',
    'where','which','while','about','into','through','after','before','under','over','again','further',
    'once','here','there','their','they','them','you','your','what','how','why','who','whom','a','an',
    'of','to','in','on','at','by','is','it','as','be','or','if','so','but','not','no','its','our','out','up',
    'we','he','she','my','me','his','her','our','are','was',
  ]);
  const tokens = new Set();
  for (const s of senses) {
    for (const t of tokensOf(s.def_en)) tokens.add(t);
    for (const t of tokensOf(s.example_en)) tokens.add(t);
    for (const t of tokensOf(s.pattern)) tokens.add(t);
  }
  for (const s of allSurfaces) for (const t of tokensOf(s)) tokens.add(t);
  let arr = [...tokens].filter((w) => w.length >= 3 && !STOPWORDS.has(w));
  if (arr.length > 40) arr = arr.slice(0, 40);

  const phraseSenses = senses.filter((s) => s.pos === 'phrase' || s.pos === 'idiom');
  const phrasePatterns = [];
  for (const s of phraseSenses) {
    const p = (s.pattern || '').toLowerCase()
      .replace(/\s*\(?\s*(?:from\s+)?(?:sb|sth)\.?(?:\/(?:sb|sth)\.?)?\s*\)?\s*/gi, ' ')
      .replace(/\s+/g, ' ').trim();
    if (p && !phrasePatterns.includes(p)) phrasePatterns.push(p);
  }
  const infForms = (groups.inflection || []).map((f) => f.surface);
  const infUnique = [...new Set(infForms.map((s) => s.toLowerCase()))];

  // 存在性检查：逐词 LIMIT 5 探测（kind 域恰好 5 种，LIMIT 5 即完备）
  // 不用单条大 IN：高频词（如 time/make）在 surfaces 中命中成百上千行，
  // 单条 IN 会全量扫描，D1 rows_read 爆表；逐词 LIMIT 5 每词最多读 5 行
  const allNeededSet = new Set([...arr, ...phrasePatterns, ...infUnique]);
  const allNeeded = [...allNeededSet];
  const foundMap = new Map(); // surface -> Set(kind)
  if (allNeeded.length) {
    const stmts = allNeeded.map((w) =>
      d1.prepare('SELECT surface, kind FROM surfaces WHERE surface = ? LIMIT 5').bind(w),
    );
    const results = [];
    for (let i = 0; i < stmts.length; i += 50) {
      const chunk = stmts.slice(i, i + 50);
      if (typeof d1.batch === 'function') {
        results.push(...(await d1.batch(chunk)));
      } else {
        results.push(...(await Promise.all(chunk.map((s) => s.all()))));
      }
    }
    for (const res of results) {
      for (const r of res.results || []) {
        const k = String(r.surface).toLowerCase();
        const kind = String(r.kind);
        if (!foundMap.has(k)) foundMap.set(k, new Set());
        foundMap.get(k).add(kind);
      }
    }
  }
  const discoverable = new Set();
  for (const w of arr) if (foundMap.has(w)) discoverable.add(w);
  for (const s of allSurfaces) discoverable.add(s.toLowerCase());

  const phraseLinked = new Set();
  for (const p of phrasePatterns) if (foundMap.has(p)) phraseLinked.add(p);

  const inflectLinked = new Set();
  for (const s of infUnique) {
    const kinds = foundMap.get(s);
    if (kinds && kinds.has('lemma')) inflectLinked.add(s);
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
    inflectLinked,
  };
}

export { loadEntry };
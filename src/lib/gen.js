// on-demand 生成（纯 JS，无第三方依赖）：
// SSE 解析 → JSON 输出 prompt → 校验 → D1 写入（words/senses/surfaces 幂等）
'use strict';

const POS_WHITELIST = ['noun', 'verb', 'adjective', 'adverb', 'preposition', 'conjunction', 'pronoun', 'interjection', 'article', 'phrase', 'idiom'];
const INFLECT_LABELS = ['plural', 'third_person_singular', 'present_participle', 'past', 'past_participle', 'comparative', 'superlative'];

const GEN_PROMPT = `You are an English-Chinese learner's dictionary editor. Generate an entry for the given word, output STRICT raw JSON, no commentary, no code fences.

Schema:
{
  "word": "the word as given",
  "cefr": "A1/A2/B1/B2/C1/C2 (best guess, optional)",
  "phonetic_uk": "/IPA/", "phonetic_us": "/IPA/",  // main pronunciation; give at least one if possible
  "other_notes": "word-level notes (secondary readings, special uses) — optional",
  "etymology": "etymology or fun fact that helps remember the word, in Chinese — optional but preferred",
  "entries": [
    {
      "pos": "noun|verb|adjective|adverb|preposition|conjunction|pronoun|interjection|article|phrase|idiom",
      "pattern": "required for phrase/idiom (e.g. run into [sb/sth])",
      "def_en": "simple English definition",
      "def_zh": "simple Chinese (mainland) definition",
      "example_en": "one simple example sentence (paired with example_zh)",
      "example_zh": "Chinese translation of the example",
      "register": "informal/formal/slang/technical… — optional",
      "usage_notes": "usage tips — optional",
      "synonyms": ["..."], "antonyms": ["..."], "collocations": ["..."]  // optional, word or phrase surfaces
    }
  ],
  "inflections": [ { "form": "plural|third_person_singular|present_participle|past|past_participle|comparative|superlative", "value": "..." } ]  // optional
}
Rules: meanings most common first; entries at most 12; omit fields you are not sure about (no null/empty strings); example_en/example_zh always paired; keep definitions in simple learner language.`;

// ---- SSE 流解析（契约：stream:true + delta.content 累加，忽略 reasoning_content） ----
async function readSse(res) {
  if (!res.body) throw new Error('empty body');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', content = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') return content;
      try {
        const chunk = JSON.parse(payload);
        const delta = chunk.choices?.[0]?.delta;
        if (typeof delta?.content === 'string') content += delta.content;
        if (chunk.choices?.[0]?.finish_reason === 'stop') return content;
      } catch { /* skip */ }
    }
  }
  return content;
}

// 调用 LLM 生成词条 JSON
async function generateEntry(env, word) {
  const { LLM_API, LLM_MODEL, LLM_TOKEN } = env;
  if (!LLM_API || !LLM_MODEL || !LLM_TOKEN) throw new Error('LLM env missing');
  const res = await fetch(LLM_API, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${LLM_TOKEN}`, accept: 'text/event-stream' },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages: [
        { role: 'system', content: GEN_PROMPT },
        { role: 'user', content: word },
      ],
      max_tokens: 20000,
      temperature: 0.3,
      stream: true,
    }),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const raw = await readSse(res);
  const cleaned = raw.replace(/^\s*```json/, '').replace(/```\s*$/, '').trim();
  let data;
  try {
    data = JSON.parse(cleaned);
  } catch (e) {
    throw new Error(`JSON parse fail: ${cleaned.slice(0, 300)}`);
  }
  return data;
}

// 字段校验（失败 throw，带原因）
function validate(data, word) {
  if (!data || typeof data.word !== 'string' || !data.word.trim()) throw new Error('word missing');
  const entries = data.entries ?? [];
  if (!Array.isArray(entries) || entries.length === 0) throw new Error('entries empty');
  entries.forEach((e, i) => {
    if (!POS_WHITELIST.includes(e.pos)) throw new Error(`entries[${i}].pos invalid: ${e.pos}`);
    if (typeof e.def_en !== 'string' || !e.def_en.trim()) throw new Error(`entries[${i}].def_en missing`);
    if (typeof e.def_zh !== 'string' || !e.def_zh.trim()) throw new Error(`entries[${i}].def_zh missing`);
    const en = typeof e.example_en === 'string' && e.example_en.trim() !== '';
    const zh = typeof e.example_zh === 'string' && e.example_zh.trim() !== '';
    if (en !== zh) throw new Error(`entries[${i}] example pair mismatch`);
    if ((e.pos === 'phrase' || e.pos === 'idiom') && !(e.pattern && e.pattern.trim())) throw new Error(`entries[${i}] phrase/idiom needs pattern`);
  });
  for (const f of data.inflections ?? []) {
    if (!INFLECT_LABELS.includes(f.form)) throw new Error(`inflection form invalid: ${f.form}`);
    if (typeof f.value !== 'string' || !f.value.trim()) throw new Error('inflection value missing');
  }
  return entries.length;
}

// D1 写入（幂等：word 已存在 → 不写，返回已有 word_id）
async function ingest(env, data) {
  const d1 = env.def_dict;
  const word = data.word.trim().toLowerCase();
  const exist = await d1.prepare('SELECT word_id FROM words WHERE lemma = ? LIMIT 1').bind(word).first();
  if (exist) return exist.word_id;

  const wres = await d1.prepare(`INSERT INTO words (lemma, entity_type, cefr, phonetic_uk, phonetic_us, other_notes, etymology)
    VALUES (?, 0, ?, ?, ?, ?, ?)`).bind(
    word, data.cefr ?? null, data.phonetic_uk ?? null, data.phonetic_us ?? null,
    data.other_notes ?? null, data.etymology ?? null,
  ).run();
  const wordId = wres.meta.last_row_id;

  for (let i = 0; i < data.entries.length; i++) {
    const e = data.entries[i];
    const senseNo = i + 1;
    const sres = await d1.prepare(`INSERT INTO senses (word_id, sense_no, pos, pattern, def_en, def_zh, example_en, example_zh, register, usage_notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      wordId, senseNo, e.pos, e.pattern ?? null, e.def_en, e.def_zh,
      e.example_en ?? null, e.example_zh ?? null, e.register ?? null, null,
    ).run();
    const senseId = sres.meta.last_row_id;
    // surfaces：synonyms/antonyms/collocations（sense_id 关联义项）
    for (const [key, kind] of [['synonyms', 'synonym'], ['antonyms', 'antonym'], ['collocations', 'collocation']]) {
      for (const s of e[key] ?? []) {
        await d1.prepare(`INSERT OR IGNORE INTO surfaces (surface, word_id, sense_id, kind, label) VALUES (?, ?, ?, ?, NULL)`)
          .bind(String(s).toLowerCase(), wordId, senseId, kind).run();
      }
    }
  }
  // inflections（词级 sense_id=0；带 sense 的按序号映射——简化：线上一律词级）
  for (const f of data.inflections ?? []) {
    await d1.prepare(`INSERT OR IGNORE INTO surfaces (surface, word_id, sense_id, kind, label) VALUES (?, ?, 0, 'inflection', ?)`)
      .bind(String(f.value).toLowerCase(), wordId, f.form).run();
  }
  // lemma 表面
  await d1.prepare(`INSERT OR IGNORE INTO surfaces (surface, word_id, sense_id, kind, label) VALUES (?, ?, 0, 'lemma', NULL)`)
    .bind(word, wordId).run();

  return { word_id: wordId };
}

export { generateEntry, validate, ingest };
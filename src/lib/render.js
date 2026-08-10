// 词条渲染模板（服务端唯一模板源：整页壳 + 词条 + 首页）
// 类名沿用 public/style.css
'use strict';
// 整页壳模板：独立文件，导入打进 bundle（worker 无真实文件系统）
import tpl from './shell.tpl.html';

const shellFn = new Function('params', 'return `' + tpl + '`');

const POS_CN = {
  noun: '名词', verb: '动词', adjective: '形容词', adverb: '副词',
  preposition: '介词', conjunction: '连词', pronoun: '代词',
  interjection: '感叹词', article: '冠词', phrase: '短语', idiom: '习语',
};

const REGISTER_CN = {
  formal: '正式', informal: '口语', neutral: '中性', technical: '专业',
  slang: '俚语', literary: '书面', archaic: '古旧', vulgar: '粗俗',
  offensive: '冒犯', disapproving: '贬义', dialect: '方言', medical: '医学',
  'old-fashioned': '过时', humorous: '幽默', rare: '罕用', academic: '学术',
  colloquial: '口语', poetic: '诗意', historical: '历史',
};

// 常用度星级：对数分桶 + tooltip 文本
function freqTier(freq) {
  if (freq >= 1e8) return 5;
  if (freq >= 1e7) return 4;
  if (freq >= 1e6) return 3;
  if (freq >= 1e5) return 2;
  return 1;
}
function freqBadge(freq) {
  if (!freq || freq <= 0) return '';
  const tier = freqTier(freq);
  const stars = '★'.repeat(tier) + '☆'.repeat(5 - tier);
  return `<span class="freq" tabindex="0" data-tip="语料词频 ${freq.toLocaleString()}">常用度 ${stars}</span>`;
}

const esc = (s) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const href = (word) => '/' + encodeURIComponent(word);

// 文本 token 化（与 collect 同规则：小写、's 剥离、撇号剔除、字母开头）
const tokenRe = /[a-zA-Z][a-zA-Z'-]*/g;
function tokensOf(text) {
  const out = [];
  for (const m of String(text).match(tokenRe) || []) {
    let w = m.toLowerCase();
    if (w.endsWith("'s")) w = w.slice(0, -2);
    if (w.includes("'") || w.length < 2) continue;
    out.push(w);
  }
  return out;
}

// def_en/example_en/pattern 文本 → 可查词 <span class="term">（按 Cmd/Ctrl 才变链接）
// lemma: 当前词条自身，跳过不渲染链接（避免 self-link）
function linkText(text, discoverable, lemma) {
  let html = '';
  let last = 0;
  const t = String(text ?? '');
  for (const m of t.matchAll(tokenRe)) {
    let w = m[0].toLowerCase();
    if (w.endsWith("'s")) w = w.slice(0, -2);
    if (!discoverable.has(w)) continue;
    if (lemma && w === lemma) { html += esc(t.slice(last, m.index + m[0].length)); last = m.index + m[0].length; continue; }
    html += esc(t.slice(last, m.index));
    html += `<span class="term" data-word="${href(w)}">${esc(m[0])}</span>`;
    last = m.index + m[0].length;
  }
  return html + esc(t.slice(last));
}

// ---- 右栏分组 ----
function renderForms(forms) {
  if (!forms.length) return '';
  const LABEL_CN = { plural: '复数', past: '过去式', past_participle: '过去分词', present_participle: '现在分词', third_person_singular: '第三人称单数', comparative: '比较级', superlative: '最高级' };
  const rows = forms.map((f) => `<tr><td>${esc(LABEL_CN[f.label] ?? f.label)}</td><td><a href="${href(f.surface)}">${esc(f.surface)}</a></td></tr>`).join('');
  return `<div class="section"><h2>词形</h2><table class="forms-table"><tbody>${rows}</tbody></table></div>`;
}

// phrase/idiom pattern → 可查短语的干净形式（与 lookup.js 同规则）
function cleanPattern(p) {
  return String(p).toLowerCase()
    .replace(/\s*\(?\s*(?:from\s+)?(?:sb|sth)\.?(?:\/(?:sb|sth)\.?)?\s*\)?\s*/gi, ' ')
    .replace(/\s+/g, ' ').trim();
}

// ---- 主体 ----
// entry: { lemma, entity_type, cefr, phonetic_uk, phonetic_us, other_notes, etymology,
//          senses[], groups: {inflection,synonym,antonym,collocation}[], discoverable:Set }
function renderEntry(entry, queryWord) {
  const isEntity = entry.entity_type === 1;
  const phonetic = entry.phonetic_uk || entry.phonetic_us
    ? (() => {
        const uk = entry.phonetic_uk ? `UK ${entry.phonetic_uk}` : '';
        const us = entry.phonetic_us ? `US ${entry.phonetic_us}` : '';
        return [uk, us].filter(Boolean).join('  ');
      })()
    : '';
  const poss = [...new Set(entry.senses.map((s) => s.pos))].map((p) => POS_CN[p] ?? p).join(' · ');
  const cefrBadge = entry.cefr ? `<span class="cefr">${esc(entry.cefr)}</span>` : '';
  const freqBadgeOut = freqBadge(entry.freq);
  const entityTag = isEntity ? '<span class="etag">名字/实体</span>' : '';

  // 释义：全部 senses 统一列表（含 phrase/idiom，其 pattern 作词头展示）
  // 排序：普通义在前，短语/习语在后，组内保持 sense_no 顺序
  const isPhr = (s) => s.pos === 'phrase' || s.pos === 'idiom';
  const senses = [...entry.senses.filter((s) => !isPhr(s)), ...entry.senses.filter(isPhr)];
  const g = entry.groups;
  const senseLinks = (senseId) => {
    const syn = (g.synonym || []).filter((r) => r.sense_id === senseId);
    const ant = (g.antonym || []).filter((r) => r.sense_id === senseId);
    const col = (g.collocation || []).filter((r) => r.sense_id === senseId);
    if (!syn.length && !ant.length && !col.length) return '';
    const parts = [];
    if (syn.length) parts.push('≈ ' + syn.map((r) => `<a href="${href(r.surface)}">${esc(r.surface)}</a>`).join(', '));
    if (ant.length) parts.push('☍ ' + ant.map((r) => `<a href="${href(r.surface)}">${esc(r.surface)}</a>`).join(', '));
    if (col.length) parts.push('⋈ ' + col.map((r) => `<a href="${href(r.surface)}">${esc(r.surface)}</a>`).join(', '));
    return `<div class="sense-links">${parts.join('　')}</div>`;
  };
  const defList = senses.length
    ? `<div class="section"><h2>释义</h2><ol class="list">${senses.map((s) => {
        const head = isPhr(s) && s.pattern
          ? (entry.phraseLinked && entry.phraseLinked.has(cleanPattern(s.pattern))
              ? `<span class="pattern"><a href="${href(s.pattern)}">${esc(s.pattern)}</a></span>`
              : `<span class="pattern">${esc(s.pattern)}</span>`)
          : '';
        const posBadge = `<span class="pos-badge">${esc(POS_CN[s.pos] ?? s.pos)}</span>`;
        return `<li>${head}${posBadge}<b>${linkText(s.def_en, entry.discoverable, entry.lemma)}</b><span class="zh"> ${esc(s.def_zh)}</span>${
          s.register ? `<span class="reg">${esc(REGISTER_CN[s.register.toLowerCase()] ?? s.register)}</span>` : ''}${
          s.usage_notes ? `<div class="usage">${esc(s.usage_notes)}</div>` : ''}${
          s.example_en ? `<div class="ex">${linkText(s.example_en, entry.discoverable, entry.lemma)}<em> ${esc(s.example_zh || '')}</em></div>` : ''}${
          senseLinks(s.id || s.sense_no)}</li>`;
      }).join('')}</ol></div>`
    : '';

  const concept = entry.other_notes ? `<div class="section"><div class="concept">${esc(entry.other_notes)}</div></div>` : '';
  const etym = entry.etymology
    ? `<div class="section"><h2>词源</h2><p class="etym">${esc(entry.etymology)}</p></div>`
    : (entry.other_notes && !isEntity ? '' : '');

  const colSide = renderForms(g.inflection)
    + etym;

  const main = concept + defList;

  return `<div class="entry-wrap">
  <div class="word-head">
    <div class="word">${esc(entry.lemma)}${entityTag}${cefrBadge}${freqBadgeOut}</div>
    ${phonetic ? `<div class="phonetic">${esc(phonetic)}</div>` : ''}
    ${poss ? `<div class="pos">${esc(poss)}</div>` : ''}
  </div>
  <div class="entry-grid">
    <div class="col-main">${main}</div>
    <div class="col-side">${colSide}</div>
  </div>
</div>`;
}

// 首页内容
function renderIndex() {
  return indexInner;
}

// 占位页 / 404 页 内容（fragment 或整页共用）
function renderPlaceholder(word, isRejected) {
  return `<div class="entry-wrap">
  <div class="word-head"><div class="word">${esc(word)}</div></div>
  <div class="section">
    <h2>${isRejected ? '未收录' : '生成中…'}</h2>
    <p class="sub">${isRejected
      ? '这个词不在英语词典收录范围（外语词/缩写/拼写错误等）。'
      : '这个词尚未收录，正在用 AI 现场生成词条…'}</p>
  </div>
</div>`;
}

// 整页壳（topbar + 内层）；bodyAttrs 如 `data-gen="xyzzy"` 触发占位页自动生成
// 所有填充值在此预转义，模板文件内不再做任何转义（避免二次转义/漏转义）
// bodyAttrs 由调用方按属性上下文构造（定界引号保留，值内部字符已 esc）
function shell(title, inner, word, bodyAttrs) {
  const params = {
    title: title ? esc(title) + ' · ' : '',
    inner,
    // JS 字符串字面量上下文：JSON.stringify 后把 < > 转成 \u 序列，防 </script> 逃逸
    wordJs: (word === null || word === undefined ? 'null'
      : JSON.stringify(String(word)).replace(/</g, '\\u003c').replace(/>/g, '\\u003e')),
    bodyAttr: bodyAttrs || '',
  };
  return shellFn(params);
}

const indexInner = `
<div class="hero">
  <h1>def.est.im</h1>
  <p class="sub">
    不限格式：变形词、词组、搭配、人名地名都可以。
    输入 <a href="/run">run</a>、
    <a href="/went">went</a>、
    <a href="/run%20into">run into</a>、
    <a href="/heavy%20rain">heavy rain</a>、
    <a href="/karen">Karen</a> 试试。
  </p>
</div>`;

export { renderEntry, renderPlaceholder, renderIndex, shell, tokensOf, linkText, esc, href, POS_CN };

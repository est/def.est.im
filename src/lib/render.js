// 词条渲染模板（服务端唯一模板源；fragment 与整页共用）
// 结构与 public/entry.html 手稿一致，类名沿用 public/style.css
'use strict';

const POS_CN = {
  noun: '名词', verb: '动词', adjective: '形容词', adverb: '副词',
  preposition: '介词', conjunction: '连词', pronoun: '代词',
  interjection: '感叹词', article: '冠词', phrase: '短语', idiom: '习语',
};

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

// def_en/example_en/pattern 文本 → 可查词包 <a class="term">，其余原样
function linkText(text, discoverable) {
  let html = '';
  let last = 0;
  const t = String(text ?? '');
  for (const m of t.matchAll(tokenRe)) {
    let w = m[0].toLowerCase();
    if (w.endsWith("'s")) w = w.slice(0, -2);
    if (!discoverable.has(w)) continue;
    html += esc(t.slice(last, m.index));
    html += `<a class="term" href="${href(w)}">${esc(m[0])}</a>`;
    last = m.index + m[0].length;
  }
  return html + esc(t.slice(last));
}

// ---- 右栏分组 ----
function renderForms(forms) {
  if (!forms.length) return '';
  const LABEL_CN = { plural: '复数', past: '过去式', past_participle: '过去分词', present_participle: '现在分词', third_person_singular: '第三人称单数', comparative: '比较级', superlative: '最高级' };
  const rows = forms.map((f) => `<tr><td>${esc(LABEL_CN[f.label] ?? f.label)}</td><td><a class="term" href="${href(f.surface)}">${esc(f.surface)}</a></td></tr>`).join('');
  return `<div class="section"><h2>词形</h2><table class="forms-table"><tbody>${rows}</tbody></table></div>`;
}

function renderRel(list, title, cls) {
  if (!list.length) return '';
  const items = list.map((r) => `<div class="${cls}"><span class="e"><a class="term" href="${href(r.surface)}">${esc(r.surface)}</a></span></div>`).join('');
  return `<div class="section"><h2>${title}</h2>${items}</div>`;
}

function renderPhrases(senses) {
  const ph = senses.filter((s) => (s.pos === 'phrase' || s.pos === 'idiom'));
  if (!ph.length) return '';
  const items = ph.map((s) => `<div class="phr"><div class="w"><a class="term" href="${href(s.pattern || '')}">${esc(s.pattern || '')}</a></div><div class="d">${esc(s.def_zh)}${s.def_en ? ' · ' + esc(s.def_en) : ''}</div></div>`).join('');
  return `<div class="section"><h2>相关短语</h2><div class="phr-list">${items}</div></div>`;
}

// ---- 主体 ----
// entry: { lemma, entity_type, cefr, phonetic_uk, phonetic_us, other_notes, etymology,
//          senses[], groups: {inflection,synonym,antonym,collocation}[], discoverable:Set }
function renderEntry(entry, queryWord) {
  const isEntity = entry.entity_type === 1;
  const phonetic = entry.phonetic_uk || entry.phonetic_us
    ? [entry.phonetic_uk, entry.phonetic_us].filter(Boolean).join(' / ')
    : '';
  const poss = [...new Set(entry.senses.map((s) => s.pos))].map((p) => POS_CN[p] ?? p).join(' · ');
  const cefrBadge = entry.cefr ? `<span class="cefr">${esc(entry.cefr)}</span>` : '';
  const entityTag = isEntity ? '<span class="etag">名字/实体</span>' : '';

  // 释义：非 phrase/idiom 义项按列表；phrase 义项单独进短语区（renderPhrases）
  const senses = entry.senses.filter((s) => s.pos !== 'phrase' && s.pos !== 'idiom');
  const defList = senses.length
    ? `<div class="section"><h2>释义</h2><ol class="list">${senses.map((s) => `
      <li><b>${linkText(s.def_en, entry.discoverable)}</b><span class="zh"> ${esc(s.def_zh)}</span>${
        s.register ? `<span class="reg">${esc(s.register)}</span>` : ''}${
        s.usage_notes ? `<div class="usage">${esc(s.usage_notes)}</div>` : ''}${
        s.example_en ? `<div class="ex">${linkText(s.example_en, entry.discoverable)}<em> ${esc(s.example_zh || '')}</em></div>` : ''}</li>`).join('')}</ol></div>`
    : '';

  const concept = entry.other_notes ? `<div class="section"><div class="concept">${esc(entry.other_notes)}</div></div>` : '';
  const etym = entry.etymology
    ? `<div class="section"><h2>词源</h2><p class="etym">${esc(entry.etymology)}</p></div>`
    : (entry.other_notes && !isEntity ? '' : '');

  const g = entry.groups;
  const colSide = renderPhrases(entry.senses)
    + renderRel(g.collocation, '常见搭配', 'coll')
    + renderRel(g.synonym, '近义词', 'coll')
    + renderRel(g.antonym, '反义词', 'coll')
    + renderForms(g.inflection)
    + etym;

  const main = concept + defList;

  return `<div class="entry-wrap">
  <div class="word-head">
    <div class="word">${esc(entry.lemma)}${entityTag}${cefrBadge}</div>
    ${phonetic ? `<div class="phonetic">/${esc(phonetic)}/</div>` : ''}
    ${poss ? `<div class="pos">${esc(poss)}</div>` : ''}
  </div>
  <div class="entry-grid">
    <div class="col-main">${main}</div>
    <div class="col-side">${colSide}</div>
  </div>
</div>`;
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
function shell(title, inner, word, bodyAttrs) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · def.est.im</title>
<link rel="stylesheet" href="/style.css">
</head>
<body${bodyAttrs ? ' ' + bodyAttrs : ''}>
<div class="topbar">
  <a class="brand" href="/">def.est.im</a>
  <div class="search-bar">
    <input type="text" placeholder="搜索…" id="q">
    <kbd>⌘K</kbd>
  </div>
</div>
${inner}
<script>
(function () {
  var q = document.getElementById('q');
  if (q && ${JSON.stringify(word ?? null)}) q.value = ${JSON.stringify(word ?? null)};
  document.addEventListener('keydown', function (e) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); q && q.focus(); q && q.select(); }
  });
  q && q.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && this.value.trim()) location.href = '/' + encodeURIComponent(this.value.trim());
  });
  // 词条内可点词：POST fragment 局部替换 + history
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a.term') : null;
    if (!a) return;
    e.preventDefault();
    var w = decodeURIComponent(a.pathname ? a.pathname.replace(/^\\//, '') : a.href.split('/').pop());
    fetch('/?w=' + encodeURIComponent(w) + '&fragment=1', { method: 'POST' })
      .then(function (r) { return r.text(); })
      .then(function (html) {
        var el = document.querySelector('.entry-wrap');
        if (el && html) { el.outerHTML = html; history.pushState({ w: w }, '', '/' + encodeURIComponent(w)); document.title = w + ' · def.est.im'; }
      })
      .catch(function () { location.href = '/' + encodeURIComponent(w); });
  });
  window.addEventListener('popstate', function (e) {
    var w = (e.state && e.state.w) || decodeURIComponent(location.pathname.slice(1));
    if (!w) return;
    fetch('/?w=' + encodeURIComponent(w) + '&fragment=1', { method: 'POST' })
      .then(function (r) { return r.text(); })
      .then(function (html) { var el = document.querySelector('.entry-wrap'); if (el && html) { el.outerHTML = html; document.title = w + ' · def.est.im'; } });
  });
  // 占位页：自动触发生成
  var gen = document.body.getAttribute('data-gen');
  if (gen) {
    fetch('/?w=' + encodeURIComponent(gen) + '&gen=1', { method: 'POST' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j && j.ok) {
          return fetch('/?w=' + encodeURIComponent(gen) + '&fragment=1', { method: 'POST' }).then(function (r) { return r.text(); });
        }
        throw new Error('gen fail');
      })
      .then(function (html) { var el = document.querySelector('.entry-wrap'); if (el && html) { el.outerHTML = html; } })
      .catch(function () {
        var el = document.querySelector('.entry-wrap');
        if (el) el.insertAdjacentHTML('beforeend', '<div class="section"><h2>生成失败</h2><p class="sub">这个词暂时无法生成，请稍后再试。</p></div>');
      });
  }
})();
</script>
</body>
</html>`;
}

export { renderEntry, renderPlaceholder, shell, tokensOf, linkText, esc, href, POS_CN };

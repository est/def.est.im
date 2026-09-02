'use strict';

const STATE_KEY = '__D1_CIRCUIT__';

function getState() {
  if (!globalThis[STATE_KEY]) globalThis[STATE_KEY] = { fails: [], openUntil: 0 };
  return globalThis[STATE_KEY];
}

export function recordD1Failure() {
  const now = Date.now();
  const s = getState();
  s.fails.push(now);
  s.fails = s.fails.filter((t) => now - t < 60_000);
  if (s.fails.length >= 3) {
    s.openUntil = now + 5 * 60 * 1000;
  }
}

export function recordD1Success() {
  const s = getState();
  if (s.fails.length) s.fails = [];
}

export function isCircuitOpen() {
  const s = getState();
  return Date.now() < s.openUntil;
}

export function isSpacedQuery(word) {
  return word.includes(' ') || word.includes('\t');
}

export function shouldBlockSpaced(word) {
  return isSpacedQuery(word) && isCircuitOpen();
}

export function isD1Error(e) {
  const msg = String(e?.message ?? e ?? '');
  return msg.includes('D1_ERROR') || msg.includes('exceeded D1') || msg.includes('row read limit') || (msg.includes('D1') && msg.includes('limit'));
}

export function circuit429(word, reason) {
  return new Response('', {
    status: 429,
    headers: {
      'retry-after': '86400',
      'cache-control': 'public, max-age=86400, s-maxage=86400',
      'cdn-cache-control': 'public, max-age=86400',
      'x-circuit-reason': reason,
      'x-word': word.slice(0, 30),
    },
  });
}

export function getCircuitState() {
  const s = getState();
  return { fails: [...s.fails], openUntil: s.openUntil, open: isCircuitOpen() };
}

export function resetCircuitForTest() {
  const s = getState();
  s.fails = [];
  s.openUntil = 0;
}

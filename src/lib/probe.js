// AI 存活探测：最短 prompt 验证 LLM 通路可用（含 token/模型配置）
// prompt 思路：Q:PING?\nA:___ → 让模型补全 ___（期望 PONG）
'use strict';

const PROBE_PROMPT = 'Q:PING?\nA:';

export async function probeAi(env) {
  const { LLM_API, LLM_MODEL, LLM_TOKEN } = env;
  if (!LLM_API || !LLM_MODEL || !LLM_TOKEN) {
    return { ok: false, error: 'LLM env missing (LLM_API/LLM_MODEL/LLM_TOKEN)' };
  }
  const t0 = Date.now();
  try {
    const res = await fetch(LLM_API, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${LLM_TOKEN}` },
      body: JSON.stringify({
        model: LLM_MODEL,
        messages: [{ role: 'user', content: PROBE_PROMPT }],
        max_tokens: 16,
        temperature: 0,
        stream: false,
      }),
      signal: AbortSignal.timeout(15000),
    });
    const ms = Date.now() - t0;
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`, ms };
    const data = await res.json();
    const reply = data.choices?.[0]?.message?.content?.trim();
    if (!reply) return { ok: false, error: 'empty reply', ms };
    return { ok: true, reply, model: LLM_MODEL, ms };
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 200), ms: Date.now() - t0 };
  }
}

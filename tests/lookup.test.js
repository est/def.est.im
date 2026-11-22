import { describe, test, expect } from "bun:test";
import { loadEntry } from "../src/lib/lookup.js";

// ---- 极简 D1 桩：按 SQL 前缀分发，记录所有调用 ----
function fakeD1(registry) {
  const calls = [];
  const mk = (sql) => ({
    _args: [],
    bind(...args) { this._args = args; return this; },
    async all() { calls.push({ sql, args: this._args }); return registry(sql, this._args); },
    async first() { calls.push({ sql, args: this._args }); return (registry(sql, this._args).results || [])[0] ?? null; },
    async run() { calls.push({ sql, args: this._args }); return registry(sql, this._args); },
  });
  return {
    calls,
    prepare: (sql) => mk(sql),
    async batch(stmts) { const out = []; for (const s of stmts) out.push(await s.all()); return out; },
  };
}

// 已知 surface → kind 列表（用于探测命中判定）
const SURFACES = new Map([
  ["run", [{ word_id: 1, kind: "lemma" }]],
  ["move", [{ word_id: 2, kind: "lemma" }]],
  ["quickly", [{ word_id: 3, kind: "lemma" }]],
  ["fast", [{ word_id: 4, kind: "lemma" }]],
  ["running", [{ word_id: 5, kind: "lemma" }]],
]);

function registry(sql, args) {
  const s = sql.replace(/\s+/g, " ").trim();
  if (s.startsWith("SELECT word_id, kind FROM surfaces")) {
    return { results: (SURFACES.get(String(args[0]).toLowerCase()) || []).map((r) => ({ word_id: r.word_id, kind: r.kind })) };
  }
  if (s.startsWith("SELECT 1 FROM rejects")) return { results: [] };
  if (s.includes("DISTINCT surface FROM surfaces")) return { results: [] };
  if (s.startsWith("SELECT * FROM words WHERE word_id IN")) {
    return { results: [{ word_id: 1, lemma: "run", entity_type: 0, freq: 1e7, cefr: "A1", phonetic_uk: "", phonetic_us: "", other_notes: "", etymology: "" }] };
  }
  if (s.startsWith("SELECT * FROM senses")) {
    return { results: [{ sense_no: 1, pos: "verb", pattern: null, def_en: "move quickly", def_zh: "跑", example_en: "She runs fast", example_zh: "她跑得快", register: null, usage_notes: null }] };
  }
  if (s.startsWith("SELECT surface, kind, sense_id, label FROM surfaces")) {
    return { results: [
      { surface: "run", kind: "lemma", sense_id: 0, label: null },
      { surface: "running", kind: "inflection", sense_id: 0, label: "present_participle" },
    ] };
  }
  if (s.includes("kind IN ('synonym','antonym')")) return { results: [] };
  if (s.startsWith("SELECT 1 AS hit FROM surfaces")) {
    const rows = SURFACES.get(String(args[0]).toLowerCase()) || [];
    const onlyLemma = s.includes("kind = 'lemma'");
    const ok = onlyLemma ? rows.some((r) => r.kind === "lemma") : rows.length > 0;
    return { results: ok ? [{ hit: 1 }] : [] };
  }
  if (s.startsWith("SELECT word_id, lemma FROM words")) return { results: [] };
  return { results: [] };
}

describe("lookup 存在性探测瘦身 (B)", () => {
  test("探测语句用 LIMIT 1，绝不用 LIMIT 5", async () => {
    const d1 = fakeD1(registry);
    const r = await loadEntry({ def_dict: d1 }, "run");
    expect(r.type).toBe("entry");
    const probes = d1.calls.filter((c) => c.sql.startsWith("SELECT 1 AS hit FROM surfaces"));
    expect(probes.length).toBeGreaterThan(0);
    expect(probes.every((c) => c.sql.includes("LIMIT 1"))).toBe(true);
    expect(d1.calls.some((c) => c.sql.includes("LIMIT 5"))).toBe(false);
  });

  test("discoverable / phraseLinked / inflectLinked 语义保持不变", async () => {
    const d1 = fakeD1(registry);
    const r = await loadEntry({ def_dict: d1 }, "run");
    // 命中的 token 进 discoverable，未命中不进
    expect(r.discoverable.has("move")).toBe(true);
    expect(r.discoverable.has("quickly")).toBe(true);
    expect(r.discoverable.has("fast")).toBe(true);
    expect(r.discoverable.has("runs")).toBe(false);
    // 词形自身始终进 discoverable
    expect(r.discoverable.has("running")).toBe(true);
    // running 作为 lemma 存在 → 词形可链接
    expect(r.inflectLinked.has("running")).toBe(true);
    // 无 phrase 义项 → 空
    expect(r.phraseLinked.size).toBe(0);
  });
});

import { describe, test, expect } from "bun:test";
import { renderEntry } from "../src/lib/render.js";

// 构造一个含短语义项（pattern 带 sb./sth. 占位符）的 entry
const mk = (over = {}) => ({
  lemma: "approve",
  entity_type: 0,
  freq: 1000000,
  cefr: "B1",
  phonetic_uk: null,
  phonetic_us: null,
  other_notes: null,
  etymology: null,
  senses: [{
    sense_no: 1, pos: "phrase", pattern: "approve of sb./sth.",
    def_en: "to agree to something", def_zh: "同意",
    example_en: "The board approved of the plan.", example_zh: "董事会同意这个计划。",
    register: null, usage_notes: null,
  }],
  groups: { inflection: [], synonym: [], antonym: [], collocation: [] },
  discoverable: new Set(["approve", "of", "board", "plan"]),
  // 注意：phraseLinked 的键是 cleanPattern() 之后的形式（占位符被剥掉）
  phraseLinked: new Set(["approve of"]),
  inflectLinked: new Set(),
  ...over,
});

describe("render: 坏链接抑制 (1)", () => {
  test("pattern 里的 sb./sth. 不渲染成链接，只作纯文本", () => {
    const html = renderEntry(mk(), "approve");
    expect(html).not.toContain('href="/sb');       // 不再有 /sb./sth. 链接
    expect(html).not.toContain("%2F");             // 不出现编码后的斜杠
    expect(html).toContain("sb./sth.");            // 占位符文字仍然展示（纯文本）
    expect(html).toContain('href="/approve"');     // 正常词仍可点
    expect(html).toContain('href="/of"');
  });

  test("含 sth / sb 的多词 pattern：只链接真实词，占位符保持纯文本", () => {
    const html = renderEntry(mk({
      senses: [{
        sense_no: 1, pos: "phrase", pattern: "share sth with sb",
        def_en: "x", def_zh: "y", example_en: null, example_zh: null,
        register: null, usage_notes: null,
      }],
      phraseLinked: new Set(["share with"]),
    }), "approve");
    expect(html).toContain('href="/share"');
    expect(html).toContain('href="/with"');
    expect(html).not.toMatch(/href="\/sth/);
    expect(html).not.toMatch(/href="\/sb/);
  });

  test("词形（inflection）里的非词 surface 不渲染成链接", () => {
    const html = renderEntry(mk({
      groups: {
        inflection: [
          { surface: "sb./sth.", sense_id: 0, label: null },
          { surface: "sb's", sense_id: 0, label: null },
          { surface: "approves", sense_id: 0, label: "third_person_singular" },
        ],
        synonym: [], antonym: [], collocation: [],
      },
      inflectLinked: new Set(["sb./sth.", "sb's", "approves"]),
    }), "approve");
    expect(html).not.toContain('href="/sb');
    expect(html).toContain('href="/approves"');
  });
});

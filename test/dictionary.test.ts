import { describe, expect, it } from "vitest";

import {
  cleanQuery,
  ftsExpression,
  isJapaneseQuery,
  parseEntry,
  rerankEnglish,
  type EntryRow,
} from "../src/domain/dictionary";

const row = (id: number, headword: string, glosses: string[], score = 9): EntryRow => ({
  headword,
  id,
  payload: JSON.stringify({
    r: [{ t: headword }],
    s: [{ g: glosses, p: ["noun (common) (futsuumeishi)"] }],
    w: [{ t: headword }],
  }),
  score,
});

describe("query boundaries", () => {
  it("normalizes width and whitespace without accepting empty or oversized input", () => {
    expect(cleanQuery("  ＣＡＴ　food  ")).toBe("CAT food");
    expect(cleanQuery("\n\t")).toBeNull();
    expect(cleanQuery("a".repeat(81))).toBeNull();
    expect(cleanQuery({ query: "cat" })).toBeNull();
  });

  it("routes scripts and emits syntax-safe FTS prefixes", () => {
    expect(isJapaneseQuery("猫")).toBe(true);
    expect(isJapaneseQuery("ねこ")).toBe(true);
    expect(isJapaneseQuery("cat")).toBe(false);
    expect(ftsExpression('computer "science"')).toBe('"computer"* AND "science"*');
    expect(ftsExpression("***")).toBeNull();
  });
});

describe("entry shaping", () => {
  it("deduplicates readings and translates common part labels", () => {
    const parsed = parseEntry({
      headword: "猫",
      id: 1467640,
      payload: JSON.stringify({
        r: [{ t: "ねこ" }, { t: "ねこ" }],
        s: [{ g: ["cat"], p: ["noun (common) (futsuumeishi)"] }],
        w: [{ t: "猫" }, { t: "ネコ" }],
      }),
      score: 0,
    });
    expect(parsed.readings).toEqual(["ねこ"]);
    expect(parsed.alternatives).toEqual(["ネコ", "ねこ"]);
    expect(parsed.senses[0]?.parts).toEqual(["名詞"]);
  });

  it("puts an exact common English gloss ahead of incidental matches", () => {
    const entries = [
      parseEntry(row(1, "猫背", ["cat-like back"], 0)),
      parseEntry(row(2, "猫", ["cat"], 0)),
      parseEntry(row(3, "山猫", ["wild cat"], 0)),
    ];
    expect(rerankEnglish(entries, "cat").map((entry) => entry.id)).toEqual([2, 1, 3]);
  });
});

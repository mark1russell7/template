// The line diff and its unified format.
import { describe, expect, it } from "vitest";
import { diffLines, unifiedDiff } from "./index.ts";

/** This function applies an edit script, to check that it gives the two texts. */
function sides(ops: ReturnType<typeof diffLines>): { before: string[]; after: string[] } {
  return { before: ops.filter((op) => op.kind !== "+").map((op) => op.text), after: ops.filter((op) => op.kind !== "-").map((op) => op.text) };
}

describe("diffLines", () => {
  it("gives a shortest edit script that makes the two texts", () => {
    const before = "a b c a b b a".split(" ");
    const after = "c b a b a c".split(" ");
    const ops = diffLines(before, after);
    expect(sides(ops)).toEqual({ before, after });
    // The shortest script of this example of Myers has five changes
    expect(ops.filter((op) => op.kind !== " ")).toHaveLength(5);
  });

  it("knows the empty lists and the same lists", () => {
    expect(diffLines([], [])).toEqual([]);
    expect(diffLines([], ["a"])).toEqual([{ kind: "+", text: "a" }]);
    expect(diffLines(["a"], [])).toEqual([{ kind: "-", text: "a" }]);
    expect(diffLines(["a", "b"], ["a", "b"]).every((op) => op.kind === " ")).toBe(true);
  });

  it("gives the two texts for random lists", () => {
    let seed = 7;
    const next = (): number => (seed = (seed * 48271) % 2147483647) % 4;
    for (let round = 0; round < 50; round++) {
      const before = Array.from({ length: next() * 5 }, () => String(next()));
      const after = Array.from({ length: next() * 5 }, () => String(next()));
      expect(sides(diffLines(before, after))).toEqual({ before, after });
    }
  });
});

describe("unifiedDiff", () => {
  it("gives an empty text for the same texts", () => {
    expect(unifiedDiff("a\nb\n", "a\nb\n")).toBe("");
  });

  it("gives hunks with three lines of context, as diff -u", () => {
    const before = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14", "15"].join("\n") + "\n";
    const after = before.replace("2\n", "two\n").replace("14\n", "");
    expect(unifiedDiff(before, after, { from: "a/x", to: "b/x" })).toBe(
      ["--- a/x", "+++ b/x", "@@ -1,5 +1,5 @@", " 1", "-2", "+two", " 3", " 4", " 5", "@@ -11,5 +11,4 @@", " 11", " 12", " 13", "-14", " 15", ""].join("\n"),
    );
  });

  it("joins two changes that are near, and shows a new file", () => {
    expect(unifiedDiff("a\nb\nc\nd\n", "a\nB\nc\nD\n")).toBe(["--- before", "+++ after", "@@ -1,4 +1,4 @@", " a", "-b", "+B", " c", "-d", "+D", ""].join("\n"));
    expect(unifiedDiff("", "x\ny\n", { from: "/dev/null", to: "b/n" })).toBe(["--- /dev/null", "+++ b/n", "@@ -0,0 +1,2 @@", "+x", "+y", ""].join("\n"));
  });
});

import { describe, expect, it } from "vitest";
import { readReference, REFERENCE_FORMAT, ReferenceDataError, referenceProblems } from "./reference.ts";

const FILE = {
  format: "api-model/1",
  packages: [
    {
      packageName: "@acme/lib",
      entries: [{ subpath: ".", names: [{ name: "layout", key: "build/index.d.ts#layout", isType: false, kind: "declaration", extra: 1 }] }],
      declarations: { "build/index.d.ts#layout": { text: "export declare function layout(): void;", doc: "The layout." } },
    },
  ],
};

describe("the file reference.json", () => {
  it("reads a correct file, and keeps only the known fields", () => {
    const file = readReference(JSON.stringify({ ...FILE, other: true }));
    expect(file.format).toBe(REFERENCE_FORMAT);
    expect(file).not.toHaveProperty("other");
    expect(file.packages[0]?.entries[0]?.names[0]).toEqual({ name: "layout", key: "build/index.d.ts#layout", isType: false, kind: "declaration" });
    expect(file.packages[0]?.declarations["build/index.d.ts#layout"]).toEqual({ text: "export declare function layout(): void;", doc: "The layout." });
  });

  it("refuses a different format, a file that is not JSON and a file with no packages", () => {
    expect(referenceProblems({ ...FILE, format: "api-model/2" })[0]).toContain("The format is not api-model/1.");
    expect(referenceProblems({ format: "api-model/1", packages: [] })).toEqual(["The file has no packages."]);
    expect(referenceProblems([])).toEqual(["The file is not an object."]);
    expect(() => readReference("{")).toThrow(ReferenceDataError);
    expect(() => readReference("{")).toThrow(/reference\.json is not correct: The file is not JSON/);
  });

  it("gives a fault for each bad part of a package", () => {
    const bad = {
      format: "api-model/1",
      packages: [
        { packageName: "", entries: [{ subpath: ".", names: [{ name: "a", key: "", isType: "no", kind: "other" }] }, { names: [] }], declarations: { k: { doc: 1 } } },
        "text",
      ],
    };
    expect(referenceProblems(bad)).toEqual([
      "Package 0 has no packageName.",
      "Name 0 of entry 0 of package 0 has no key.",
      "Name 0 of entry 0 of package 0 has no boolean isType.",
      "Name 0 of entry 0 of package 0 has no known kind.",
      "Entry 1 of package 0 has no subpath and list of names.",
      "The declaration k of package 0 has no text, or a doc that is not a text.",
      "Package 1 is not an object.",
    ]);
  });

  it("keeps a declaration key such as __proto__ as an own field", () => {
    const text = JSON.stringify(FILE).replace('"declarations":{', '"declarations":{"__proto__":{"text":"x"},');
    const file = readReference(text);
    const declarations = file.packages[0]?.declarations ?? {};
    expect(Object.hasOwn(declarations, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(declarations)).toBe(Object.prototype);
  });
});

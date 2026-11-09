/**
 * The rule `pack-no-buildinfo` on fixture repositories, and the build info path of tsc after the `extends` chain.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runChecks, runFix, type RuleResult } from "./index.ts";
import { packedBy } from "./rules/pack-no-buildinfo.ts";
import { buildInfoFile } from "./tsconfig.ts";

const temp = mkdtempSync(join(tmpdir(), "conventions-buildinfo-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
let count = 0;

/** The presets of a cue in `node_modules`: base turns on composite and incremental, lib writes the build info in dist. */
const PRESETS: Record<string, unknown> = {
  "node_modules/fake-cue/package.json": { name: "fake-cue", version: "1.0.0" },
  "node_modules/fake-cue/ts/config/base.json": { compilerOptions: { composite: true, incremental: true } },
  "node_modules/fake-cue/ts/config/lib.json": {
    extends: "./base.json",
    compilerOptions: { outDir: "${configDir}/dist", rootDir: "${configDir}/src", tsBuildInfoFile: "${configDir}/dist/.tsbuildinfo" },
  },
};

/** The text of a `package.json` as the CLI of cue writes it, with `files` on a line for each entry. */
const manifest = (fields: Record<string, unknown>): string => `${JSON.stringify({ name: "@x/lib", version: "1.0.1", ...fields }, null, 2)}\n`;

/** This function writes a repository of one package, and gives its root. */
function repo(files: Record<string, unknown>): string {
  const root = join(temp, String(count++));
  for (const [file, value] of Object.entries({ ...PRESETS, ...files })) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
  }
  return root;
}

const LIB = { extends: "fake-cue/ts/config/lib.json" };

function check(root: string): RuleResult {
  const result = runChecks({ root, only: ["pack-no-buildinfo"], today: "2026-12-01" }).rules[0];
  if (result === undefined) throw new Error("no result");
  return result;
}

describe("pack-no-buildinfo", () => {
  it("breaks on the shape of splay-react 1.0.1, and fix adds the negation after dist", () => {
    const root = repo({ "package.json": manifest({ files: ["dist"] }), "tsconfig.json": LIB });
    const result = check(root);
    expect(result.status).toBe("break");
    expect(result.breaks.map((item) => [item.file, item.line, item.message])).toEqual([
      ["package.json", 4, 'npm packs dist/.tsbuildinfo, the build info file of tsconfig.json, by the entry "dist" of "files" of @x/lib.'],
    ]);
    runFix({ root, only: ["pack-no-buildinfo"] });
    expect(readFileSync(join(root, "package.json"), "utf8")).toBe(manifest({ files: ["dist", "!dist/.tsbuildinfo"] }));
    expect(check(root).status).toBe("pass");
  });

  it("examines a published root next to the private packages of its workspace, and a public package of the workspace", () => {
    const root = repo({
      "package.json": manifest({ files: ["dist"] }),
      "tsconfig.json": LIB,
      "pnpm-workspace.yaml": 'packages:\n  - "site"\n  - "packages/*"\n',
      "site/package.json": manifest({ name: "site", private: true }),
      "site/tsconfig.json": LIB,
      "packages/b/package.json": manifest({ name: "@x/b", files: ["dist", "src"] }),
      "packages/b/tsconfig.json": { extends: "../../node_modules/fake-cue/ts/config/lib.json" },
    });
    expect(check(root).breaks.map((item) => item.file)).toEqual(["package.json", "packages/b/package.json"]);
  });

  it("puts the negation after its entry in a list on one line, and keeps CRLF", () => {
    const text = '{\r\n  "name": "@x/lib",\r\n  "version": "1.0.1",\r\n  "files": ["src", "dist", "README.md"]\r\n}\r\n';
    const root = repo({ "package.json": text, "tsconfig.json": LIB });
    runFix({ root, only: ["pack-no-buildinfo"] });
    expect(readFileSync(join(root, "package.json"), "utf8")).toBe(text.replace('"dist", ', '"dist", "!dist/.tsbuildinfo", '));
  });

  it("passes with the negation in each place of the list, and with a glob that does not take the file", () => {
    for (const files of [["dist", "!dist/.tsbuildinfo"], ["!dist/.tsbuildinfo", "dist"], ["dist/**/*.js", "dist/**/*.d.ts"]]) {
      expect(check(repo({ "package.json": manifest({ files }), "tsconfig.json": LIB })).status).toBe("pass");
    }
  });

  it("breaks on a package with no field files, with no edit, because npm then packs each file", () => {
    const result = check(repo({ "package.json": manifest({}), "tsconfig.json": LIB }));
    expect(result.status).toBe("break");
    expect(result.breaks[0]?.message).toBe('@x/lib has no field "files", so npm packs dist/.tsbuildinfo, the build info file of tsconfig.json.');
    expect(result.breaks[0]?.edits).toBeUndefined();
  });

  it("passes when tsc writes no build info, when the file is outside the packed folders, and for a private package", () => {
    const off = { ...LIB, compilerOptions: { composite: false, incremental: false } };
    expect(check(repo({ "package.json": manifest({ files: ["dist"] }), "tsconfig.json": off })).status).toBe("pass");
    for (const tsBuildInfoFile of ["${configDir}/node_modules/.cache/lib.tsbuildinfo", "./.cache/lib.tsbuildinfo"]) {
      const config = { ...LIB, compilerOptions: { tsBuildInfoFile } };
      expect(check(repo({ "package.json": manifest({ files: ["dist"] }), "tsconfig.json": config })).status).toBe("pass");
    }
    expect(check(repo({ "package.json": manifest({ private: true }), "tsconfig.json": LIB })).status).toBe("pass");
  });

  it("is skipped when it cannot read the extends chain", () => {
    const result = check(repo({ "package.json": manifest({ files: ["dist"] }), "tsconfig.json": { extends: "missing-cue/ts/config/lib.json" } }));
    expect(result.status).toBe("skipped");
    expect(result.note).toContain("tsconfig.json");
  });
});

describe("the build info file of tsc", () => {
  const at = (compilerOptions: Record<string, unknown>, extend = "fake-cue/ts/config/base.json"): string | null | undefined => {
    const root = repo({ "pkg/tsconfig.json": { extends: extend, compilerOptions } });
    const found = buildInfoFile(join(root, "pkg", "tsconfig.json"));
    return typeof found === "string" ? found.slice(join(root, "pkg").length + 1).replace(/\\/g, "/") : found;
  };

  it("follows the defaults of tsc", () => {
    expect(at({ outDir: "dist" })).toBe("dist/tsconfig.tsbuildinfo");
    expect(at({ outDir: "dist", rootDir: "src" })).toBe("tsconfig.tsbuildinfo");
    expect(at({})).toBe("tsconfig.tsbuildinfo");
    expect(at({ outFile: "out/all.js" })).toBe("out/all.tsbuildinfo");
    // composite turns on the incremental build, also with incremental false
    expect(at({ incremental: false, outDir: "dist" })).toBe("dist/tsconfig.tsbuildinfo");
    expect(at({ composite: false, incremental: false })).toBeNull();
    expect(at({}, "missing-cue/base.json")).toBeUndefined();
  });

  it("reads a path relative to the config that sets it, and ${configDir} as the folder of the tsconfig", () => {
    expect(at({}, "fake-cue/ts/config/lib.json")).toBe("dist/.tsbuildinfo");
    const root = repo({ "pkg/tsconfig.json": { extends: "../shared.json" }, "shared.json": { compilerOptions: { incremental: true, tsBuildInfoFile: "./cache/all.tsbuildinfo" } } });
    expect(buildInfoFile(join(root, "pkg", "tsconfig.json"))).toBe(join(root, "cache", "all.tsbuildinfo"));
  });

  it("finds the entry that packs a path", () => {
    expect(packedBy(["src", "dist/"], "dist/.tsbuildinfo")).toBe(1);
    expect(packedBy(["./dist/*"], "dist/.tsbuildinfo")).toBe(0);
    expect(packedBy(["dist", "!dist/*.tsbuildinfo"], "dist/.tsbuildinfo")).toBe(-1);
    expect(packedBy(["distribution"], "dist/.tsbuildinfo")).toBe(-1);
  });

  // The results of npm pack --dry-run of npm 11.19 with the files dist/.tsbuildinfo, dist/a.tsbuildinfo and dist/index.js
  it("reads a negation with no slash as a name at each depth, as npm does", () => {
    expect(packedBy(["dist", "!*.tsbuildinfo"], "dist/.tsbuildinfo")).toBe(-1);
    expect(packedBy(["dist", "!**/*.tsbuildinfo"], "dist/.tsbuildinfo")).toBe(-1);
    expect(packedBy(["dist", "!.tsbuildinfo"], "dist/.tsbuildinfo")).toBe(-1);
    expect(packedBy(["dist", "!dist/"], "dist/.tsbuildinfo")).toBe(-1);
    // A negation with a slash stays at its place: it does not remove dist/a.tsbuildinfo
    expect(packedBy(["dist", "!dist/.tsbuildinfo"], "dist/a.tsbuildinfo")).toBe(0);
    expect(packedBy(["dist", "!lib/*.tsbuildinfo"], "dist/.tsbuildinfo")).toBe(0);
    expect(packedBy(["dist", "!*.map"], "dist/.tsbuildinfo")).toBe(0);
  });
});

// The map of homes and the command map.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { findHomes, HOMES, mapMarkdown, mergeHomes, onNpm, runCli, type CliIo, type Home } from "./index.ts";

const temp = mkdtempSync(join(tmpdir(), "conventions-map-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));

function cli(args: string[]): { code: number; stdout: string; stderr: string } {
  let stdout = "";
  let stderr = "";
  const io: CliIo = { cwd: temp, env: {}, stdout: (text) => (stdout += text), stderr: (text) => (stderr += text) };
  return { code: runCli(args, io), stdout, stderr };
}

describe("the homes", () => {
  it("have unique areas, a repository and packages that agree with the state", () => {
    const areas = HOMES.map((home) => home.area);
    expect(new Set(areas).size).toBe(areas.length);
    for (const home of HOMES) {
      expect(home.area).toMatch(/^[a-z]+(-[a-z]+)*$/);
      expect(home.repo).toMatch(/^mark1russell7\/[A-Za-z0-9._-]+$/);
      if (home.state === "published") expect(home.packages.length, home.area).toBeGreaterThan(0);
      if (home.state === "planned" || home.state === "none") expect(home.packages, home.area).toEqual([]);
    }
  });

  it("give each package one home", () => {
    const names = HOMES.flatMap((home) => home.packages);
    expect(new Set(names).size).toBe(names.length);
  });

  it("give each signature one home, so a break names one home", () => {
    const signatures = HOMES.flatMap((home) => (home.signatures ?? []).map((signature) => `${signature} (${home.area})`));
    const bare = signatures.map((text) => text.slice(0, text.indexOf(" (")));
    const twice = signatures.filter((_, index) => bare.indexOf(bare[index] ?? "") !== index || bare.lastIndexOf(bare[index] ?? "") !== index);
    expect(twice).toEqual([]);
  });

  it("name in notOnNpm only some packages of a published home", () => {
    for (const home of HOMES.filter((each) => each.notOnNpm !== undefined)) {
      const notOnNpm = home.notOnNpm ?? [];
      expect(home.state, home.area).toBe("published");
      expect(notOnNpm.length, home.area).toBeGreaterThan(0);
      expect(notOnNpm.length, `${home.area}: when no package is on npm, the state is unpublished`).toBeLessThan(home.packages.length);
      for (const name of notOnNpm) expect(home.packages, home.area).toContain(name);
    }
  });

  it("mark only the package that is not on npm", () => {
    const home: Home = { area: "x", title: "X", covers: "x", packages: ["@ex/a", "@ex/b"], repo: "mark1russell7/x", state: "published", words: [], notOnNpm: ["@ex/b"] };
    expect(onNpm(home, "@ex/a")).toBe(true);
    expect(onNpm(home, "@ex/b")).toBe(false);
    expect(onNpm({ ...home, state: "unpublished", notOnNpm: [] }, "@ex/a")).toBe(false);
    expect(mapMarkdown([home])).toContain("| X | `@ex/a`, `@ex/b` (not on npm) | x |");
  });
});

describe("the search", () => {
  it("finds the home of a word, best match first", () => {
    expect(findHomes("quantile")[0]?.area).toBe("statistics");
    expect(findHomes("seeded random")[0]?.area).toBe("random");
    expect(findHomes("math")[0]?.area).toBe("exact-math");
    expect(findHomes("line break")[0]?.area).toBe("text");
    expect(findHomes("atomic write")[0]?.area).toBe("system-io");
    expect(findHomes("expand home")[0]?.area).toBe("files");
    expect(findHomes("html escape")[0]?.area).toBe("plain-text");
    expect(findHomes("camel case")[0]?.area).toBe("plain-text");
    expect(findHomes("event emitter")[0]?.area).toBe("data-structures");
    expect(findHomes("worker pool")[0]?.area).toBe("service");
    expect(findHomes("channel")[0]?.area).toBe("service");
    expect(findHomes("baggage")[0]?.area).toBe("browser-monitoring");
    expect(findHomes("strategy grammar")[0]?.area).toBe("strategy-space");
    expect(findHomes("strategy combinator")[0]?.area).toBe("strategy-space");
    expect(findHomes("context manager")[0]?.area).toBe("browser-monitoring");
    expect(findHomes("tracing")[0]?.area).toBe("browser-monitoring");
    expect(findHomes("nothing-like-this")).toEqual([]);
    expect(findHomes("")).toBe(HOMES);
  });
});

describe("the overlay", () => {
  it("adds homes, and a home of the overlay takes the place of a home with its area", () => {
    const extra: Home[] = [{ area: "statistics", title: "Other", covers: "x", packages: [], repo: "mark1russell7/other", state: "planned", words: [] }];
    const merged = mergeHomes(HOMES, extra);
    expect(merged.length).toBe(HOMES.length);
    expect(merged.find((home) => home.area === "statistics")?.repo).toBe("mark1russell7/other");
  });
});

describe("the command map", () => {
  it("writes the table with the rule, and each home once", () => {
    const { code, stdout } = cli(["map", "--markdown"]);
    expect(code).toBe(0);
    expect(stdout).toBe(mapMarkdown());
    expect(stdout).toMatch(/^Before you write a helper, find its home in this map\./);
    expect(stdout).toContain("| Statistics | `@mark1russell7/rigor-statistics` |");
    expect(stdout).toContain("| Benchmarks and speed gates | `mark1russell7/rigor` (planned) |");
  });

  it("finds the areas of words, and reads an overlay", () => {
    expect(cli(["map", "quantile"]).stdout).toMatch(/^Statistics \(statistics\): @mark1russell7\/rigor-statistics\n/);
    expect(cli(["map", "nothing-like-this"]).stdout).toMatch(/^No area matches\./);
    const file = join(temp, "private.json");
    writeFileSync(file, JSON.stringify({ homes: [{ area: "secret-app", title: "A private app", covers: "x", packages: [], repo: "mark1russell7/private", state: "unpublished", words: ["secret"] }] }));
    const json = JSON.parse(cli(["map", "secret", "--json", "--overlay", file]).stdout) as Home[];
    expect(json.map((home) => home.area)).toEqual(["secret-app"]);
  });

  it("gives exit code 2 for a wrong argument and 1 for a bad overlay", () => {
    expect(cli(["map", "--nope"]).code).toBe(2);
    expect(cli(["map", "--overlay"]).code).toBe(2);
    const file = join(temp, "bad.json");
    writeFileSync(file, "{}");
    expect(cli(["map", "--overlay", file]).code).toBe(1);
  });
});

// The map of homes and the command map.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { findHomes, HOMES, mapMarkdown, mapText, mergeHomes, npmDrift, npmNames, OWNERS, runCli, type CliIo, type Home, type NpmPresence } from "./index.ts";

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
      expect(home.area).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      const [owner = "", name = "", ...more] = home.repo.split("/");
      expect(OWNERS.map((item) => item.login), home.area).toContain(owner);
      expect(name, home.area).toMatch(/^[A-Za-z0-9._-]+$/);
      expect(more, home.area).toEqual([]);
      if (home.state === "published") expect(home.packages.length, home.area).toBeGreaterThan(0);
      if (home.state === "planned" || home.state === "none") expect(home.packages, home.area).toEqual([]);
      if (home.state === "published" || home.state === "unpublished") for (const name of home.pending ?? []) expect(home.packages, `${home.area} ${name}`).toContain(name);
      if (home.state === "published") expect(home.pending?.length ?? 0, home.area).toBeLessThan(home.packages.length);
    }
  });

  it("give each package one home", () => {
    const names = HOMES.flatMap((home) => home.packages);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("the search", () => {
  it("finds the home of a word, best match first", () => {
    expect(findHomes("quantile")[0]?.area).toBe("statistics");
    expect(findHomes("seeded random")[0]?.area).toBe("random");
    expect(findHomes("math")[0]?.area).toBe("exact-math");
    expect(findHomes("simplex")[0]?.area).toBe("exact-math");
    expect(findHomes("linear program")[0]?.area).toBe("exact-math");
    expect(findHomes("line break")[0]?.area).toBe("text");
    expect(findHomes("atomic write")[0]?.area).toBe("system-io");
    expect(findHomes("expand home")[0]?.area).toBe("files");
    expect(findHomes("zip archive")[0]?.area).toBe("files");
    expect(findHomes("unzip")[0]?.area).toBe("files");
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
    expect(findHomes("telemetry capture")[0]?.area).toBe("test-generation");
    expect(findHomes("in-memory exporter")[0]?.area).toBe("test-generation");
    expect(findHomes("otel capture")[0]?.area).toBe("test-generation");
    expect(findHomes("mutation")[0]?.area).toBe("test-generation");
    expect(findHomes("stryker")[0]?.area).toBe("test-generation");
    expect(findHomes("render check")[0]?.area).toBe("repo-structure");
    expect(findHomes("result")[0]?.area).toBe("optional");
    expect(findHomes("pushover")[0]?.area).toBe("notifications");
    expect(findHomes("text message")[0]?.area).toBe("notifications");
    expect(findHomes("geohash")[0]?.area).toBe("geography");
    expect(findHomes("latitude longitude")[0]?.area).toBe("geography");
    expect(findHomes("common alerting protocol")[0]?.area).toBe("alerts");
    expect(findHomes("sqlite quarantine")[0]?.area).toBe("local-database");
    expect(findHomes("corrupt database")[0]?.area).toBe("local-database");
    expect(findHomes("sqlite read transaction")[0]?.area).toBe("local-database");
    expect(findHomes("escalation")[0]?.area).toBe("alerts");
    expect(findHomes("canonical json")[0]?.area).toBe("random");
    expect(findHomes("content hash")[0]?.area).toBe("random");
    expect(findHomes("orientation")[0]?.area).toBe("exact-math");
    expect(findHomes("sqlite")[0]?.area).toBe("local-database");
    expect(findHomes("toxiproxy")[0]?.area).toBe("network-labs");
    expect(findHomes("iptables dead peer")[0]?.area).toBe("network-labs");
    expect(findHomes("kind cluster")[0]?.area).toBe("network-labs");
    expect(findHomes("network fault injection")[0]?.area).toBe("network-labs");
    expect(findHomes("docker compose")[0]?.area).toBe("network-labs");
    expect(findHomes("traceroute")[0]?.area).toBe("network-diagnosis");
    expect(findHomes("dns lookup jitter")[0]?.area).toBe("network-diagnosis");
    expect(findHomes("three.js")[0]?.area).toBe("3d-stages");
    expect(findHomes("camera picking")[0]?.area).toBe("3d-stages");
    expect(findHomes("lens timeline")[0]?.area).toBe("3d-stages");
    expect(findHomes("gltf")[0]?.area).toBe("room-view");
    expect(findHomes("apartment model")[0]?.area).toBe("room-view");
    expect(findHomes("viewer")[0]?.area).toBe("3d-stages");
    expect(findHomes("3d marks")[0]?.area).toBe("3d-stages");
    expect(findHomes("heat map")[0]?.area).toBe("3d-stages");
    expect(findHomes("anchor add-on")[0]?.area).toBe("room-view");
    expect(findHomes("circuit breaker")[0]?.area).toBe("electrical");
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
    expect(stdout).toContain("| Benchmarks and speed gates | `@mark1russell7/rigor-bench` |");
    expect(stdout).toContain("`@mark1russell7/rational`, `@mark1russell7/expression` (not on npm), `@mark1russell7/linear` |");
  });

  it("finds the areas of words, and reads an overlay", () => {
    expect(cli(["map", "quantile"]).stdout).toMatch(/^Statistics \(statistics\): @mark1russell7\/rigor-statistics\n/);
    expect(cli(["map", "nothing-like-this"]).stdout).toMatch(/^No area matches\./);
    const file = join(temp, "private.json");
    writeFileSync(file, JSON.stringify({ homes: [{ area: "secret-app", title: "A private app", covers: "x", packages: [], repo: "mark1russell7/private", state: "unpublished", words: ["zz-overlay-only"] }] }));
    const json = JSON.parse(cli(["map", "zz-overlay-only", "--json", "--overlay", file]).stdout) as Home[];
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

describe("the map against npm", () => {
  const home = (area: string, state: Home["state"], packages: string[], pending?: string[]): Home => ({ area, title: area, covers: "x", packages, repo: `mark1russell7/${area}`, state, words: [], ...(pending === undefined ? {} : { pending }) });
  const on: NpmPresence = { onNpm: true };
  const off: NpmPresence = { onNpm: false };

  it("asks npm for each package and each pending name once", () => {
    expect(npmNames([home("a", "published", ["@s/a", "@s/b"], ["@s/b"]), home("c", "planned", [], ["@s/c"])])).toEqual(["@s/a", "@s/b", "@s/c"]);
    expect(npmNames()).toContain("@mark1russell7/geo");
  });

  it("finds no difference when each name agrees with npm", () => {
    const homes = [home("a", "published", ["@s/a", "@s/b"], ["@s/b"]), home("u", "unpublished", ["@s/u"]), home("p", "planned", [], ["@s/p"])];
    expect(npmDrift(homes, new Map([["@s/a", on], ["@s/b", off], ["@s/u", off], ["@s/p", off]]))).toEqual([]);
  });

  it("finds each kind of difference", () => {
    const homes = [home("a", "published", ["@s/a", "@s/b"], ["@s/b"]), home("u", "unpublished", ["@s/u"]), home("p", "planned", [], ["@s/p"]), home("q", "planned", [])];
    const found = npmDrift(homes, new Map<string, NpmPresence>([["@s/a", off], ["@s/b", on], ["@s/u", on], ["@s/p", { error: "HTTP 503" }]]));
    expect(found.map((drift) => [drift.area, drift.kind, drift.name])).toEqual([
      ["a", "missing", "@s/a"],
      ["a", "stale-pending", "@s/b"],
      ["u", "stale-state", "@s/u"],
      ["p", "no-read", "@s/p"],
      ["q", "unnamed", undefined],
    ]);
    expect(found[3]?.text).toContain("HTTP 503");
  });

  it("reads a name with no answer as no read, never as a pass", () => {
    expect(npmDrift([home("a", "published", ["@s/a"])], new Map()).map((drift) => drift.kind)).toEqual(["no-read"]);
  });

  it("marks a pending package of a published home as not on npm in the table and the text", () => {
    const homes = [home("a", "published", ["@s/a", "@s/b"], ["@s/b"])];
    expect(mapMarkdown(homes)).toContain("| a | `@s/a`, `@s/b` (not on npm) | x |");
    expect(mapText(homes)).toContain("a (a): @s/a, @s/b (not on npm)");
  });
});

// The list of the owners: one entry for each login, the pool of each plan, and the helpers of the readers.
import { describe, expect, it } from "vitest";
import { OWNERS, ownerOf, ownersOf, repoKeyer, sharedNames } from "./index.ts";

describe("the owners", () => {
  it("has one entry for each login, the personal account first, with the pool of each plan", () => {
    expect(OWNERS[0]?.kind).toBe("user");
    expect(new Set(OWNERS.map((owner) => owner.login.toLowerCase())).size).toBe(OWNERS.length);
    for (const owner of OWNERS) expect(owner.jobs, owner.login).toBe(owner.plan === "team" ? 60 : 40);
    expect(ownerOf("METROGRAPH-LABS")?.jobs).toBe(60);
    expect(ownerOf("someone-else")).toBeUndefined();
  });

  it("reads a list of logins, and gives each owner for an empty list", () => {
    expect(ownersOf(" a , b,,a ")).toEqual(["a", "b"]);
    expect(ownersOf("")).toEqual(OWNERS.map((owner) => owner.login));
    expect(ownersOf(undefined)).toEqual(OWNERS.map((owner) => owner.login));
  });

  it("finds a repository name that two owners have, with no regard to case", () => {
    const repos = [
      { owner: "mark1russell7", name: "codeatlas" },
      { owner: "metrograph-labs", name: "CodeAtlas" },
      { owner: "mark1russell7", name: "vex" },
      { owner: "mark1russell7", name: "vex" },
    ];
    expect(sharedNames(repos)).toEqual(["codeatlas"]);
  });

  it("keys a repository by its name, and a name that two owners have by owner/name (11-22)", () => {
    // At 01:12 UTC on 11-22 a fork with the same name in the organization stopped each fleet reader that keyed by the name.
    const repos = [
      { owner: "mark1russell7", name: "runner-gate-test" },
      { owner: "metrograph-labs", name: "Runner-Gate-Test" },
      { owner: "mark1russell7", name: "vex" },
    ];
    const keyOf = repoKeyer(repos);
    expect(repos.map(keyOf)).toEqual(["mark1russell7/runner-gate-test", "metrograph-labs/Runner-Gate-Test", "vex"]);
    expect(new Set(repos.map(keyOf)).size).toBe(repos.length);
    expect(keyOf({ owner: "metrograph-labs", name: "highways" })).toBe("highways");
    expect(keyOf({ owner: "someone-else", name: "RUNNER-GATE-TEST" })).toBe("someone-else/RUNNER-GATE-TEST");
    expect(repoKeyer([])({ owner: "mark1russell7", name: "vex" })).toBe("vex");
  });
});

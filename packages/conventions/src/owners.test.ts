// The list of the owners: one entry for each login, the pool of each plan, and the helpers of the readers.
import { describe, expect, it } from "vitest";
import { OWNERS, ownerOf, ownersOf, sharedNames } from "./index.ts";

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
});

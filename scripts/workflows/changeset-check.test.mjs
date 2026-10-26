// Tests of the rules of the changeset check (.github/actions/changeset-check/check.mjs).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  evaluate,
  globToRegExp,
  packageJsonChanged,
  parseChangeset,
} from "../../.github/actions/changeset-check/check.mjs";

const packages = [
  { name: "root", dir: ".", version: "0.0.0", private: true },
  { name: "@x/a", dir: "packages/a", version: "0.4.1", private: false },
  { name: "@x/b", dir: "packages/b", version: "1.2.0", private: false },
  { name: "@x/site", dir: "packages/site", version: "0.0.0", private: true },
];

test("a changed package with no changeset fails, and the message names it", () => {
  const r = evaluate({ packages, changedFiles: ["packages/a/src/index.ts"], changesets: [] });
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /@x\/a/);
});

test("a changeset for the changed package passes", () => {
  const r = evaluate({
    packages,
    changedFiles: ["packages/a/src/index.ts", ".changeset/one.md"],
    changesets: [{ file: ".changeset/one.md", releases: { "@x/a": "patch" } }],
  });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.rows, [{ name: "@x/a", changed: true, bump: "patch" }]);
});

test("tests, Markdown, fixtures and private packages need no changeset", () => {
  const r = evaluate({
    packages,
    changedFiles: [
      "packages/a/src/index.test.ts",
      "packages/a/README.md",
      "packages/a/test/helpers.ts",
      "packages/b/fixtures/x.json",
      "packages/site/src/app.ts",
      "docs/guide.md",
      ".github/workflows/ci.yml",
    ],
    changesets: [],
  });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.rows, []);
});

test("the ignore input adds globs", () => {
  const r = evaluate({
    packages,
    changedFiles: ["packages/a/bench/run.ts"],
    changesets: [],
    ignore: ["bench/**"],
  });
  assert.deepEqual(r.errors, []);
});

test("a package.json change of only devDependencies or scripts needs no changeset", () => {
  const before = { name: "@x/a", version: "0.4.1", dependencies: { y: "^1.0.0" }, devDependencies: { z: "^1.0.0" } };
  assert.equal(packageJsonChanged(before, { ...before, devDependencies: { z: "^2.0.0" }, scripts: { t: "x" } }), false);
  assert.equal(packageJsonChanged(before, { ...before, dependencies: { y: "^2.0.0" } }), true);
  assert.equal(packageJsonChanged(undefined, before), true);
  const r = evaluate({
    packages,
    changedFiles: ["packages/a/package.json"],
    packageJsonChanges: { "packages/a/package.json": false },
    changesets: [],
  });
  assert.deepEqual(r.errors, []);
});

test("an empty changeset or the label no-changeset says that no release is needed", () => {
  const empty = evaluate({
    packages,
    changedFiles: ["packages/a/src/index.ts"],
    changesets: [{ file: ".changeset/none.md", releases: {} }],
  });
  assert.deepEqual(empty.errors, []);
  assert.equal(empty.notes.length, 1);
  const label = evaluate({ packages, changedFiles: ["packages/a/src/index.ts"], changesets: [], labels: ["no-changeset"] });
  assert.ok(label.skipped);
});

test("the version pull request of changesets is skipped", () => {
  const r = evaluate({ packages, changedFiles: ["packages/a/package.json"], changesets: [], headRef: "changeset-release/main" });
  assert.ok(r.skipped);
});

test("major on a 0.x package fails unless the label release-1.0 is on the pull request", () => {
  const input = {
    packages,
    changedFiles: ["packages/a/src/index.ts"],
    changesets: [{ file: ".changeset/big.md", releases: { "@x/a": "major" } }],
  };
  const r = evaluate(input);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /1\.0\.0/);
  assert.deepEqual(evaluate({ ...input, labels: ["release-1.0"] }).errors, []);
  // major on a 1.x package is a normal breaking change
  assert.deepEqual(
    evaluate({
      packages,
      changedFiles: ["packages/b/src/index.ts"],
      changesets: [{ file: ".changeset/big.md", releases: { "@x/b": "major" } }],
    }).errors,
    [],
  );
});

test("a changeset that names an unknown package, or that does not parse, fails", () => {
  const r = evaluate({
    packages,
    changedFiles: [],
    changesets: [
      { file: ".changeset/typo.md", releases: { "@x/aa": "patch" } },
      { file: ".changeset/bad.md", error: "it has no front matter (--- ... ---)" },
    ],
  });
  assert.equal(r.errors.length, 2);
});

test("a fixed group before 1.0 with a minor gets the note of a breaking change", () => {
  const group = [
    { name: "@g/one", dir: "packages/one", version: "0.38.0", private: false },
    { name: "@g/two", dir: "packages/two", version: "0.38.0", private: false },
  ];
  const r = evaluate({
    packages: group,
    changedFiles: ["packages/one/src/x.ts"],
    changesets: [{ file: ".changeset/k.md", releases: { "@g/one": "minor" } }],
    fixed: [["@g/one", "@g/two"]],
  });
  assert.deepEqual(r.errors, []);
  assert.match(r.notes.join(" "), /minor release from 0\.38\.0: a breaking change/);
});

test("a file belongs to the deepest package folder", () => {
  const nested = [
    { name: "@x/root", dir: ".", version: "1.0.0", private: false },
    { name: "@x/inner", dir: "packages/inner", version: "1.0.0", private: false },
  ];
  const r = evaluate({ packages: nested, changedFiles: ["packages/inner/src/a.ts", "src/b.ts"], changesets: [] });
  assert.match(r.errors[0], /@x\/inner, @x\/root/);
});

test("parseChangeset reads the front matter", () => {
  assert.deepEqual(parseChangeset('---\n"@x/a": minor\n\'@x/b\': patch\n---\n\nText.\n'), { "@x/a": "minor", "@x/b": "patch" });
  assert.deepEqual(parseChangeset("---\n---\n"), {});
  assert.throws(() => parseChangeset("no front matter"));
  assert.throws(() => parseChangeset('---\n"@x/a": huge\n---\n'));
});

test("globToRegExp matches folders with **", () => {
  assert.ok(globToRegExp("**/*.md").test("README.md"));
  assert.ok(globToRegExp("**/*.md").test("packages/a/docs/x.md"));
  assert.ok(globToRegExp("**/test/**").test("packages/a/test/x/y.ts"));
  assert.ok(!globToRegExp("**/test/**").test("packages/a/testing/y.ts"));
  assert.ok(globToRegExp("bench/**").test("bench/run.ts"));
});

test("in a fixed group, a changeset of one member covers the other changed members, with a note", () => {
  const group = [
    { name: "@g/one", dir: "packages/one", version: "0.38.0", private: false },
    { name: "@g/two", dir: "packages/two", version: "0.38.0", private: false },
    { name: "@x/solo", dir: "packages/solo", version: "0.1.0", private: false },
  ];
  const r = evaluate({
    packages: group,
    changedFiles: ["packages/one/src/x.ts", "packages/two/src/y.ts", "packages/solo/src/z.ts"],
    changesets: [{ file: ".changeset/k.md", releases: { "@g/one": "patch" } }],
    fixed: [["@g/one", "@g/two"]],
  });
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /@x\/solo/);
  assert.doesNotMatch(r.errors[0], /@g\/two/);
  assert.match(r.notes.join(" "), /also release @g\/two/);
});

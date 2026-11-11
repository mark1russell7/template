// Makes a test repository for the action release-check (the job release-check of actions-test.yml).
//
//   node .github/actions/release-check/fixture.ts <case> <folder>
//
// The repository has one package: the files of the latest version of @mark1russell7/boundaries on npm, in
// packages/boundaries. Its package.json has no devDependencies and no scripts, so the build does nothing and pnpm
// packs the same files. The script writes the name and the version to GITHUB_OUTPUT (name, version). The cases:
//
//   same                The files of the version on npm. The check passes.
//   changed             README.md changes, at the version on npm. The check fails.
//   greater             README.md changes, and the version is the next patch. The check passes.
//   none                The package is private: no published package. The check passes with a notice.
//   changesets-pending  Changesets, and a changeset raises the package. README.md changes. The check passes.
//   changesets-missing  Changesets, and no changeset. README.md changes. The check fails.
//
// After the script, "pnpm install --lockfile-only" in the folder writes the lockfile.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tarballFiles } from "../../../scripts/release/unchanged.ts";

const NAME = "@mark1russell7/boundaries";
const CASES = ["same", "changed", "greater", "none", "changesets-pending", "changesets-missing"];

const [kind, folder] = process.argv.slice(2);
if (kind === undefined || folder === undefined || !CASES.includes(kind)) {
  process.stderr.write(`usage: node fixture.ts <${CASES.join("|")}> <folder>\n`);
  process.exit(2);
}

const registry = `https://registry.npmjs.org/${NAME.replace("/", "%2f")}`;
const latest = (await (await fetch(`${registry}/latest`)).json()) as { version: string; dist: { tarball: string } };
const response = await fetch(latest.dist.tarball);
if (!response.ok) throw new Error(`The registry gave HTTP ${response.status} for ${latest.dist.tarball}.`);
const files = tarballFiles(Buffer.from(await response.arrayBuffer()));

const write = (path: string, content: string | Buffer): void => {
  mkdirSync(dirname(join(folder, path)), { recursive: true });
  writeFileSync(join(folder, path), content);
};

// The root of the test repository: the pnpm of the template, and one small development dependency. Thus the install
// fills the pnpm store, as in a real repository, and the cache step of setup-node has a folder to save.
const template = JSON.parse(readFileSync(join(import.meta.dirname, "../../../package.json"), "utf8")) as { packageManager: string };
const root = { name: "release-check-fixture", private: true, packageManager: template.packageManager, devDependencies: { ms: "2.1.3" } };
write("package.json", `${JSON.stringify(root, null, 2)}\n`);
write("pnpm-workspace.yaml", "packages:\n  - packages/*\nautoInstallPeers: false\n");

const manifest = JSON.parse((files.get("package.json") ?? Buffer.from("{}")).toString("utf8")) as Record<string, unknown>;
delete manifest["devDependencies"];
delete manifest["scripts"];
if (kind === "none") manifest["private"] = true;
let version = latest.version;
if (kind === "greater") {
  const [major, minor, patch] = latest.version.split(/[.+-]/u).map(Number);
  version = `${major}.${minor}.${(patch ?? 0) + 1}`;
  manifest["version"] = version;
}
for (const [path, content] of files) if (path !== "package.json") write(`packages/boundaries/${path}`, content);
write("packages/boundaries/package.json", `${JSON.stringify(manifest, null, 2)}\n`);

if (kind !== "same" && kind !== "none") {
  const readme = files.get("README.md")?.toString("utf8") ?? "";
  write("packages/boundaries/README.md", `${readme}\nA line that the version on npm does not have.\n`);
}
if (kind.startsWith("changesets-")) {
  write(".changeset/config.json", `${JSON.stringify({ fixed: [], access: "public", baseBranch: "main" }, null, 2)}\n`);
  write(".changeset/README.md", "# Changesets\n");
  if (kind === "changesets-pending") write(".changeset/fix-readme.md", `---\n"${NAME}": patch\n---\n\nA line in README.md.\n`);
}

const output = process.env["GITHUB_OUTPUT"];
if (output) appendFileSync(output, `name=${NAME}\nversion=${version}\n`);
process.stdout.write(`${kind}: ${NAME}@${version} in ${folder}\n`);

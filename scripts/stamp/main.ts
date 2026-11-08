/** The command of the stamp. `stamp.ts` has the work, and its test does not start this file. */
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { checkStamp, stamp } from "./stamp.ts";

/** This function gives the newest version of an npm package, from the registry. */
function npmLatest(name: string): string {
  return execFileSync("npm", ["view", name, "version"], { encoding: "utf8", shell: process.platform === "win32" }).trim();
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    description: { type: "string" },
    npm: { type: "string" },
    out: { type: "string" },
    ref: { type: "string", default: "origin/main" },
    check: { type: "string" },
  },
});
const template = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

// --check <folder>: one JSON line for each file of KEEP that the stamp would change, and exit code 1 if there is one.
// It writes nothing and uses no network, so it does not fetch the ref either.
if (values.check !== undefined) {
  const { sha, files } = checkStamp({ repo: resolve(values.check), template, ref: values.ref });
  const behind = files.filter((file) => file.state !== "same");
  for (const file of behind) console.log(JSON.stringify({ ...file, template: sha }));
  process.exit(behind.length > 0 ? 1 : 0);
}

const [name] = positionals;
if (!name || !values.description) {
  throw new Error('Usage: node scripts/stamp/main.ts <name> --description "<one line>" [--npm <package>] [--out <folder>] [--ref <commit>], or --check <folder> [--ref <commit>]');
}
const out = resolve(values.out ?? join(template, "..", name));
// The default takes the newest main, whichever branch the clone has
if (values.ref === "origin/main") execFileSync("git", ["-C", template, "fetch", "-q", "origin", "main"], { stdio: "inherit" });
const sha = await stamp({ name, description: values.description, npm: values.npm, template, out, ref: values.ref, latest: npmLatest });
console.log(`Created ${out} from the template commit ${sha}.`);
console.log("Next: pnpm install, then commit. Then gh repo create, and set the Pages source:");
console.log(`  gh api -X POST repos/mark1russell7/${name}/pages -f build_type=workflow`);
console.log("Turn on the dependency graph, or dependency-review fails on each pull request:");
console.log(`  gh api -X PUT repos/mark1russell7/${name}/vulnerability-alerts`);

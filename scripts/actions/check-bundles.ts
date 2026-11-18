// The check of the bundles of the shared actions (.github/actions/bundles). The script check:actions of the root writes the
// bundles again with build:actions, then starts this script. It fails when git sees a change of the folder: a change of
// the source of a bundle needs the new bundle in the same commit.
import { execFileSync } from "node:child_process";

const status = execFileSync("git", ["status", "--porcelain", "--ignored", "--untracked-files=all", "--", ".github/actions/bundles"], { encoding: "utf8" });
if (status.trim() === "") {
  process.stdout.write("The bundles of .github/actions/bundles are current.\n");
} else {
  process.stderr.write(`A bundle of .github/actions/bundles is not current. Start pnpm build:actions and commit the bundles:\n${status}`);
  process.exitCode = 1;
}

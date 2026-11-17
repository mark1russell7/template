// The sites of the audit of the live sites (site-audit.yml, the job sites). They are the public repositories with a Pages
// site that are not archived, of each owner of the package conventions. The input sites names some of them, and the input
// skip takes some out. It needs no install: it imports only node: modules and the list of the owners, which has no import.
//
//   SITES=a,b SKIP=c GH_TOKEN=... node scripts/workflows/site-list.ts
//
// It writes two outputs into GITHUB_OUTPUT: list, the names of the sites in order (JSON), and owners, the owner of each
// name (a JSON object). A named site that no owner has, or a name that two owners have, gives exit code 1.
import { execFileSync } from "node:child_process";
import { appendFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { OWNERS, sharedNames } from "../../packages/conventions/src/owners.ts";

/** A public repository with a Pages site. */
export interface Site {
  readonly owner: string;
  readonly name: string;
}

/** The sites of the audit: their names in order, the owner of each name, and the errors. */
export interface SiteList {
  readonly list: string[];
  readonly owners: Record<string, string>;
  readonly errors: string[];
}

/** This function reads a list with commas, with no space around a part and no empty part. */
export function listOf(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * This function gives the sites of the audit from the sites of the owners. With names, it gives only the named sites, in
 * the order of the names. It takes out each site to skip. A name has no regard to case, as on GitHub.
 */
export function siteList(found: readonly Site[], named: readonly string[], skip: readonly string[]): SiteList {
  const errors = sharedNames(found).map((name) => `More than one owner has a site with the name ${name}.`);
  const byName = new Map(found.map((site) => [site.name.toLowerCase(), site]));
  const chosen: Site[] = [];
  if (named.length > 0) {
    for (const name of named) {
      const site = byName.get(name.toLowerCase());
      if (site === undefined) errors.push(`No owner has a public site with the name ${name}.`);
      else chosen.push(site);
    }
  } else {
    chosen.push(...[...found].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)));
  }
  const out = new Set(skip.map((name) => name.toLowerCase()));
  const sites = chosen.filter((site, at) => !out.has(site.name.toLowerCase()) && chosen.indexOf(site) === at);
  return { list: sites.map((site) => site.name), owners: Object.fromEntries(sites.map((site) => [site.name, site.owner])), errors };
}

/** This function reads the public sites of an owner that are not archived, with `gh api`. */
function sitesOf(owner: string): Site[] {
  const text = execFileSync(
    "gh",
    ["api", "--paginate", `users/${owner}/repos?per_page=100`, "--jq", ".[] | select(.has_pages and (.private | not) and (.archived | not)) | {owner: .owner.login, name} | tojson"],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, env: { ...process.env, MSYS_NO_PATHCONV: "1" } },
  );
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Site);
}

function main(): number {
  const result = siteList(
    OWNERS.flatMap((owner) => sitesOf(owner.login)),
    listOf(process.env["SITES"]),
    listOf(process.env["SKIP"]),
  );
  for (const error of result.errors) process.stdout.write(`::error title=Site audit%3A the sites::${error}\n`);
  process.stdout.write(`${String(result.list.length)} sites: ${result.list.join(" ")}\n`);
  const output = process.env["GITHUB_OUTPUT"];
  if (output !== undefined && output !== "") appendFileSync(output, `list=${JSON.stringify(result.list)}\nowners=${JSON.stringify(result.owners)}\n`);
  return result.errors.length > 0 ? 1 : 0;
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = main();
}

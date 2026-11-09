/**
 * The rule `service-run-main`: in a server package, only the entry `src/main.ts` starts the service with `run()`. A
 * server package is a package with a dependency on `@mark1russell7/service` and a file `src/main.ts`, as the preset
 * `service` of `pnpm package add` writes it. The other source files declare the service and give it to the entry.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { byCode } from "../workspace.ts";
import { codePackages, hasFile, inFolder, type Break, type Rule } from "../rule.ts";
import { isTestFile } from "./tsconfig-test.ts";

/** The package of the service. */
export const SERVICE_PACKAGE = "@mark1russell7/service";

/** An import of the service package or of one of its entries. The groups are the name of the entry, if it has one. */
const SERVICE_IMPORT = /\bfrom\s+["']@mark1russell7\/service(?:\/([^"']*))?["']|\bimport\s*\(\s*["']@mark1russell7\/service(?:\/([^"']*))?["']\s*\)/g;

/**
 * The entries of the service package that give only tools: no service and no part of one. A value of these entries can
 * have its own `run`, for example the pool of `/channel`. Each other entry, a new entry too, counts as an entry of a
 * service, so the rule stays strict.
 */
const TOOL_ENTRIES: ReadonlySet<string> = new Set(["channel", "clock", "heartbeat", "backoff", "limiter", "rules"]);

/** This function tells if a source text imports the root of the service package, or an entry that is not a tool entry. */
function importsService(text: string): boolean {
  for (const match of text.matchAll(SERVICE_IMPORT)) {
    const entry = match[1] ?? match[2];
    if (entry === undefined || !TOOL_ENTRIES.has(entry)) return true;
  }
  return false;
}

/** A call of `run(` on a value, but not on `this`. */
const RUN_CALL = /(?<!\bthis)\.run\s*\(/;

/** The source files that the rule reads. */
const SOURCE = /\.(c|m)?tsx?$/;

/**
 * This function gives the lines (from 1) of the calls of `run(` in a source text that imports the service package. A
 * text that imports only the tool entries (`/channel`, `/clock`, `/heartbeat`, `/backoff`, `/limiter`, `/rules`) has
 * no calls: those entries give no service.
 */
export function runCalls(text: string): number[] {
  if (!importsService(text)) return [];
  const found: number[] = [];
  text.split(/\r?\n/).forEach((line, index) => {
    const comment = line.indexOf("//");
    const code = comment < 0 ? line : line.slice(0, comment);
    const trimmed = code.trimStart();
    if (trimmed.startsWith("*") || trimmed.startsWith("/*")) return;
    if (RUN_CALL.test(code)) found.push(index + 1);
  });
  return found;
}

/** This function tells if a manifest has a dependency on the service package. */
const dependsOnService = (manifest: Readonly<Record<string, unknown>>): boolean => {
  const dependencies = manifest["dependencies"];
  return typeof dependencies === "object" && dependencies !== null && SERVICE_PACKAGE in dependencies;
};

export const serviceRunMain: Rule = {
  id: "service-run-main",
  title: "In a server package, only the entry `src/main.ts` starts the service with `run()`.",
  reason:
    "run() of @mark1russell7/service owns the process: it starts the listeners, it reads the signals, and it ends the process. A module that starts it cannot be imported by a test or by a second entry without a second server. When only the entry starts it, each other module gives a service that a test can start, check and stop.",
  fix: "Move the call of run() to src/main.ts. Export the service (or a function that makes it) from the module, and start it in the entry.",
  sources: [
    { repo: "template", rule: "service-preset", doc: "CLAUDE.md: make a server package with --preset=service; only its entry src/main.ts uses run() of @mark1russell7/service" },
    { repo: "template", rule: "service-preset", doc: "packages/cli/src/commands/package/add.ts: the preset service writes src/main.ts and the script start" },
    { repo: "systems", rule: "service-run-main", doc: "packages/reference/src/main.ts:3: only this file starts run()" },
    { repo: "vex", rule: "service-run-main", doc: "packages/mcp/src/main.ts: the one call of run() of the package" },
  ],
  options: {
    main: { type: "string", default: "src/main.ts", description: "The entry of a server package, the one file that starts the service." },
  },
  check(context, options) {
    const main = typeof options["main"] === "string" ? options["main"] : "src/main.ts";
    const tracked = context.gitFiles();
    if (tracked === undefined) return { skipped: "the root is not in a git repository" };
    const breaks: Break[] = [];
    for (const info of codePackages(context)) {
      if (!dependsOnService(info.manifest) || !hasFile(info.dir, main)) continue;
      const prefix = info.folder === "" ? "" : `${info.folder}/`;
      const entry = inFolder(info.folder, main);
      const own = tracked.filter((path) => path.startsWith(`${prefix}src/`) && SOURCE.test(path) && !/\.d\.(c|m)?ts$/.test(path) && path !== entry && !isTestFile(path.slice(prefix.length)));
      for (const file of own.sort(byCode)) {
        let text: string;
        try {
          text = readFileSync(join(context.root, file), "utf8");
        } catch {
          continue;
        }
        for (const line of runCalls(text)) breaks.push({ file, line, message: `${file} starts the service with run(). In a server package only ${entry} does.` });
      }
    }
    return breaks;
  },
};

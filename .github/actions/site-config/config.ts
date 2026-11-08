// The site config of a repository: the one home of the inputs of its site build (CI.md, "The site config").
//
// The file .github/site.json of the repository holds them. reusable-pages.yml (build and deploy) and
// reusable-pages-check.yml (the check of a pull request) both read it with this script. Thus the two workflows build
// the same site, and each value has one home.
//
// A repository with no file gives the old inputs of reusable-pages.yml. The script then takes them, so an old caller
// keeps its site. A repository that has the file and also gives the input build gets an error: each value has one home.
//
// In each string value, {owner} is the owner of the repository and {repo} is its name.
import { appendFileSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The type of a key: a string, a boolean or a map of environment variables. */
type Kind = "string" | "boolean" | "env";

/** The keys of the site config, with their types and their defaults. The defaults are those of reusable-pages.yml. */
export const SITE_KEYS = {
  build: { kind: "string", default: "" },
  out: { kind: "string", default: "" },
  env: { kind: "env", default: {} },
  "github-token": { kind: "boolean", default: false },
  "node-version": { kind: "string", default: "26" },
  "node-version-file": { kind: "string", default: "" },
  "site-pages": { kind: "boolean", default: true },
  "site-pages-version": { kind: "string", default: "" },
  roadmap: { kind: "string", default: "" },
  base: { kind: "string", default: "" },
  packages: { kind: "string", default: "" },
  changesets: { kind: "string", default: "" },
  group: { kind: "string", default: "" },
  css: { kind: "string", default: "" },
  "site-name": { kind: "string", default: "" },
  "data-only": { kind: "boolean", default: false },
  "data-stamps": { kind: "string", default: "" },
  "site-check": { kind: "boolean", default: false },
  "site-check-pages": { kind: "string", default: "" },
  "site-check-widths": { kind: "string", default: "" },
  "site-check-probe": { kind: "string", default: "" },
  "site-check-playwright": { kind: "string", default: "1.64.1" },
  "site-bar": { kind: "boolean", default: false },
  "site-bar-pages": { kind: "string", default: "" },
  "site-bar-npm": { kind: "string", default: "" },
  "scroll-cue": { kind: "boolean", default: true },
  "indexnow-key": { kind: "string", default: "" },
} as const satisfies Record<string, { kind: Kind; default: string | boolean | Record<string, string> }>;

export type SiteKey = keyof typeof SITE_KEYS;
export type SiteConfig = { [K in SiteKey]: (typeof SITE_KEYS)[K]["kind"] extends "boolean" ? boolean : (typeof SITE_KEYS)[K]["kind"] extends "env" ? Record<string, string> : string };

/** The input of {@link resolveConfig}. */
export interface ConfigInput {
  /** The text of .github/site.json, or undefined when the repository has no such file. */
  readonly file: string | undefined;
  /** The path of the file, for the messages. */
  readonly path: string;
  /** The inputs of the workflow (toJSON(inputs)), or undefined when the workflow has no old inputs. */
  readonly inputs: Readonly<Record<string, unknown>> | undefined;
  /** The repository, "owner/name". */
  readonly repository: string;
}

export type ConfigResult = { readonly config: SiteConfig; readonly source: "file" | "inputs" } | { readonly error: string };

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** This function puts the owner and the name of the repository in for {owner} and {repo}. */
export function fill(value: string, repository: string): string {
  const [owner = "", repo = ""] = repository.split("/");
  return value.replaceAll("{owner}", owner).replaceAll("{repo}", repo);
}

/** This function checks one value against the type of its key, and gives the value or an error. */
function check(key: SiteKey, value: unknown, where: string, repository: string): { value: SiteConfig[SiteKey] } | { error: string } {
  const kind: Kind = SITE_KEYS[key].kind;
  if (kind === "boolean") {
    return typeof value === "boolean" ? { value } : { error: `${where}: "${key}" must be true or false.` };
  }
  if (kind === "string") {
    return typeof value === "string" ? { value: fill(value, repository) } : { error: `${where}: "${key}" must be a string.` };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return { error: `${where}: "env" must be an object of strings.` };
  const env: Record<string, string> = {};
  for (const [name, text] of Object.entries(value)) {
    if (!NAME.test(name)) return { error: `${where}: "${name}" of "env" is not a name of an environment variable.` };
    if (typeof text !== "string") return { error: `${where}: the value of "${name}" of "env" must be a string.` };
    env[name] = fill(text, repository);
  }
  return { value: env };
}

/** This function gives the site config of a repository from its file, or from the old inputs when it has no file. */
export function resolveConfig(input: ConfigInput): ConfigResult {
  const config = Object.fromEntries(Object.entries(SITE_KEYS).map(([key, spec]) => [key, spec.default])) as Record<SiteKey, unknown>;
  let source: "file" | "inputs";
  if (input.file !== undefined) {
    if (typeof input.inputs?.["build"] === "string" && input.inputs["build"] !== "") {
      return { error: `The repository has ${input.path} and the workflow also gives the input build. Give the site values only in ${input.path}.` };
    }
    let data: unknown;
    try {
      data = JSON.parse(input.file);
    } catch (error) {
      return { error: `${input.path} is not JSON: ${(error as Error).message}` };
    }
    if (data === null || typeof data !== "object" || Array.isArray(data)) return { error: `${input.path} must be a JSON object.` };
    for (const [key, value] of Object.entries(data)) {
      if (key === "$schema" || key === "$comment") continue;
      if (!Object.hasOwn(SITE_KEYS, key)) return { error: `${input.path}: "${key}" is not a key of the site config. CI.md tells the keys.` };
      const checked = check(key as SiteKey, value, input.path, input.repository);
      if ("error" in checked) return checked;
      config[key as SiteKey] = checked.value;
    }
    source = "file";
  } else if (input.inputs !== undefined) {
    for (const key of Object.keys(SITE_KEYS) as SiteKey[]) {
      let value = input.inputs[key];
      if (value === undefined) continue;
      // The input env of reusable-pages.yml is a JSON string, and an empty string means no variables.
      if (key === "env") {
        if (value === "") continue;
        try {
          value = JSON.parse(String(value));
        } catch (error) {
          return { error: `The input env is not JSON: ${(error as Error).message}` };
        }
      }
      const checked = check(key, value, "the inputs", input.repository);
      if ("error" in checked) return checked;
      config[key] = checked.value;
    }
    source = "inputs";
  } else {
    return { error: `The repository has no ${input.path}. The check of the site needs the file (CI.md, "The site config").` };
  }
  for (const key of ["build", "out"] as const) {
    if (config[key] === "") {
      const home = source === "file" ? input.path : "the inputs of the workflow";
      return { error: `${home} gives no "${key}". The site config needs "build" and "out".` };
    }
  }
  return { config: config as SiteConfig, source };
}

/** This function starts the step: it reads the file and the inputs, and writes the output config. */
function main(env: NodeJS.ProcessEnv = process.env): number {
  const path = env["CONFIG_PATH"] ?? ".github/site.json";
  const root = env["CONFIG_ROOT"] ?? ".";
  const full = `${root}/${path}`;
  let inputs: Record<string, unknown> | undefined;
  if (env["INPUTS"] !== undefined && env["INPUTS"] !== "") {
    try {
      inputs = JSON.parse(env["INPUTS"]) as Record<string, unknown>;
    } catch (error) {
      console.log(`::error::The inputs are not JSON: ${(error as Error).message}`);
      return 1;
    }
  }
  const result = resolveConfig({
    file: existsSync(full) ? readFileSync(full, "utf8") : undefined,
    path,
    inputs,
    repository: env["GITHUB_REPOSITORY"] ?? "",
  });
  if ("error" in result) {
    console.log(`::error::${result.error}`);
    return 1;
  }
  console.log(result.source === "file" ? `The site config is ${path}.` : `The repository has no ${path}, so the site config is the inputs of the workflow.`);
  // JSON.stringify gives one line, because it escapes each line break of a value.
  appendFileSync(env["GITHUB_OUTPUT"] ?? "", `config=${JSON.stringify(result.config)}\nsource=${result.source}\n`);
  return 0;
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = main();
}

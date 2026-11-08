/**
 * The site config of a repository: the one home of the inputs of its site build (CI.md, "The site config").
 *
 * The file `.github/site.json` of the repository holds them. `reusable-pages.yml` (build and deploy) and
 * `reusable-pages-check.yml` (the check of a pull request) read it with `main.ts` of this folder. Thus the two
 * workflows build the same site, and each value has one home. The rules of `@mark1russell7/conventions` read it too.
 *
 * A repository with no file gives the old inputs of `reusable-pages.yml`, and the resolver takes them. Thus an old
 * caller keeps its site. A repository that has the file and also gives the input `build` gets an error.
 *
 * In each string value, `{owner}` is the owner of the repository and `{repo}` is its name. This file imports nothing,
 * so the workflow starts it from the template commit with no install.
 */

/** The path of the site config in a repository. */
export const SITE_CONFIG_PATH = ".github/site.json";

/** The type of a key: a string, a boolean or a map of environment variables. */
export type SiteConfigKind = "string" | "boolean" | "env";

/** The site config: a value for each key. CI.md tells each key. */
export interface SiteConfig {
  /** The command that builds the site. It is the one necessary key, with `out`. */
  readonly build: string;
  /** The folder of the built site. */
  readonly out: string;
  /** The environment variables of the build. `{owner}` and `{repo}` change in each value. */
  readonly env: Readonly<Record<string, string>>;
  /** `true` gives the build the token of the job as `GITHUB_TOKEN`. */
  readonly "github-token": boolean;
  /** The Node.js version of the build. */
  readonly "node-version": string;
  /** A file with the Node.js version, for example `.nvmrc`. It replaces `node-version`. */
  readonly "node-version-file": string;
  /** `true` adds the Releases page and the Status page. */
  readonly "site-pages": boolean;
  /** The npm version of site-pages for its pages. Empty uses the template commit. */
  readonly "site-pages-version": string;
  /** The roadmap file of the Status page, for example `docs/ROADMAP.md`. */
  readonly roadmap: string;
  /** The base path of the site, for example `/{repo}/`. */
  readonly base: string;
  /** The npm packages of the Releases page, with commas between them. */
  readonly packages: string;
  /** The folder of the changesets of the Status page. */
  readonly changesets: string;
  /** The group of the pages of the site. */
  readonly group: string;
  /** A style file of the site for the pages of site-pages. */
  readonly css: string;
  /** The name of the site in the bar and in the titles. */
  readonly "site-name": string;
  /** `true` writes only the data files of the pages, with no HTML. */
  readonly "data-only": boolean;
  /** A file of data stamps, for the freshness gate. */
  readonly "data-stamps": string;
  /** `true` checks the pages in a browser at each width. */
  readonly "site-check": boolean;
  /** The pages of the site check, with commas between them. */
  readonly "site-check-pages": string;
  /** The widths of the site check, with commas between them. */
  readonly "site-check-widths": string;
  /** A probe script of the site check. */
  readonly "site-check-probe": string;
  /** The Playwright version of the site check. */
  readonly "site-check-playwright": string;
  /** `true` gives each page the bar of the site. */
  readonly "site-bar": boolean;
  /** The pages of the bar, with commas between them. */
  readonly "site-bar-pages": string;
  /** The npm name of the package of the site, for the npm link of the bar. */
  readonly "site-bar-npm": string;
  /** `true` gives each code block the scroll cue. */
  readonly "scroll-cue": boolean;
  /** A key of IndexNow. After each deploy that is not scheduled, the URLs go to the engines. */
  readonly "indexnow-key": string;
}

/** A key of the site config. */
export type SiteConfigKey = keyof SiteConfig;

/** The type and the default of one key. The defaults are those of the inputs of `reusable-pages.yml`. */
export interface SiteConfigKeySpec<T> {
  readonly kind: SiteConfigKind;
  readonly default: T;
}

/** The keys of the site config, with their types and their defaults. */
export const SITE_CONFIG_KEYS: { readonly [K in SiteConfigKey]: SiteConfigKeySpec<SiteConfig[K]> } = {
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
};

/** The input of {@link resolveSiteConfig}. */
export interface SiteConfigInput {
  /** The text of .github/site.json, or undefined when the repository has no such file. */
  readonly file: string | undefined;
  /** The path of the file, for the messages. */
  readonly path: string;
  /** The inputs of the workflow (toJSON(inputs)), or undefined when the workflow has no old inputs. */
  readonly inputs: Readonly<Record<string, unknown>> | undefined;
  /** The repository, "owner/name". */
  readonly repository: string;
}

/** The site config and its source, or an error. */
export type SiteConfigResult = { readonly config: SiteConfig; readonly source: "file" | "inputs" } | { readonly error: string };

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** This function puts the owner and the name of the repository in for {owner} and {repo}. */
export function fillRepository(value: string, repository: string): string {
  const [owner = "", repo = ""] = repository.split("/");
  return value.replaceAll("{owner}", owner).replaceAll("{repo}", repo);
}

/** This function checks one value against the type of its key, and gives the value or an error. */
function check(key: SiteConfigKey, value: unknown, where: string, repository: string): { value: SiteConfig[SiteConfigKey] } | { error: string } {
  const kind: SiteConfigKind = SITE_CONFIG_KEYS[key].kind;
  if (kind === "boolean") {
    return typeof value === "boolean" ? { value } : { error: `${where}: "${key}" must be true or false.` };
  }
  if (kind === "string") {
    return typeof value === "string" ? { value: fillRepository(value, repository) } : { error: `${where}: "${key}" must be a string.` };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return { error: `${where}: "env" must be an object of strings.` };
  const env: Record<string, string> = {};
  for (const [name, text] of Object.entries(value)) {
    if (!NAME.test(name)) return { error: `${where}: "${name}" of "env" is not a name of an environment variable.` };
    if (typeof text !== "string") return { error: `${where}: the value of "${name}" of "env" must be a string.` };
    env[name] = fillRepository(text, repository);
  }
  return { value: env };
}

/** This function gives the site config of a repository from its file, or from the old inputs when it has no file. */
export function resolveSiteConfig(input: SiteConfigInput): SiteConfigResult {
  const config = Object.fromEntries(Object.entries(SITE_CONFIG_KEYS).map(([key, spec]) => [key, spec.default])) as Record<SiteConfigKey, unknown>;
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
      if (!Object.hasOwn(SITE_CONFIG_KEYS, key)) return { error: `${input.path}: "${key}" is not a key of the site config. CI.md tells the keys.` };
      const checked = check(key as SiteConfigKey, value, input.path, input.repository);
      if ("error" in checked) return checked;
      config[key as SiteConfigKey] = checked.value;
    }
    source = "file";
  } else if (input.inputs !== undefined) {
    for (const key of Object.keys(SITE_CONFIG_KEYS) as SiteConfigKey[]) {
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

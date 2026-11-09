// The map of homes: for each area of code, the one package where that code lives.
import { readFileSync } from "node:fs";

/** The state of a home: on npm, in a repository but not on npm, only on a roadmap, or with no package. */
export type HomeState = "published" | "unpublished" | "planned" | "none";

/** One area of code and its home. */
export interface Home {
  /** The id of the area, in kebab case. */
  readonly area: string;
  /** The area in a few plain words. */
  readonly title: string;
  /** The code that belongs in the home. */
  readonly covers: string;
  /** The packages of the home. A planned home has no package yet. */
  readonly packages: readonly string[];
  /** The repository of the home, as owner/name. */
  readonly repo: string;
  /** The state of the home. */
  readonly state: HomeState;
  /** More words that find the area in a search. */
  readonly words: readonly string[];
  /**
   * The names of the functions that only the home has: each is a regular expression of a whole name, for example `median(Of)?`.
   * The rule home-package of conventions breaks on a new function with such a name in another repository. Names that many
   * areas use (for example `parse` or `record`) are not signatures: they give false breaks.
   */
  readonly signatures?: readonly string[];
  /** A note: the code that goes to another home, or a known split. */
  readonly note?: string;
}

/** The rule of the map. Each session and each review applies it. */
export const MAP_RULE =
  "Before you write a helper, find its home in this map. If the home does not have the function, add it to the home, in a pull request of the home repository. Do not make a local copy, a new package or a new repository for an area that has a home: that needs the strategist. A home that is not on npm is used with workspace:* or a github: specifier pinned to a commit. If no area fits, ask the strategist for a home before you write the code.";

/** The public homes. Each package that other code can use has one area. */
export const HOMES: readonly Home[] = [
  {
    area: "statistics",
    title: "Statistics",
    covers: "quantiles, medians, means, SD, bootstrap intervals, sign and permutation tests, Holm, Wilson, Brier, calibration, correlation, noise floors, fits of laws to values, likelihoods, mixtures",
    packages: ["@mark1russell7/rigor-statistics"],
    repo: "mark1russell7/rigor",
    state: "published",
    words: ["stats", "quantile", "median", "mean", "percentile", "bootstrap", "interval", "confidence", "p-value", "brier", "wilson", "holm", "spearman", "kendall", "noise", "stddev", "variance", "resample", "resampling", "bonferroni", "regression", "histogram", "pvalue", "significance", "welch", "ttest", "mann", "whitney", "pearson", "correlation"],
    signatures: ["quantiles?", "percentiles?", "median(Of)?", "std[Dd]ev", "standardDeviation", "variance", "bootstrap(?:Median|Mean|Interval|Ci|CI|Quantile|Percentile|Ratio|Diff|Difference|Samples?|Resamples?)?", "wilson[A-Za-z0-9]*", "holm[A-Za-z0-9]*", "brier[A-Za-z0-9]*", "spearman[A-Za-z0-9]*", "kendall[A-Za-z0-9]*", "signTest", "pairedPermutation", "permutationTest", "noiseFloor", "iqr"],
  },
  {
    area: "random",
    title: "Seeded random and generated inputs",
    covers: "seeded random numbers, seeds from names, hashes for seeds, draws, input families with dimensions and ranges",
    packages: ["@mark1russell7/rigor-generators"],
    repo: "mark1russell7/rigor",
    state: "published",
    words: ["seed", "prng", "mulberry32", "fnv", "hash", "shuffle", "sample", "fixture", "generator", "random", "rng", "seeded", "xorshift", "splitmix", "latin", "hypercube", "saltelli", "sobol", "halton", "sampler"],
    signatures: ["mulberry32", "splitmix[A-Za-z0-9]*", "xorshift[A-Za-z0-9]*", "sfc32", "xoshiro[A-Za-z0-9]*", "fnv1a[A-Za-z0-9]*", "deriveSeed", "seededRandom", "seededRng", "makeRng", "createRng"],
  },
  {
    area: "bench",
    title: "Benchmarks and speed gates",
    covers: "the bench harness: a fresh process per case, the order turned each round, A/A pairs, the CPU model, paired-time records, speed gates, determinism gates",
    packages: [],
    repo: "mark1russell7/rigor",
    state: "planned",
    words: ["benchmark", "harness", "timing", "perf", "gate", "paired-time", "a/a", "warm-up", "bench", "measure", "timer", "stopwatch", "profile", "elapsed", "hrtime", "determinism", "deterministic", "baseline", "ratchet", "threshold"],
    note: "Five repositories have their own harness today (vex, packing, highways, layout-stack, typeset). Do not grow a local harness: the shared one replaces them.",
  },
  {
    area: "test-generation",
    title: "Test helpers and test generation",
    covers: "property tests on fast-check, pairwise and covering arrays, metamorphic relations, chaos and load schedules, shared test fixtures",
    packages: [],
    repo: "mark1russell7/rigor",
    state: "planned",
    words: ["test", "testing", "property", "fast-check", "arbitrary", "pairwise", "metamorphic", "chaos", "load", "fake", "fastcheck", "covering", "combinatorial", "fault", "injection", "soak", "stress", "throughput", "shrink"],
    note: "@mark1russell7/vex-testkit is only for Vex domains. A fake shell for tests is in @procedures/shell.",
  },
  {
    area: "exact-math",
    title: "Expressions and exact arithmetic",
    covers: "expression documents, exact rationals, floats with error bounds, intervals, robust geometric predicates (orientation, in-circle)",
    packages: ["@mark1russell7/expression", "@mark1russell7/rational"],
    repo: "mark1russell7/algebra",
    state: "unpublished",
    words: ["math", "arithmetic", "rational", "bigint", "interval", "error bound", "predicate", "orientation", "symbolic", "exact"],
    signatures: ["orient2d", "orientation", "inCircle", "incircle"],
    note: "Statistics go to rigor-statistics, and geometry records go to layout-contract. There is no math package.",
  },
  {
    area: "units",
    title: "Amounts with units",
    covers: "amounts in typed units, exact conversion factors between units",
    packages: ["@mark1russell7/quantity"],
    repo: "mark1russell7/systems",
    state: "published",
    words: ["unit", "quantity", "duration", "bytes", "conversion"],
  },
  {
    area: "state-machines",
    title: "State machines and timers",
    covers: "state machines as data, closed forms of their timers, clocks (a real clock and a test clock, @mark1russell7/algebra/clock), failure detection, recovery and trace replay",
    packages: ["@mark1russell7/algebra"],
    repo: "mark1russell7/systems",
    state: "published",
    words: ["state machine", "timer", "timeout", "heartbeat", "failover", "detection", "clock", "test clock", "fake clock"],
    note: "The npm name @mark1russell7/algebra is this package of systems, not the algebra repository.",
  },
  {
    area: "service",
    title: "Services and servers",
    covers: "a service declared as data, its lifecycle and checks, jittered loops, backoff and retries, and concurrency on the clock of algebra: channels, select, tickers, time-outs, worker pools, pipelines, fan-in and fan-out (service); the HTTP, WebSocket and MCP host of procedures (peer)",
    packages: ["@mark1russell7/service", "@procedures/peer"],
    repo: "mark1russell7/systems",
    state: "published",
    words: ["server", "http server", "lifecycle", "shutdown", "health", "loop", "backoff", "retry", "jitter", "websocket", "channel", "select", "ticker", "worker pool", "pipeline", "fan-in", "fan-out", "concurrency"],
    signatures: ["exponentialBackoff", "backoffDelay", "withRetry", "retryWithBackoff", "withJitter"],
    note: "A server package is made with the template preset service. @procedures/peer is in mark1russell7/client.",
  },
  {
    area: "procedures",
    title: "Typed calls and MCP tools",
    covers: "procedures as data: one typed call model in process, over HTTP, WebSocket, CLI and MCP, with streaming and middleware",
    packages: ["@procedures/client", "@procedures/mcp-server", "@procedures/compiler"],
    repo: "mark1russell7/client",
    state: "published",
    words: ["rpc", "procedure", "mcp", "tool", "middleware", "api client"],
  },
  {
    area: "files",
    title: "Paths and files on Node.js",
    covers: "paths, home folder expansion, a path inside a folder, finding a file up the folders, glob matching, file walks with excludes: plain functions on node: modules only, for each general package. @procedures/fs builds on them",
    packages: [],
    repo: "mark1russell7/files",
    state: "planned",
    words: ["path", "home folder", "expand home", "find up", "glob", "walk", "inside folder", "posix path"],
    signatures: ["expandHome", "findUp", "isInside", "globToRegExp", "matchesGlob"],
  },
  {
    area: "system-io",
    title: "Files, commands, git, GitHub and npm",
    covers: "atomic file and JSON writes, globs, safe commands with argv and no shell, git, the GitHub CLI and API, npm registry lookups, HTTP requests, JSON, YAML and CSV, environment variables",
    packages: ["@procedures/fs", "@procedures/shell", "@procedures/git", "@procedures/gh", "@procedures/npm", "@procedures/http", "@procedures/json", "@procedures/env"],
    repo: "mark1russell7/client",
    state: "published",
    words: ["file", "atomic", "write", "spawn", "exec", "shell", "command", "github", "registry", "fetch", "yaml", "csv", "env"],
    signatures: ["atomicWrite[A-Za-z0-9]*", "writeFileAtomic", "writeJsonAtomic", "writeAtomic"],
    note: "The plain path, glob and walk functions go to the area files (mark1russell7/files). These packages wrap them as procedures.",
  },
  {
    area: "cli",
    title: "Command-line arguments",
    covers: "argument parsing and the help text of command-line tools, from a schema",
    packages: [],
    repo: "mark1russell7/client",
    state: "planned",
    words: ["argv", "arguments", "flags", "options", "parser", "help text", "command line"],
    signatures: ["parseArgs", "parseArgv"],
    note: "Nine hand-written parsers exist (10-25). Until the library is ready, use @procedures/cli-run or keep the parser small.",
  },
  {
    area: "data-structures",
    title: "Collections and graphs of dependencies",
    covers: "lists, deques, maps, trees and heaps; DAGs, cycles, topological order; the typed event emitter that evented collections use. @procedures/collections and @procedures/dag are the same code as procedures: new code goes to @mark1russell7/collections",
    packages: ["@mark1russell7/collections", "@procedures/collections", "@procedures/dag"],
    repo: "mark1russell7/collections",
    state: "published",
    words: ["list", "queue", "deque", "heap", "tree map", "graph", "dag", "topological", "cycle", "event emitter", "emitter", "listener", "subscribe", "unsubscribe"],
    signatures: ["topoSort", "topologicalSort", "toposort", "topoOrder", "detectCycles?", "findCycles?"],
  },
  {
    area: "optional",
    title: "Optional values",
    covers: "a value that is present or absent, and Result, a value or an error (1.2.0), with the functor and monad laws",
    packages: ["@mark1russell7/optional"],
    repo: "mark1russell7/optional",
    state: "published",
    words: ["option", "maybe", "some", "none", "monad", "functor", "result", "either", "error"],
    note: "@mark1russell7/render-optional is a second copy. It moves to @mark1russell7/optional.",
  },
  {
    area: "geometry",
    title: "Geometry and layout records",
    covers: "points, boxes, segments, tolerances, the input and record formats of the layout engines, converters",
    packages: ["@mark1russell7/layout-contract"],
    repo: "mark1russell7/layout-contract",
    state: "published",
    words: ["point", "rect", "box", "segment", "polygon", "tolerance", "overlap", "intersection", "bounds"],
    signatures: ["segmentsIntersect", "segmentsCross", "segmentIntersection", "segmentsIntersection", "boxesOverlap", "rectsOverlap", "rectsIntersect", "pointInPolygon", "distanceToSegment", "pointSegmentDistance"],
    note: "Exact predicates go to algebra. @mark1russell7/vex-domains has 2D vectors for Vex formulas only.",
  },
  {
    area: "strategy-space",
    title: "Strategy spaces and grammars",
    covers: "a strategy space as data (stages, options, typed params, constraints), config checks and config ids, counts, grids and seeded samples of a space, the operator format strategy-operators/1, combinators as terms (portfolio, sequence, fallback, product), the distinctness gate",
    note: "The strategy catalog stays in layout-contract. Engines, records and probes stay in the contract and the engines.",
    packages: ["@mark1russell7/strategy-space"],
    repo: "mark1russell7/strategy-space",
    state: "published",
    words: ["strategy grammar", "strategy combinator", "operator format", "config id", "space enumeration", "distinctness gate", "racing", "seeded config sample"],
  },
  {
    area: "packing",
    title: "Rectangle packing",
    covers: "shelf, guillotine, skyline and max-rects strategies, push cascades, measures of a placement",
    packages: ["@mark1russell7/packing"],
    repo: "mark1russell7/packing",
    state: "published",
    words: ["pack", "bin packing", "placement", "rectangles", "fill"],
  },
  {
    area: "edge-routing",
    title: "Edge routing",
    covers: "edge routers for node-link diagrams: trunks, bundles, plugs and zoom levels",
    packages: ["@mark1russell7/highways"],
    repo: "mark1russell7/highways",
    state: "published",
    words: ["edge", "route", "bundle", "path", "orthogonal", "spline"],
  },
  {
    area: "graph-layout",
    title: "Graph and tree layout",
    covers: "a layout for each container of a graph or tree, with boxes and routed edges for any renderer",
    packages: ["ireko"],
    repo: "mark1russell7/ireko",
    state: "published",
    words: ["layout", "tree layout", "radial", "force", "hierarchy", "container"],
  },
  {
    area: "text",
    title: "Text measurement and line breaking",
    covers: "Unicode segmentation, text widths from font tables, line breaking, incremental relayout after edits",
    packages: [],
    repo: "mark1russell7/typeset",
    state: "planned",
    words: ["string", "unicode", "grapheme", "font", "width", "measure text", "line break", "wrap", "hyphen"],
    signatures: ["graphemes", "segmentGraphemes", "wrapText", "breakLines", "measureText", "textWidth", "stringWidth"],
    note: "Plain string helpers (escaping, case, padding, templates, English word forms) go to the area plain-text (mark1russell7/text).",
  },
  {
    area: "plain-text",
    title: "Plain text helpers",
    covers: "escaping for HTML, attributes, regular expressions and Markdown, case conversion, padding and truncation, templates, English word forms (plurals, lists). Escaping comes first",
    packages: [],
    repo: "mark1russell7/text",
    state: "planned",
    words: ["escape", "html escape", "case", "camel case", "kebab case", "pad", "truncate", "template", "plural", "slug"],
    signatures: ["escapeHtml", "escapeAttribute", "escapeRegExp", "escapeMarkdown", "kebabCase", "camelCase", "pascalCase", "snakeCase", "pluralize"],
  },
  {
    area: "language-kernel",
    title: "Declarative languages",
    covers: "documents in envelopes, evaluators found by a ladder, parsers, incremental schedulers",
    packages: ["@mark1russell7/coeval"],
    repo: "mark1russell7/coeval",
    state: "published",
    words: ["parser", "evaluator", "dsl", "language", "ast", "scheduler", "incremental"],
  },
  {
    area: "formulas",
    title: "Formulas over records",
    covers: "typed spreadsheet formulas evaluated at each record, tree node or grid cell; domains for vectors, colors, angles and numbers",
    packages: ["@mark1russell7/vex", "@mark1russell7/vex-domains", "@mark1russell7/vex-compiler"],
    repo: "mark1russell7/vex",
    state: "published",
    words: ["formula", "spreadsheet", "roll-up", "aggregate", "per record", "grid"],
  },
  {
    area: "reactive-ui",
    title: "Reactive expressions and rendering by type",
    covers: "the reactive node store and expressions of render, its viewer; splay renders any data with a viewer for each type",
    packages: ["@mark1russell7/render-dsl", "@mark1russell7/render-node", "@mark1russell7/splay"],
    repo: "mark1russell7/render",
    state: "published",
    words: ["reactive", "signal", "subscription", "viewer", "render", "react"],
    note: "@mark1russell7/splay is in mark1russell7/splay.",
  },
  {
    area: "browser-monitoring",
    title: "Observability and context",
    covers: "OpenTelemetry for browsers and Node services, and the one context of logs, metrics and traces: trace and baggage in process and across calls (otel-ts, its /context and /node entries); main-thread lag, long tasks, Web Vitals, the page lifecycle, async context in browsers",
    packages: ["@mark1russell7/otel-ts", "async-browser-context", "@mark1russell7/lag", "@mark1russell7/lag-hud", "page-lifecycle-tracker"],
    repo: "mark1russell7/otel-ts",
    state: "published",
    words: ["telemetry", "web vitals", "inp", "long task", "visibility", "opentelemetry", "async context", "observability", "baggage", "traceparent", "tracing", "span", "asynclocalstorage", "context manager"],
  },
  {
    area: "repo-structure",
    title: "Repository structure, CI and conventions",
    covers: "new repositories and packages, the CUE presets, shared CI workflows, the API report, import boundaries, the conventions check, the release and status pages",
    packages: ["@mark1russell7/conventions", "@mark1russell7/template-cli", "@mark1russell7/cue", "@mark1russell7/api-report", "@mark1russell7/boundaries", "@mark1russell7/site-pages"],
    repo: "mark1russell7/template",
    state: "published",
    words: ["template", "ci", "workflow", "tsconfig", "package.json", "lint", "site", "pages"],
  },
  {
    area: "prose",
    title: "Prose rules",
    covers: "the ASD-STE100 writing rules for Markdown and doc comments",
    packages: ["@mark1russell7/ste-lint"],
    repo: "mark1russell7/ste-lint",
    state: "published",
    words: ["docs", "readme", "writing", "ste"],
  },
  {
    area: "machine-resources",
    title: "Memory and jobs on one computer",
    covers: "leases of memory and processors for jobs, queues of heavy jobs, alerts",
    packages: [],
    repo: "mark1russell7/headroom",
    state: "unpublished",
    words: ["memory", "lease", "job", "queue", "load"],
  },
  {
    area: "releases",
    title: "Release order of the packages",
    covers: "the npm release and update plan in dependency order, provenance checks",
    packages: [],
    repo: "mark1russell7/release-train",
    state: "unpublished",
    words: ["release", "version", "semver", "provenance", "update"],
  },
  {
    area: "duplication",
    title: "The duplication atlas",
    covers: "function shapes, clone classes, shared names and packages by purpose over all public repositories",
    packages: [],
    repo: "mark1russell7/codeatlas",
    state: "unpublished",
    words: ["duplicate", "clone", "copy"],
  },
  {
    area: "web-crawling",
    title: "Web crawling",
    covers: "polite fetches with robots.txt and one request per site, a store of fetched pages",
    packages: ["polite-crawler", "polite-crawler-mcp"],
    repo: "mark1russell7/crawler",
    state: "published",
    words: ["crawl", "scrape", "robots", "fetch page"],
  },
];

/** A file of more homes, for example the private repositories, in the shape `{ "homes": Home[] }`. */
export function readOverlay(file: string): readonly Home[] {
  const data = JSON.parse(readFileSync(file, "utf8")) as { homes?: unknown };
  if (!Array.isArray(data.homes)) throw new Error(`${file}: the field "homes" must be an array`);
  for (const home of data.homes as Home[]) {
    if (typeof home.area !== "string" || typeof home.title !== "string" || typeof home.repo !== "string") throw new Error(`${file}: each home needs area, title and repo`);
  }
  return data.homes as Home[];
}

/** This function merges the homes. A home of `extra` with the area of a home of `base` takes its place. */
export function mergeHomes(base: readonly Home[], extra: readonly Home[]): readonly Home[] {
  const areas = new Set(extra.map((home) => home.area));
  return [...base.filter((home) => !areas.has(home.area)), ...extra];
}

/** This function gives the homes that match each word of `query`, best match first. */
export function findHomes(query: string, homes: readonly Home[] = HOMES): readonly Home[] {
  const terms = query.toLowerCase().split(/\s+/).filter((term) => term.length > 0);
  if (terms.length === 0) return homes;
  const score = (home: Home): number => {
    const strong = [home.area, home.title, ...home.packages, ...home.words].join(" ").toLowerCase();
    const weak = `${home.covers} ${home.note ?? ""}`.toLowerCase();
    return terms.reduce((sum, term) => sum + (strong.includes(term) ? 2 : weak.includes(term) ? 1 : 0), 0);
  };
  return homes
    .map((home, index) => ({ home, index, score: score(home) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((row) => row.home);
}

const STATE_TEXT: Record<HomeState, string> = { published: "", unpublished: " (not on npm)", planned: " (planned)", none: " (no home)" };

/** This function writes the map as a Markdown table, with the rule first. */
export function mapMarkdown(homes: readonly Home[] = HOMES): string {
  const cell = (text: string): string => text.replaceAll("|", "\\|");
  const rows = homes.map((home) => {
    const where = home.packages.length > 0 ? home.packages.map((name) => `\`${name}\``).join(", ") : `\`${home.repo}\``;
    const covers = home.note === undefined ? home.covers : `${home.covers}. ${home.note}`;
    return `| ${cell(home.title)} | ${where}${STATE_TEXT[home.state]} | ${cell(covers)} |`;
  });
  return [MAP_RULE, "", "| Area | Home | Covers |", "| --- | --- | --- |", ...rows, ""].join("\n");
}

/** This function writes the homes as plain text for a terminal. */
export function mapText(homes: readonly Home[]): string {
  if (homes.length === 0) return "No area matches. Ask the strategist for a home before you write the code.\n";
  return homes
    .map((home) => {
      const where = home.packages.length > 0 ? home.packages.join(", ") : home.repo;
      const lines = [`${home.title} (${home.area}): ${where}${STATE_TEXT[home.state]}`, `  covers: ${home.covers}`, `  repo: ${home.repo}`];
      if (home.note !== undefined) lines.push(`  note: ${home.note}`);
      return lines.join("\n");
    })
    .join("\n\n")
    .concat("\n");
}

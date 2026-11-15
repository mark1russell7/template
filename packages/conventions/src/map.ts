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
  /**
   * The other repositories that hold code of the home while it moves, as owner/name: the source or the target of the move.
   * The rule home-package does not break in them. Remove an entry when the move ends.
   */
  readonly alsoIn?: readonly string[];
  /**
   * The package names of the home that are not on npm yet. A name of a published or unpublished home is also in
   * `packages`. A planned home has no packages, so its names here are the planned names. The function `npmDrift` reads
   * each name of the map on npm.
   */
  readonly pending?: readonly string[];
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

/** The rule of the map. Each change and each review applies it. */
export const MAP_RULE: string =
  "Before you write a helper, find its home in this map. If the home does not have the function, add it to the home, in a pull request of the home repository. Do not make a local copy, a new package or a new repository for an area that has a home: that needs the maintainer. A home that is not on npm is used with workspace:* inside its own repository. In another repository, a github: specifier pinned to a commit works only for a package that keeps its built files in git. For any other package, wait for its first npm publish (ask the maintainer). If no area fits, ask the maintainer for a home before you write the code.";

/** The public homes. Each package that other code can use has one area. */
export const HOMES: readonly Home[] = [
  {
    area: "statistics",
    title: "Statistics",
    covers: "quantiles, medians, means, SD, bootstrap intervals, sign and permutation tests, Holm, Wilson, Brier, calibration, correlation, noise floors, fits of laws to values, likelihoods, mixtures",
    packages: ["@mark1russell7/rigor-statistics"],
    repo: "mark1russell7/rigor",
    alsoIn: ["mark1russell7/algebra", "mark1russell7/math"],
    state: "published",
    words: ["stats", "quantile", "median", "mean", "percentile", "bootstrap", "interval", "confidence", "p-value", "brier", "wilson", "holm", "spearman", "kendall", "noise", "stddev", "variance", "resample", "resampling", "bonferroni", "regression", "histogram", "pvalue", "significance", "welch", "ttest", "mann", "whitney", "pearson", "correlation"],
    signatures: ["quantiles?", "percentiles?", "median(Of)?", "std[Dd]ev", "standardDeviation", "variance", "bootstrap(?:Median|Mean|Interval|Ci|CI|Quantile|Percentile|Ratio|Diff|Difference|Samples?|Resamples?)?", "wilson[A-Za-z0-9]*", "holm[A-Za-z0-9]*", "brier[A-Za-z0-9]*", "spearman[A-Za-z0-9]*", "kendall[A-Za-z0-9]*", "signTest", "pairedPermutation", "permutationTest", "noiseFloor", "iqr"],
  },
  {
    area: "random",
    title: "Seeded random and generated inputs",
    covers: "seeded random numbers, seeds from names, hashes for seeds, canonical JSON (RFC 8785) and content hashes (SHA-256), draws, input families with dimensions and ranges",
    packages: ["@mark1russell7/rigor-generators"],
    repo: "mark1russell7/rigor",
    alsoIn: ["mark1russell7/algebra", "mark1russell7/math"],
    state: "published",
    words: ["seed", "prng", "mulberry32", "fnv", "hash", "shuffle", "sample", "fixture", "generator", "random", "rng", "seeded", "xorshift", "splitmix", "latin", "hypercube", "saltelli", "sobol", "halton", "sampler", "canonical json", "canonical", "content hash", "sha256", "sha-256", "rfc 8785", "jcs", "stable stringify"],
    signatures: ["mulberry32", "splitmix[A-Za-z0-9]*", "xorshift[A-Za-z0-9]*", "sfc32", "xoshiro[A-Za-z0-9]*", "fnv1a[A-Za-z0-9]*", "deriveSeed", "seededRandom", "seededRng", "makeRng", "createRng", "canonicalJson", "canonicalHash", "sha256Hex", "stableStringify", "canonicalStringify"],
  },
  {
    area: "bench",
    title: "Benchmarks and speed gates",
    covers: "the bench harness: a fresh process per case, the order turned each round, A/A pairs, the CPU model, paired-time records, speed gates, determinism gates",
    packages: ["@mark1russell7/rigor-bench"],
    repo: "mark1russell7/rigor",
    state: "published",
    words: ["benchmark", "harness", "timing", "perf", "gate", "paired-time", "a/a", "warm-up", "bench", "measure", "timer", "stopwatch", "profile", "elapsed", "hrtime", "determinism", "deterministic", "baseline", "ratchet", "threshold"],
    note: "The entry /fresh runs each arm of each pair in a fresh process, and the entry /supervise stops a case that passes its time budget. Five repositories have their own harness today (vex, packing, highways, layout-stack, typeset). Do not grow a local harness: the shared one replaces them.",
  },
  {
    area: "test-generation",
    title: "Test helpers and test generation",
    covers: "property tests on fast-check, pairwise and covering arrays, metamorphic relations, chaos and load schedules, shared test fixtures, the capture of the OpenTelemetry SDK and the propagation gate for tests",
    packages: ["@mark1russell7/rigor-testkit", "@mark1russell7/rigor-chaos", "@mark1russell7/rigor-proxy"],
    repo: "mark1russell7/rigor",
    state: "published",
    words: ["test", "testing", "property", "fast-check", "arbitrary", "pairwise", "metamorphic", "chaos", "load", "fake", "fastcheck", "covering", "combinatorial", "fault", "injection", "soak", "stress", "throughput", "shrink", "capture", "in-memory", "exporter", "testkit"],
    note: "rigor-testkit has model-based tests on fast-check, the capture of the OpenTelemetry SDK for tests (captureTelemetry, entry /otel), the propagation gate (entry /propagation) and a scripted HTTP server with a wire record of each reply (entry /http). rigor-chaos has seeded fault plans (delay, cut, reset, split frame, reorder, duplicate, stall) as data, next to its load schedules. rigor-proxy applies a plan to TCP, WebSocket and HTTP streams and records each fault. Pairwise and covering arrays and metamorphic relations are planned in mark1russell7/rigor. @mark1russell7/vex-testkit is only for Vex domains. A fake shell for tests is in @procedures/shell.",
  },
  {
    area: "exact-math",
    title: "Expressions and exact arithmetic",
    covers: "expression documents, exact rationals, floats with error bounds, intervals, robust geometric predicates (orientation, in-circle, segment intersection)",
    packages: ["@mark1russell7/predicates", "@mark1russell7/rational", "@mark1russell7/expression"],
    pending: ["@mark1russell7/expression"],
    repo: "mark1russell7/algebra",
    state: "published",
    words: ["math", "arithmetic", "rational", "bigint", "interval", "error bound", "predicate", "orientation", "segment intersection", "symbolic", "exact"],
    signatures: ["orient2d", "orientation", "inCircle", "incircle", "classifySegments"],
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
    covers: "state machines as data, closed forms of their timers, clocks (a real clock and a test clock, @mark1russell7/algebra/clock), civil time (the local time of an instant in an IANA time zone, daily and weekly windows across midnight, the next boundary of a window), failure detection, recovery and trace replay",
    packages: ["@mark1russell7/algebra"],
    repo: "mark1russell7/systems",
    state: "published",
    words: ["state machine", "timer", "timeout", "heartbeat", "failover", "detection", "clock", "test clock", "fake clock", "time zone", "local time", "quiet hours", "daylight saving"],
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
    packages: ["@mark1russell7/files"],
    repo: "mark1russell7/files",
    state: "published",
    words: ["path", "home folder", "expand home", "find up", "glob", "walk", "inside folder", "posix path"],
    signatures: ["expandHome", "findUp", "isInside", "globToRegExp", "matchesGlob"],
  },
  {
    area: "system-io",
    title: "Files, commands, git, GitHub and npm",
    covers: "atomic file and JSON writes, globs, safe commands with argv and no shell, git, the GitHub CLI and API, npm registry lookups and the use measures of a package (weekly downloads, dependents from deps.dev, jsDelivr hits, each a pure request builder and extractor with the fetch as a parameter), HTTP requests, JSON, YAML and CSV, environment variables",
    packages: ["@procedures/fs", "@procedures/shell", "@procedures/git", "@procedures/gh", "@procedures/npm", "@procedures/http", "@procedures/json", "@procedures/env"],
    repo: "mark1russell7/client",
    state: "published",
    words: ["file", "atomic", "write", "spawn", "exec", "shell", "command", "github", "registry", "fetch", "yaml", "csv", "env"],
    signatures: ["atomicWrite[A-Za-z0-9]*", "writeFileAtomic", "writeJsonAtomic", "writeAtomic"],
    note: "The plain path, glob and walk functions go to the area files (mark1russell7/files). These packages wrap them as procedures.",
  },
  {
    area: "headless-browser",
    title: "Headless browser runs",
    covers: "finding the browser of the system and its profiles, reading the bookmark files of a profile, a headless run with argv, a temporary profile, a time limit and a signal, and its output: PDF files, screenshots in PNG or JPEG, page text",
    packages: ["@procedures/browser"],
    repo: "mark1russell7/client",
    state: "published",
    words: ["browser", "chromium", "chrome", "headless", "bookmark", "bookmarks", "chrome profile", "screenshot", "pdf", "print", "png", "jpeg", "puppeteer", "playwright"],
    signatures: ["findBrowser", "renderScreenshot"],
    note: "@procedures/browser is in mark1russell7/client, and @procedures/pdf depends on it.",
  },
  {
    area: "notifications",
    title: "Push, text and voice notifications",
    covers: "the request builder and the response extractor of each notification service, with the fetch as a parameter: ntfy, Pushover (the emergency priority with retry and expire, receipts, cancel), Twilio (text messages and voice calls); the send procedure",
    packages: ["@procedures/notify"],
    repo: "mark1russell7/client",
    state: "published",
    words: ["notify", "notification", "push", "push notification", "pushover", "ntfy", "twilio", "sms", "text message", "voice call", "critical alert"],
    signatures: ["sendNotification", "callPushover", "pushoverSendRequest", "extractPushoverReceipt"],
    note: "@procedures/notify is in mark1russell7/client. ntfy and Pushover are on npm (Pushover since 0.56.0, entry /pushover). Twilio is planned. The rules of who gets what and when (rank, route, escalate) go to the area alerts.",
  },
  {
    area: "desktop",
    title: "Desktop apps on Electron",
    covers: "the safe defaults of the main process: the content security policy, window options with sandbox and context isolation, navigation and window-open rules, permission denial, the app:// protocol that serves a folder, Chromium net error codes, typed IPC checks",
    packages: ["@mark1russell7/desktop"],
    repo: "mark1russell7/desktop",
    alsoIn: ["mark1russell7/template", "mark1russell7/pairrank"],
    state: "published",
    words: ["electron", "desktop", "csp", "content security policy", "ipc", "preload", "browserwindow", "app protocol"],
    note: "The electron preset of template-cli still generates these functions in each app. Its next step is to import the package.",
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
    covers: "lists, deques, maps, trees and heaps; DAGs, cycles, topological order, strongly connected components, the minimum hitting set (the vertex cover of a hypergraph); the typed event emitter that evented collections use. @procedures/collections and @procedures/dag are the same code as procedures: new code goes to @mark1russell7/collections",
    packages: ["@mark1russell7/collections", "@procedures/collections", "@procedures/dag"],
    repo: "mark1russell7/collections",
    state: "published",
    words: ["list", "queue", "deque", "heap", "tree map", "graph", "dag", "topological", "cycle", "strongly connected", "hitting set", "vertex cover", "hypergraph", "event emitter", "emitter", "listener", "subscribe", "unsubscribe"],
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
    covers: "points, boxes, segments, tolerances, space-filling curves (Hilbert, Moore, Morton) on a grid, 3D points, boxes and transforms (planned), the input and record formats of the layout engines, converters",
    packages: ["@mark1russell7/layout-contract"],
    repo: "mark1russell7/layout-contract",
    state: "published",
    words: ["point", "rect", "box", "segment", "polygon", "tolerance", "overlap", "intersection", "bounds", "curve", "space-filling", "hilbert", "moore", "morton", "z-order"],
    signatures: ["segmentsIntersect", "segmentsCross", "segmentIntersection", "segmentsIntersection", "boxesOverlap", "rectsOverlap", "rectsIntersect", "pointInPolygon", "distanceToSegment", "pointSegmentDistance", "hilbertRank", "hilbertIndex", "hilbertCell", "d2xy", "xy2d", "mortonIndex", "mortonCode"],
    note: "Exact predicates go to algebra. @mark1russell7/vex-domains has 2D vectors for Vex formulas only.",
  },
  {
    area: "geography",
    title: "Places on the Earth",
    covers: "WGS84 points (latitude and longitude), great-circle distance and bearing, the destination from a point, a point in a polygon on the Earth, polygon overlap, buffers, bounding boxes, geohash, GeoJSON: plain functions with no dependencies",
    packages: [],
    pending: ["@mark1russell7/geo"],
    repo: "mark1russell7/geo",
    alsoIn: ["mark1russell7/client"],
    state: "planned",
    words: ["geo", "geography", "latitude", "longitude", "lat lon", "wgs84", "great circle", "haversine", "bearing", "geohash", "geojson", "nearby", "radius km"],
    signatures: ["greatCircleKm", "haversine[A-Za-z0-9]*", "geohash", "encodeGeohash", "decodeGeohash", "initialBearing"],
    note: "The planned package is @mark1russell7/geo. @procedures/geo wraps it as procedures with the geocoding, the routes and the map tiles, and its greatCircleKm and geohash move to it. Points, boxes and polygons on a plane go to geometry (layout-contract).",
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
    area: "search",
    title: "Search and optimization over a space",
    covers: "search over a strategy space: sweeps, genetic algorithms, many objectives and Pareto fronts, hard and soft constraints, a seed for each run, a record of each evaluation",
    packages: ["@mark1russell7/strategy-search"],
    repo: "mark1russell7/strategy-space",
    state: "published",
    words: ["optimizer", "optimize", "optimization", "genetic", "evolutionary", "pareto", "multi-objective", "sweep", "search", "annealing", "hill climb", "constraint solver", "tuning"],
    note: "It knows no domain. The local sweeps of the layout projects move to it.",
  },
  {
    area: "market",
    title: "Products, offers and price history",
    covers: "a live catalog of products with the offers of many sellers, the price of each offer over time, trends, one adapter for each seller (the official API first)",
    packages: [],
    pending: ["@mark1russell7/market", "@mark1russell7/market-sources"],
    repo: "mark1russell7/market",
    state: "planned",
    words: ["price", "prices", "offer", "seller", "catalog", "product", "parts", "price history", "trend", "deal", "listing", "sku"],
    note: "The planned packages are @mark1russell7/market and @mark1russell7/market-sources. Fetches go through polite-crawler, live loops through @mark1russell7/service, trend statistics through rigor-statistics.",
  },
  {
    area: "cluster-design",
    title: "Computer cluster design",
    covers: "part classes and fit rules (socket, memory type, power supply), runner capacity, watts, heat, noise, circuit load, as formulas with units over a configuration",
    packages: [],
    repo: "mark1russell7/cluster-design",
    state: "planned",
    words: ["cluster", "hardware", "pc build", "socket", "psu", "watts", "circuit", "runner capacity", "heat", "noise", "rack", "compatibility"],
    note: "It has no site facts and no prices: a site and part records are input data. Units come from quantity, roll-ups from Vex.",
  },
  {
    area: "ci-runners",
    title: "Self-hosted CI runners",
    covers: "a dispatcher of one-job runners: sources of queued jobs, trust rules as data, a provider that makes one machine for each job (Proxmox first)",
    packages: ["@mark1russell7/runner-dispatch"],
    repo: "mark1russell7/runner-dispatch",
    state: "published",
    words: ["runner", "self-hosted", "jit", "just-in-time", "ephemeral runner", "workflow_job", "dispatcher", "proxmox", "scale set", "garm", "arc"],
    note: "Loops go to @mark1russell7/service, the machine state machine to @mark1russell7/algebra. It has no site facts.",
  },
  {
    area: "room-view",
    title: "3D room viewer",
    covers: "a three.js viewer of a room model (glTF) with placed objects, outlets and circuits as data",
    packages: [],
    repo: "mark1russell7/room-view",
    state: "planned",
    words: ["3d", "three.js", "threejs", "gltf", "room", "floor plan", "scene", "outlet", "blender", "viewer"],
    note: "3D geometry records go to layout-contract.",
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
    packages: ["@mark1russell7/typeset"],
    repo: "mark1russell7/typeset",
    state: "published",
    words: ["string", "unicode", "grapheme", "font", "width", "measure text", "line break", "wrap", "hyphen"],
    signatures: ["graphemes", "segmentGraphemes", "wrapText", "breakLines", "measureText", "textWidth", "stringWidth"],
    note: "Plain string helpers (escaping, case, padding, templates, English word forms) go to the area plain-text (mark1russell7/text).",
  },
  {
    area: "plain-text",
    title: "Plain text helpers",
    covers: "escaping for HTML, attributes, regular expressions and Markdown, case conversion, padding and truncation, templates, English word forms (plurals, lists), the text of a thrown value (it never throws), the redaction of known secrets in a text (the raw form, the URL form and the Basic form). Escaping comes first",
    packages: ["@mark1russell7/text"],
    repo: "mark1russell7/text",
    state: "published",
    words: ["escape", "word search", "count", "html escape", "case", "camel case", "kebab case", "pad", "truncate", "template", "plural", "slug", "redact", "secret", "mask", "error message", "thrown value"],
    signatures: ["escapeHtml", "escapeAttribute", "escapeRegExp", "escapeMarkdown", "kebabCase", "camelCase", "pascalCase", "snakeCase", "pluralize", "redactSecrets", "errorMessage"],
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
    area: "local-database",
    title: "Databases on one computer",
    covers: "SQLite through node:sqlite: WAL, synchronous and busy-timeout settings, migrations by user_version or by a version for each part of a file, BEGIN IMMEDIATE transactions, typed append-only event logs as grow-only sets, the fault kind and the action of each SQLite error, recovery of a broken or stuck file (integrity check, quarantine, salvage of a log, snapshot), the filter of the experimental warning",
    packages: ["@mark1russell7/sqlite"],
    repo: "mark1russell7/sqlite",
    alsoIn: ["mark1russell7/headroom", "mark1russell7/crawler", "mark1russell7/pairrank"],
    state: "published",
    words: ["sqlite", "database", "event log", "migration", "wal", "user_version", "append-only", "transaction", "node:sqlite", "grow-only", "integrity check", "quarantine", "corrupt", "snapshot", "backup"],
    signatures: ["openEventLog", "salvageEventLog", "sqliteFault", "openOrQuarantine", "quietSqliteWarning"],
    note: "headroom (packages/core/src/store.ts), polite-crawler (docs.ts, hoststate.ts, vectors.ts and watch.ts in packages/polite-crawler/src) and pairrank (packages/store/src/log.ts) have their own WAL and migration code. They move to @mark1russell7/sqlite. Do not grow a local copy.",
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
    covers: "function shapes, clone classes, shared names and packages by purpose over all public repositories, and the static analysis of code for bugs, also in the repositories of others",
    packages: [],
    repo: "mark1russell7/codeatlas",
    state: "unpublished",
    words: ["duplicate", "clone", "copy", "static analysis", "analyzer"],
  },
  {
    area: "web-crawling",
    title: "Web crawling and API clients",
    covers: "polite fetches with robots.txt and one request per site, a store of fetched pages, the host schedule and the action for each outcome (succeed, park until, stop for, count a failure), polite calls of documented APIs (each method, a body, no page store), OAuth 2.0 client-credentials tokens (one grant in flight, a margin before the end, a drop after a 401)",
    packages: ["polite-crawler", "polite-crawler-mcp"],
    repo: "mark1russell7/crawler",
    state: "published",
    words: ["crawl", "scrape", "robots", "fetch page", "api client", "http client", "oauth", "client credentials", "access token", "rate limit", "retry after", "host schedule"],
    note: "Each package that calls the servers of others uses polite-crawler. The entry polite-crawler/api has the calls of documented APIs and the token store.",
  },
  {
    area: "alerts",
    title: "Alerts from many sources",
    covers: "one event format based on CAP (the Common Alerting Protocol), a source adapter for each feed (describe, fetch, map, check), the merge of duplicate reports into one incident (idempotent and order-free), priority as a calculation, routes over channels with acknowledgement and escalation, the health and coverage of each source, the fault suite of the pipeline",
    packages: [],
    pending: ["@mark1russell7/alerts"],
    repo: "mark1russell7/alerts",
    state: "planned",
    words: ["alert", "alerts", "warning", "emergency", "cap", "common alerting protocol", "incident", "escalate", "escalation", "acknowledge", "severity", "urgency", "weather alert", "coverage", "heartbeat"],
    note: "The planned packages are @mark1russell7/alerts (the core) and one package for each source and each channel. It knows no person and no place: the places and keys of a user are input data. Sending goes through @procedures/notify, fetches through polite-crawler, geography through @mark1russell7/geo, the service loop through @mark1russell7/service, fault tests through rigor-chaos and rigor-proxy.",
  },
  {
    area: "network-labs",
    title: "Network labs and fault injection",
    covers: "labs of real software on false networks: Docker topologies of clients, routers and proxies as data, faults at layers 3 and 4 in the network namespace of a container (iptables rules and tc netem from a sidecar with NET_ADMIN, the toxics of Toxiproxy), replicated groups, kind clusters with faults in the namespaces of pods, observations on one monotonic clock; planned tiers: routed fabrics in containerlab, VMs with a kernel for each node, k3s",
    packages: ["@mark1russell7/harness", "@mark1russell7/kind"],
    repo: "mark1russell7/systems",
    state: "published",
    words: ["network lab", "toxiproxy", "toxic", "netem", "tc qdisc", "iptables", "net_admin", "sidecar", "dead peer", "black hole", "latency injection", "docker compose", "testcontainers", "kind cluster", "k3s", "k3d", "containerlab", "vrnetlab", "frr", "bgp", "bfd", "qemu"],
    note: "The labs need Docker, so they run in CI. Fault plans are data in rigor-chaos: the harness applies them at layers 3 and 4, and rigor-proxy applies them to TCP, WebSocket and HTTP streams. A repository that tests a client against a faulty network uses these labs: do not grow a local compose file with a Toxiproxy or an iptables sidecar. The containerlab, VM and k3s tiers, and with them a simulated homelab, are planned in the program S7 of mark1russell7/systems.",
  },
  {
    area: "network-diagnosis",
    title: "Network diagnosis",
    covers: "the cause of a network fault at each layer (link, Wi-Fi, IP and routes, DNS, TCP, TLS, HTTP, the path through providers) and the next step: probes as adapters that give typed facts, a catalog of faults as data, the probability of each cause from the facts, the next probe by its expected information gain, the estimators of jitter, loss, delay variation, retransmission time-out and bandwidth",
    packages: [],
    pending: ["@mark1russell7/netdiag"],
    repo: "mark1russell7/netdiag",
    state: "planned",
    words: ["network diagnosis", "diagnose", "troubleshoot", "connectivity", "reachability", "unreachable", "ping", "traceroute", "mtr", "dns lookup", "nslookup", "dig", "jitter", "packet loss", "rtt", "mtu", "tls handshake", "wifi", "wi-fi", "iperf", "netdiag"],
    note: "The planned package is @mark1russell7/netdiag. Commands go through @procedures/shell, statistics through rigor-statistics, timers and backoff through @mark1russell7/algebra, scheduled checks through @mark1russell7/service. Its ground truth comes from the network labs: a lab injects each fault class, and a gate holds the hit rate of each class. It checks only the networks that its user owns or names.",
  },
];

/** A file of more homes, for example the private repositories, in the shape `{ "homes": Home[] }`. */
export function readOverlay(file: string): readonly Home[] {
  const data = JSON.parse(readFileSync(file, "utf8")) as { homes?: unknown };
  if (!Array.isArray(data.homes)) throw new Error(`${file}: the field "homes" must be an array`);
  for (const home of data.homes as Home[]) {
    if (typeof home.area !== "string" || typeof home.title !== "string" || typeof home.repo !== "string") throw new Error(`${file}: each home needs area, title and repo`);
    if (home.alsoIn !== undefined && !(Array.isArray(home.alsoIn) && home.alsoIn.every((repo) => typeof repo === "string"))) throw new Error(`${file}: alsoIn of ${home.area} must be an array of owner/name strings`);
    if (home.pending !== undefined && !(Array.isArray(home.pending) && home.pending.every((name) => typeof name === "string"))) throw new Error(`${file}: pending of ${home.area} must be an array of package names`);
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

/** What npm says of one package name: on npm or not, or no read, with the error of the read. */
export type NpmPresence = { readonly onNpm: boolean } | { readonly error: string };

/**
 * The kind of a difference between the map and npm:
 * - `missing`: a package of a published home is not on npm, and the home does not name it in `pending`.
 * - `stale-pending`: a name in `pending` is on npm. Remove it from `pending`. When it is the last planned name of a
 *   planned home, the home is published: move the names to `packages`.
 * - `stale-state`: a package of an unpublished home is on npm. The state of the home is published.
 * - `no-read`: npm gave no answer for a name. A no read is not a pass.
 * - `unnamed`: a planned home names no planned package, so nothing can be read for it.
 */
export type NpmDriftKind = "missing" | "stale-pending" | "stale-state" | "no-read" | "unnamed";

/** One difference between the map and npm. `name` is the package, absent for the kind `unnamed`. */
export interface NpmDrift {
  readonly area: string;
  readonly kind: NpmDriftKind;
  readonly name?: string;
  readonly text: string;
}

/** This function gives each package name of the homes that npm must answer for: the packages and the pending names. */
export function npmNames(homes: readonly Home[] = HOMES): readonly string[] {
  return [...new Set(homes.flatMap((home) => [...home.packages, ...(home.pending ?? [])]))];
}

/**
 * This function compares the map with the answers of npm (`facts`, by package name). A name with no answer is a no read.
 * It gives each difference, in the order of the homes. An empty list means that each name of the map agrees with npm.
 */
export function npmDrift(homes: readonly Home[], facts: ReadonlyMap<string, NpmPresence>): readonly NpmDrift[] {
  const found: NpmDrift[] = [];
  for (const home of homes) {
    const pending = new Set(home.pending ?? []);
    if (home.state === "planned" && pending.size === 0) {
      found.push({ area: home.area, kind: "unnamed", text: `${home.area}: the planned home names no package in pending, so npm cannot be read for it` });
    }
    for (const name of [...home.packages, ...[...pending].filter((name) => !home.packages.includes(name))]) {
      const fact = facts.get(name);
      if (fact === undefined || "error" in fact) {
        found.push({ area: home.area, kind: "no-read", name, text: `${home.area}: no read of ${name} on npm (${fact === undefined ? "no answer" : fact.error})` });
      } else if (pending.has(name)) {
        if (fact.onNpm) found.push({ area: home.area, kind: "stale-pending", name, text: `${home.area}: ${name} is on npm, so it leaves pending${home.state === "planned" ? " and the home moves toward published" : ""}` });
      } else if (home.state === "published" && !fact.onNpm) {
        found.push({ area: home.area, kind: "missing", name, text: `${home.area}: ${name} is not on npm, and pending does not name it` });
      } else if (home.state === "unpublished" && fact.onNpm) {
        found.push({ area: home.area, kind: "stale-state", name, text: `${home.area}: ${name} is on npm, so the state of the home is published` });
      }
    }
  }
  return found;
}

const STATE_TEXT: Record<HomeState, string> = { published: "", unpublished: " (not on npm)", planned: " (planned)", none: " (no home)" };

/** This function gives the packages of a home, each with " (not on npm)" when the home names it in `pending`. */
function packageList(home: Home, quote: (name: string) => string): string {
  const pending = new Set(home.state === "published" ? (home.pending ?? []) : []);
  return home.packages.map((name) => `${quote(name)}${pending.has(name) ? " (not on npm)" : ""}`).join(", ");
}

/** This function writes the map as a Markdown table, with the rule first. */
export function mapMarkdown(homes: readonly Home[] = HOMES): string {
  const cell = (text: string): string => text.replaceAll("|", "\\|");
  const rows = homes.map((home) => {
    const where = home.packages.length > 0 ? packageList(home, (name) => `\`${name}\``) : `\`${home.repo}\``;
    const covers = home.note === undefined ? home.covers : `${home.covers}. ${home.note}`;
    return `| ${cell(home.title)} | ${where}${STATE_TEXT[home.state]} | ${cell(covers)} |`;
  });
  return [MAP_RULE, "", "| Area | Home | Covers |", "| --- | --- | --- |", ...rows, ""].join("\n");
}

/** This function writes the homes as plain text for a terminal. */
export function mapText(homes: readonly Home[]): string {
  if (homes.length === 0) return "No area matches. Ask the maintainer for a home before you write the code.\n";
  return homes
    .map((home) => {
      const where = home.packages.length > 0 ? packageList(home, (name) => name) : home.repo;
      const lines = [`${home.title} (${home.area}): ${where}${STATE_TEXT[home.state]}`, `  covers: ${home.covers}`, `  repo: ${home.repo}`];
      if (home.alsoIn !== undefined && home.alsoIn.length > 0) lines.push(`  also in, while it moves: ${home.alsoIn.join(", ")}`);
      if (home.note !== undefined) lines.push(`  note: ${home.note}`);
      return lines.join("\n");
    })
    .join("\n\n")
    .concat("\n");
}

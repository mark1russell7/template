// The bundle of src/select-main.ts of @mark1russell7/conventions. Do not edit: pnpm build:actions writes it.
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, posix } from "node:path";

/**
* This function gives all descendants of a node: the nodes that depend on this node, transitively.
*/
function getDescendants(nodes, id) {
	const descendants = /* @__PURE__ */ new Set();
	const visited = /* @__PURE__ */ new Set();
	const dependents = /* @__PURE__ */ new Map();
	for (const [nodeId, node] of nodes) for (const dep of node.dependencies) {
		if (!dependents.has(dep)) dependents.set(dep, /* @__PURE__ */ new Set());
		dependents.get(dep).add(nodeId);
	}
	function visit(n) {
		if (visited.has(n)) return;
		visited.add(n);
		const deps = dependents.get(n);
		if (!deps) return;
		for (const dep of deps) {
			descendants.add(dep);
			visit(dep);
		}
	}
	visit(id);
	return descendants;
}

/** The characters of a regular expression that a glob character escapes. */
const SPECIAL$1 = /* @__PURE__ */ new Set([..."\\^$.|+()[]{}"]);
/** This function gives the pattern with `/` and with no leading `./`. */
function normalize(glob) {
	return glob.replaceAll("\\", "/").replace(/^(?:\.\/)+/, "");
}
/** This function gives the index of the `}` that closes the `{` at `open`, or -1. */
function closingBrace(glob, open) {
	let depth = 0;
	for (let index = open; index < glob.length; index++) {
		if (glob[index] === "{") depth++;
		if (glob[index] === "}" && --depth === 0) return index;
	}
	return -1;
}
/** This function gives the alternatives of a group. A comma in a nested group does not divide them. */
function alternatives(body) {
	const parts = [];
	let depth = 0;
	let start = 0;
	for (let index = 0; index < body.length; index++) {
		if (body[index] === "{") depth++;
		if (body[index] === "}") depth--;
		if (body[index] === "," && depth === 0) {
			parts.push(body.slice(start, index));
			start = index + 1;
		}
	}
	parts.push(body.slice(start));
	return parts;
}
/**
* This function gives the regular expression source of `glob`. The value of `start` tells if the first
* character of `glob` is at the start of a segment.
*/
function source(glob, dot, start) {
	const guard = dot ? "" : "(?!\\.)";
	const segment = `${guard}[^/]+`;
	let out = "";
	let index = 0;
	while (index < glob.length) {
		const char = glob.charAt(index);
		const atStart = index === 0 ? start : glob.charAt(index - 1) === "/";
		if (char === "/" && index > 0 && glob.slice(index) === "/**") {
			out += dot ? "(?:/.*)?" : `(?:/(?:${segment})?)*`;
			break;
		}
		if (char === "*" && glob.charAt(index + 1) === "*" && atStart) {
			const after = glob.charAt(index + 2);
			if (after === "/") {
				out += `(?:${segment}/)*`;
				index += 3;
				continue;
			}
			if (after === "") {
				out += dot ? ".*" : `(?:${segment}(?:/${segment})*)?`;
				index += 2;
				continue;
			}
		}
		if (char === "*") {
			out += `${atStart ? guard : ""}[^/]*`;
			while (glob.charAt(index) === "*") index++;
			continue;
		}
		if (char === "?") {
			out += `${atStart ? guard : ""}[^/]`;
			index++;
			continue;
		}
		if (char === "[") {
			const close = glob.indexOf("]", index + 1);
			if (close > index + 1) {
				let set = glob.slice(index + 1, close).replaceAll("\\", "\\\\");
				if (set.startsWith("!") || set.startsWith("^")) set = `^/${set.slice(1)}`;
				out += `${atStart ? guard : ""}[${set}]`;
				index = close + 1;
				continue;
			}
		}
		if (char === "{") {
			const close = closingBrace(glob, index);
			if (close !== -1) {
				const parts = alternatives(glob.slice(index + 1, close)).map((part) => source(part, dot, atStart));
				out += `(?:${parts.join("|")})`;
				index = close + 1;
				continue;
			}
		}
		out += SPECIAL$1.has(char) ? `\\${char}` : char;
		index++;
	}
	return out;
}
/** This function gives a regular expression that matches a whole relative path with `/` for `glob`. */
function globToRegExp$1(glob, options = {}) {
	return new RegExp(`^${source(normalize(glob), options.dot ?? true, true)}$`);
}

/** This function compares two strings by their code units, as the default sort does. */
const byCode = (a, b) => a < b ? -1 : a > b ? 1 : 0;
/** The characters that have a meaning in a regular expression. */
const SPECIAL = /* @__PURE__ */ new Set([..."\\^$.|+()[]{}*?/"]);
/**
* This function gives a regular expression for a glob of `/` paths. `*` matches a part of one path
* segment, `?` matches one character, `**` matches zero or more segments, and `{a,b}` matches one of
* its parts. The function escapes each other special character.
*/
function globToRegExp(glob) {
	let source = "";
	let braces = 0;
	for (let index = 0; index < glob.length; index++) {
		const char = glob.charAt(index);
		if (char === "/" && glob.slice(index + 1) === "**") {
			source += "(?:/.*)?";
			break;
		}
		if (char === "*" && glob.charAt(index + 1) === "*") {
			const atStart = index === 0 || glob.charAt(index - 1) === "/";
			const after = glob.charAt(index + 2);
			if (atStart && after === "/") {
				source += "(?:[^/]+/)*";
				index += 2;
			} else if (atStart && after === "") {
				source += ".*";
				index += 1;
			} else {
				source += "[^/]*";
				index += 1;
			}
		} else if (char === "*") source += "[^/]*";
		else if (char === "?") source += "[^/]";
		else if (char === "{") {
			braces++;
			source += "(?:";
		} else if (char === "}" && braces > 0) {
			braces--;
			source += ")";
		} else if (char === "," && braces > 0) source += "|";
		else if (SPECIAL.has(char)) source += `\\${char}`;
		else source += char;
	}
	if (braces > 0) throw new Error(`A glob with a "{" that has no "}": ${glob}`);
	return new RegExp(`^${source}$`);
}
/** This function removes the `/` characters at the end of a path, with a loop in place of a regular expression. */
function trimEndSlashes(path) {
	let end = path.length;
	while (end > 0 && path.charAt(end - 1) === "/") end -= 1;
	return path.slice(0, end);
}
/** This function removes a comment at the end of a YAML value, the spaces and the quotes around it. */
function unquote(text) {
	const value = text.replace(/\s+#.*$/, "").trim();
	return /^(["']).*\1$/.test(value) ? value.slice(1, -1) : value;
}
/**
* This function gives the `packages` list of the text of a `pnpm-workspace.yaml` file, or undefined when the file has
* no key `packages`. It reads a block list (also at the column of the key) and a flow list on one or more lines. It
* throws on each other form, because a list that it reads in part names too few packages.
*/
function parseWorkspaceGlobs(text) {
	const lines = text.split(/\r?\n/);
	const start = lines.findIndex((line) => /^packages\s*:/.test(line));
	if (start < 0) return void 0;
	const rest = (lines[start] ?? "").replace(/^packages\s*:/, "").replace(/\s+#.*$/, "").trim();
	if (rest.startsWith("[")) {
		let flow = rest;
		for (let index = start + 1; !flow.includes("]"); index++) {
			if (index >= lines.length) throw new Error("The list packages of pnpm-workspace.yaml has no \"]\"");
			flow += ` ${(lines[index] ?? "").replace(/\s+#.*$/, "")}`;
		}
		const close = flow.indexOf("]");
		if (flow.slice(close + 1).trim() !== "") throw new Error(`The list packages of pnpm-workspace.yaml has text after its "]": ${flow}`);
		return flow.slice(1, close).split(",").map(unquote).filter((glob) => glob !== "");
	}
	if (rest !== "") throw new Error(`The key packages of pnpm-workspace.yaml is not a list: ${rest}`);
	const globs = [];
	for (const line of lines.slice(start + 1)) {
		if (/^\s*(#.*)?$/.test(line)) continue;
		const item = /^\s*-\s+(.+)$/.exec(line);
		if (item) {
			globs.push(unquote(item[1] ?? ""));
			continue;
		}
		if (!/^\s/.test(line)) break;
		throw new Error(`A line of the list packages of pnpm-workspace.yaml is not an item: ${line.trim()}`);
	}
	return globs;
}
/** The folders that pnpm does not take as packages of a workspace: the default ignore of its search for packages. */
const IGNORED_FOLDERS = /* @__PURE__ */ new Set([
	"node_modules",
	"bower_components",
	"test",
	"tests"
]);
/**
* This function tells if a folder is a package folder of the workspace globs, as in pnpm. The folder is a `/` path
* relative to the root, or `.` for the root. A glob matches it, and no `!` glob matches it. No part of it starts with
* `.` or is a folder of the default ignore of pnpm. The function does not look for a `package.json` file.
*/
function isWorkspaceFolder(folder, globs) {
	if (folder.split("/").some((part) => part !== "." && part.startsWith(".") || IGNORED_FOLDERS.has(part))) return false;
	const matches = (glob) => globToRegExp(trimEndSlashes(glob.startsWith("./") ? glob.slice(2) : glob)).test(folder);
	return globs.some((glob) => !glob.startsWith("!") && matches(glob)) && !globs.some((glob) => glob.startsWith("!") && matches(glob.slice(1)));
}

/** The fields of `package.json` that hold dependencies. */
const DEPENDENCY_FIELDS = [
	"dependencies",
	"devDependencies",
	"peerDependencies",
	"optionalDependencies"
];

/**
* The selector of precise CI (CI.md, "The selection"). It reads the change of a pull request and the workspace of the
* repository. It gives a record of the format `selection/1`: the packages that the change can affect, and the choice of
* each shared job with its cause.
*
* The rules fail open. A global file selects everything, and so does a file that the selector cannot place. A change
* that the selector cannot read gives "no read", not a smaller selection.
*
* The shared actions run with no install, so the action `select` runs a bundle of this module with its dependencies
* (`.github/actions/bundles/select.mjs`, from `tsdown.actions.config.ts`). The script `check:actions` fails when the
* bundle is not current.
*/
/** The name of the format of the selection. */
const SELECTION_FORMAT = "selection/1";
/**
* The global files, relative to the workspace root (decision d3 of the study of precise CI). The selector cannot see the
* effect of these files on each test, so a change to one of them selects everything.
*/
const GLOBAL_FILES = [
	{
		glob: "pnpm-lock.yaml",
		reason: "the lockfile (the item d41-lockfile makes it precise)"
	},
	{
		glob: "package.json",
		reason: "the root package.json: the tools, the scripts and the settings of each package"
	},
	{
		glob: "pnpm-workspace.yaml",
		reason: "the packages and the settings of the workspace"
	},
	{
		glob: ".npmrc",
		reason: "the settings of the install"
	},
	{
		glob: ".nvmrc",
		reason: "the Node.js version"
	},
	{
		glob: ".node-version",
		reason: "the Node.js version"
	},
	{
		glob: "patches/**",
		reason: "a patch of a dependency"
	},
	{
		glob: "tsconfig*.json",
		reason: "a root TypeScript config"
	},
	{
		glob: "vitest.*",
		reason: "a root vitest config"
	},
	{
		glob: "eslint.config.*",
		reason: "the root lint config"
	},
	{
		glob: "ste.config.json",
		reason: "the config of the prose lint"
	},
	{
		glob: "*.cue",
		reason: "a CUE preset of the generated configs"
	},
	{
		glob: "cue.mod/**",
		reason: "a CUE preset of the generated configs"
	}
];
/** The global files relative to the repository root: the workflows and the local actions. */
const REPOSITORY_GLOBAL_FILES = [{
	glob: ".github/workflows/**",
	reason: "a workflow"
}, {
	glob: ".github/actions/**",
	reason: "a local action"
}];
/** The jobs of `reusable-ci.yml`, and the packages and the paths that each job reads. */
const SHARED_JOBS = [
	{
		workflow: "reusable-ci.yml",
		job: "checks",
		packages: "all",
		paths: []
	},
	{
		workflow: "reusable-ci.yml",
		job: "coverage",
		packages: "all",
		paths: []
	},
	{
		workflow: "reusable-ci.yml",
		job: "changesets",
		packages: "published",
		paths: [".changeset/**"]
	},
	{
		workflow: "reusable-ci.yml",
		job: "release-check",
		packages: "published",
		paths: ["scripts/release/**"]
	},
	{
		workflow: "reusable-ci.yml",
		job: "release-window",
		packages: "none",
		paths: [".github/workflows/**", "scripts/release/**"]
	}
];
/**
* This function gives the packages of a workspace. The input is the text of `pnpm-workspace.yaml` (undefined in a
* repository of one package) and the text of each `package.json` by its path from the workspace root.
*/
function readWorkspace(workspaceYaml, manifests) {
	const globs = workspaceYaml === void 0 ? [] : parseWorkspaceGlobs(workspaceYaml) ?? [];
	const found = [];
	for (const [path, text] of manifests) {
		const id = posix.dirname(path);
		if (id !== "." && !isWorkspaceFolder(id, globs)) continue;
		let json;
		try {
			json = JSON.parse(text);
		} catch (error) {
			throw new Error(`${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (typeof json !== "object" || json === null || Array.isArray(json)) throw new Error(`${path} is not a JSON object`);
		found.push({
			id,
			json
		});
	}
	const byName = /* @__PURE__ */ new Map();
	for (const { id, json } of found) if (typeof json["name"] === "string") byName.set(json["name"], id);
	return found.map(({ id, json }) => {
		const deps = /* @__PURE__ */ new Set();
		for (const field of DEPENDENCY_FIELDS) {
			const block = json[field];
			if (typeof block !== "object" || block === null) continue;
			for (const name of Object.keys(block)) {
				const dep = byName.get(name);
				if (dep !== void 0 && dep !== id) deps.add(dep);
			}
		}
		return {
			id,
			name: typeof json["name"] === "string" ? json["name"] : id,
			private: json["private"] === true,
			deps: [...deps].sort(byCode)
		};
	}).sort((a, b) => byCode(a.id, b.id));
}
/** This function gives the id of the package of a path from the workspace root: the deepest package folder that holds it, else the root. */
function packageOf(path, ids) {
	let best = ".";
	for (const id of ids) if (id !== "." && path.startsWith(`${id}/`) && id.length > best.length) best = id;
	return best;
}
/**
* This function gives the changed packages and each package that depends on one of them. For a dependent, `via` is the
* first changed package, in the order of the code units, that it depends on.
*/
function affectedPackages(changed, packages) {
	const nodes = new Map(packages.map((pkg) => [pkg.id, {
		id: pkg.id,
		dependencies: [...pkg.deps]
	}]));
	const via = new Map(changed.map((id) => [id, "changed"]));
	for (const id of [...changed].sort(byCode)) for (const dependent of getDescendants(nodes, id)) if (!via.has(dependent)) via.set(dependent, id);
	return [...via].map(([id, from]) => ({
		id,
		via: from
	})).sort((a, b) => byCode(a.id, b.id));
}
/** This function gives the selection of a change. It is a pure function: `selectFromGit` reads git and gives it the data. */
function select(input) {
	const { base, head, files, packages } = input;
	const root = input.root.replace(/\/+$/, "");
	const prefix = root === "" ? "" : `${root}/`;
	const global = (input.global ?? GLOBAL_FILES).map((rule) => ({
		...rule,
		re: globToRegExp$1(rule.glob)
	}));
	const repositoryGlobal = (input.repositoryGlobal ?? REPOSITORY_GLOBAL_FILES).map((rule) => ({
		...rule,
		re: globToRegExp$1(rule.glob)
	}));
	const ids = packages.map((pkg) => pkg.id);
	const placed = [];
	const globals = [];
	const unplaced = [];
	for (const file of files) {
		const repositoryRule = repositoryGlobal.find((rule) => rule.re.test(file.path));
		if (repositoryRule !== void 0) {
			globals.push({
				path: file.path,
				reason: repositoryRule.reason
			});
			placed.push({
				...file,
				package: null
			});
			continue;
		}
		if (!file.path.startsWith(prefix)) {
			unplaced.push({
				path: file.path,
				reason: `the file is outside the workspace root ${root}`
			});
			placed.push({
				...file,
				package: null
			});
			continue;
		}
		const local = file.path.slice(prefix.length);
		const rule = global.find((item) => item.re.test(local));
		if (rule !== void 0) globals.push({
			path: file.path,
			reason: rule.reason
		});
		else if (local.endsWith("/package.json") && (file.status === "A" || file.status === "D")) globals.push({
			path: file.path,
			reason: file.status === "A" ? "a package comes into the workspace" : "a package goes out of the workspace"
		});
		placed.push({
			...file,
			package: packageOf(local, ids)
		});
	}
	const everything = globals.length > 0 || unplaced.length > 0;
	const changed = [...new Set(placed.flatMap((file) => file.package === null ? [] : [file.package]))].sort(byCode);
	const affected = everything ? packages.map((pkg) => ({
		id: pkg.id,
		via: "everything"
	})) : affectedPackages(changed, packages);
	const affectedIds = new Set(affected.map((pkg) => pkg.id));
	const published = new Set(packages.filter((pkg) => !pkg.private).map((pkg) => pkg.id));
	const jobs = (input.jobs ?? SHARED_JOBS).map((job) => {
		const reads = (id) => job.packages === "all" || job.packages === "published" && published.has(id);
		const choice = {
			workflow: job.workflow,
			job: job.job,
			packages: ids.filter((id) => reads(id) && affectedIds.has(id))
		};
		if (globals.length > 0) return {
			...choice,
			run: true,
			because: {
				kind: "global",
				files: globals.map((item) => item.path)
			}
		};
		if (unplaced.length > 0) return {
			...choice,
			run: true,
			because: {
				kind: "unplaced",
				files: unplaced.map((item) => item.path)
			}
		};
		if (choice.packages.length > 0) return {
			...choice,
			run: true,
			because: {
				kind: "packages",
				packages: choice.packages
			}
		};
		const patterns = job.paths.map((glob) => globToRegExp$1(glob));
		const hits = files.filter((file) => patterns.some((re) => re.test(file.path))).map((file) => file.path);
		if (hits.length > 0) return {
			...choice,
			run: true,
			because: {
				kind: "paths",
				files: hits
			}
		};
		return {
			...choice,
			run: false,
			because: { kind: "none" }
		};
	});
	return {
		format: SELECTION_FORMAT,
		base,
		head,
		everything,
		global: globals,
		unplaced,
		files: placed,
		packages: {
			all: ids,
			changed,
			affected
		},
		jobs
	};
}
const code = (text) => `\`${text}\``;
/** This function gives the lines of the summary of a selection, in Markdown. */
function selectionSummary(record) {
	const lines = ["### Selection (shadow mode: each job still runs)", ""];
	if ("noRead" in record) return [...lines, `No read: ${record.noRead}`];
	const files = `${String(record.files.length)} changed ${record.files.length === 1 ? "file" : "files"}`;
	if (record.global.length > 0) lines.push(`${files}. A global file selects everything: ${record.global.map((item) => `${code(item.path)} (${item.reason})`).join(", ")}.`);
	else if (record.unplaced.length > 0) lines.push(`${files}. A file that the selector cannot place selects everything: ${record.unplaced.map((item) => `${code(item.path)} (${item.reason})`).join(", ")}.`);
	else {
		const list = record.packages.affected.map((pkg) => `${code(pkg.id)}${pkg.via === "changed" ? "" : ` (by ${code(pkg.via)})`}`).join(", ");
		lines.push(`${files}. The change affects ${String(record.packages.affected.length)} of ${String(record.packages.all.length)} packages: ${list || "none"}.`);
	}
	lines.push("", "| Job | Choice | Cause |", "| --- | --- | --- |");
	for (const job of record.jobs) {
		const cause = job.because;
		const text = cause.kind === "global" ? "a global file" : cause.kind === "unplaced" ? "a file that it cannot place" : cause.kind === "packages" ? `the packages ${cause.packages.map(code).join(", ")}` : cause.kind === "paths" ? `the files ${cause.files.map(code).join(", ")}` : "no file that the job reads";
		lines.push(`| ${job.job} | ${job.run ? "runs" : "skips"} | ${text} |`);
	}
	return lines;
}
/** The git command in a folder, as text. */
const git = (cwd, ...args) => execFileSync("git", args, {
	cwd,
	encoding: "utf8",
	maxBuffer: 268435456,
	stdio: [
		"ignore",
		"pipe",
		"pipe"
	]
});
/** This function gives the text of each path at a commit, with one git process. A path that the commit does not have is not in the map. */
function readAt(cwd, commit, paths) {
	const texts = /* @__PURE__ */ new Map();
	if (paths.length === 0) return texts;
	const input = paths.map((path) => `${commit}:${path}\n`).join("");
	const data = execFileSync("git", ["cat-file", "--batch"], {
		cwd,
		input,
		maxBuffer: 268435456
	});
	let at = 0;
	for (const path of paths) {
		const end = data.indexOf(10, at);
		if (end < 0) break;
		const header = data.subarray(at, end).toString("utf8");
		at = end + 1;
		const match = /^[0-9a-f]+ blob (\d+)$/.exec(header);
		if (match === null) continue;
		const size = Number(match[1]);
		texts.set(path, data.subarray(at, at + size).toString("utf8"));
		at += size + 1;
	}
	return texts;
}
/** This function gives the selection of a change from git. It throws when git cannot read the change. */
function selectFromGit(input) {
	const { cwd } = input;
	const commit = (spec) => git(cwd, "rev-parse", "--verify", "--quiet", `${spec}^{commit}`).trim();
	const base = commit(input.base === "" ? "HEAD^1" : input.base);
	const head = commit(input.head !== "" ? input.head : input.base === "" ? "HEAD^2" : "HEAD");
	const trimmed = input.root.replace(/^(\.\/)+/, "").replace(/\/+$/, "");
	const root = trimmed === "." ? "" : trimmed;
	const prefix = root === "" ? "" : `${root}/`;
	const diff = git(cwd, "diff", "--name-status", "--no-renames", "-z", `${base}...${head}`).split("\0").filter((part) => part !== "");
	const files = [];
	for (let index = 0; index + 1 < diff.length; index += 2) files.push({
		status: (diff[index] ?? "").charAt(0),
		path: diff[index + 1] ?? ""
	});
	const manifests = git(cwd, "ls-tree", "-r", "-z", "--name-only", "--full-tree", head, "--", root === "" ? "." : root).split("\0").filter((path) => path !== "").filter((path) => path.startsWith(prefix) && (path === `${prefix}package.json` || path.endsWith("/package.json")));
	const texts = readAt(cwd, head, [`${prefix}pnpm-workspace.yaml`, ...manifests]);
	const local = /* @__PURE__ */ new Map();
	for (const path of manifests) {
		const text = texts.get(path);
		if (text !== void 0) local.set(path.slice(prefix.length), text);
	}
	const extra = (input.global ?? []).map((glob) => ({
		glob,
		reason: "a global file of the input global"
	}));
	return select({
		base,
		head,
		files,
		root,
		packages: readWorkspace(texts.get(`${prefix}pnpm-workspace.yaml`), local),
		global: [...GLOBAL_FILES, ...extra]
	});
}
/**
* This function is the entry of the action `select`. It reads its input from the environment, and writes the record and
* the summary. It gives the exit code 0, also when it cannot read the change.
*/
function runSelect(env, cwd, now) {
	let result;
	try {
		const global = (env["GLOBAL"] ?? "").split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "" && !line.startsWith("#"));
		result = selectFromGit({
			cwd,
			base: env["BASE_SHA"] ?? "",
			head: env["HEAD_SHA"] ?? "",
			root: env["ROOT"] ?? "",
			global
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		result = {
			format: SELECTION_FORMAT,
			noRead: message.split("\n")[0] ?? message
		};
	}
	const lines = selectionSummary(result);
	const record = {
		...result,
		ref: env["SELECTOR_REF"] ?? "",
		durationMs: Math.round(now())
	};
	const out = env["OUT"] ?? "";
	if (out !== "") {
		mkdirSync(dirname(out), { recursive: true });
		writeFileSync(out, `${JSON.stringify(record, null, 2)}\n`);
	}
	process.stdout.write(`${lines.join("\n")}\n`);
	const summary = env["GITHUB_STEP_SUMMARY"] ?? "";
	if (summary !== "") appendFileSync(summary, `${lines.join("\n")}\n`);
	return 0;
}

/**
* The entry of the bundle of the action `select` (`tsdown.actions.config.ts`). It runs the selector on the git checkout of
* the current folder.
*/
process.exitCode = runSelect(process.env, process.cwd(), () => performance.now());

export {  };
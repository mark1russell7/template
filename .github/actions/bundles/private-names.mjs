// The bundle of src/private-names-main.ts of @mark1russell7/conventions. Do not edit: pnpm build:actions writes it.
import { existsSync, readFileSync, statSync } from "node:fs";
import { delimiter, extname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

/** The fields of the configuration of a rule that are not options. */
const RULE_FIELDS = [
	"off",
	"ignore",
	"generated",
	"reason"
];
const isObject$1 = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const isStrings = (value) => Array.isArray(value) && value.every((item) => typeof item === "string");
/** This function gives the options of a rule with their defaults. */
function defaultOptions(rule) {
	return Object.fromEntries(Object.entries(rule.options).map(([name, spec]) => [name, spec.default]));
}
/**
* This function reads the configuration of one rule from the field `conventions` of the root `package.json` (`value`).
* It does not examine the other rules, so it needs no list of the rules. The command `pre-push` uses it: an error in the
* entry of another rule does not change the settings of `no-local-paths`.
*
* @throws Error when the field `conventions`, its field `rules` or the entry of the rule has a wrong shape
*/
function parseRuleConfig(value, rule) {
	if (value === void 0) return {
		ignore: [],
		options: defaultOptions(rule)
	};
	if (!isObject$1(value)) throw new Error("The field conventions of package.json must be an object.");
	const rulesValue = value["rules"] ?? {};
	if (!isObject$1(rulesValue)) throw new Error("conventions.rules must be an object, with a rule id for each key.");
	const entry = rulesValue[rule.id];
	return entry === void 0 ? {
		ignore: [],
		options: defaultOptions(rule)
	} : parseRuleEntry(rule, entry);
}
/** This function examines the entry of one rule in `conventions.rules`, and gives its configuration. */
function parseRuleEntry(rule, entry) {
	const where = `conventions.rules["${rule.id}"]`;
	if (!isObject$1(entry)) throw new Error(`${where} must be an object, for example { "off": "<reason>" }.`);
	const off = entry["off"];
	if (off !== void 0 && (typeof off !== "string" || off.trim() === "")) throw new Error(`${where}.off must be the reason why the rule is off, as text.`);
	const ignore = entry["ignore"] ?? [];
	if (!isStrings(ignore)) throw new Error(`${where}.ignore must be an array of globs.`);
	const reason = entry["reason"];
	if (reason !== void 0 && (typeof reason !== "string" || reason.trim() === "")) throw new Error(`${where}.reason must be text.`);
	if (ignore.length > 0 && reason === void 0) throw new Error(`${where}.ignore needs a reason: add "reason": "<why these files are an exception>".`);
	const generated = entry["generated"] ?? [];
	if (!isStrings(generated)) throw new Error(`${where}.generated must be an array of globs.`);
	if (generated.length > 0 && reason === void 0) throw new Error(`${where}.generated needs a reason: add "reason": "<which build makes these files>".`);
	const options = { ...defaultOptions(rule) };
	const changed = [];
	for (const [name, option] of Object.entries(entry)) {
		if (RULE_FIELDS.includes(name)) continue;
		const spec = rule.options[name];
		if (spec === void 0) {
			const known = [...RULE_FIELDS, ...Object.keys(rule.options)].join(", ");
			throw new Error(`${where} has an unknown field: ${name}. The fields are: ${known}.`);
		}
		if (!(spec.type === "strings" ? isStrings(option) : typeof option === spec.type)) throw new Error(`${where}.${name} must be ${spec.type === "strings" ? "an array of strings" : `a ${spec.type}`}.`);
		options[name] = option;
		changed.push(name);
	}
	if (changed.length > 0 && reason === void 0 && off === void 0) throw new Error(`${where} changes the option${changed.length > 1 ? "s" : ""} ${changed.join(", ")}, and needs a reason: add "reason": "<why this repository changes the default>".`);
	return {
		...off === void 0 ? {} : { off },
		ignore,
		...generated.length === 0 ? {} : { generated },
		...reason === void 0 ? {} : { reason },
		options
	};
}

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

/**
* The shape of a rule, the facts that a rule reads (the context), and small helpers for the rules.
*/
/** This function tells if the environment is a CI run: `CI` is `true` or `1`, or `GITHUB_ACTIONS` is `true`. */
const isCi = (env) => ["true", "1"].includes((env["CI"] ?? "").toLowerCase()) || env["GITHUB_ACTIONS"] === "true";
/** This function removes `./` at the start of a path. */
const cleanPath = (path) => path.replace(/^\.\//, "");
/** This function tells if a path matches one of the globs. */
function matchesAny(path, globs) {
	return globs.some((glob) => globToRegExp(cleanPath(glob)).test(path));
}
/** This function starts git in `root` with `args`, and gives its output, or undefined when git fails. */
function runGit(root, args) {
	const result = spawnSync("git", [...args], {
		cwd: root,
		encoding: "utf8",
		maxBuffer: 268435456,
		windowsHide: true
	});
	if (result.error || result.status !== 0) return void 0;
	return result.stdout;
}
/** This function gives `owner/name` from a git remote URL, or undefined for a URL that is not of GitHub. */
function repositoryOfRemote(url) {
	const text = url.trim();
	for (const prefix of [
		"git@github.com:",
		"ssh://git@github.com/",
		"https://github.com/",
		"http://github.com/",
		"git+https://github.com/"
	]) {
		if (!text.startsWith(prefix)) continue;
		let rest = text.slice(prefix.length);
		if (rest.endsWith("/")) rest = rest.slice(0, -1);
		if (rest.endsWith(".git")) rest = rest.slice(0, -4);
		const parts = rest.split("/");
		return parts.length === 2 && parts.every((part) => part !== "") ? rest : void 0;
	}
}

/**
* The private name list: a JSON file outside of the public repositories, with the names of private projects. The file
* `schema/private-names.schema.json` tells its form. This module parses the list and finds its names in a line or in a
* path. It has no input or output.
*
* A result tells the place of a name by its index in the list, for example `name 3 of the private name list`. A result
* does not show the text, the id, the project or a pattern, because the id of a name is the private name.
*/
/** The name of the private name list in a break and in an error. A break does not show the path of the file. */
const PRIVATE_NAME_LIST = "the private name list";
/**
* This error tells that a private name list is not valid. Its reason names a field by the index of its entry, and
* does not show a value of the list.
*/
var PrivateNameListError = class extends Error {
	/** The reason, for example `name 3 of the private name list: the field seeds has no text`. */
	reason;
	constructor(reason) {
		super(`The private name list is not valid: ${reason}.`);
		this.name = "PrivateNameListError";
		this.reason = reason;
	}
};
/** The compiled names, by entry. The parse fills it, and a list of another source gets its entries on the first use. */
const compiled = /* @__PURE__ */ new WeakMap();
/** The form of a word: letters, digits, `_` and `-`. So the word is a literal in a regular expression. */
const WORD = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
/** The form of a word of `commonAfter`: lower-case letters. The check compares it with the next word in lower case. */
const AFTER = /^[a-z]+$/;
/** This function gives the compiled regular expressions of a name. */
function compiledOf(rule) {
	const known = compiled.get(rule);
	if (known !== void 0) return known;
	const made = {
		patterns: rule.patterns.map((source) => new RegExp(source)),
		...rule.word === void 0 || rule.word === "" ? {} : { word: new RegExp(`\\b${rule.word}\\b`, "g") }
	};
	compiled.set(rule, made);
	return made;
}
/** This function tells if a value is a list of texts that are not empty. */
const isTexts = (value) => Array.isArray(value) && value.every((item) => typeof item === "string" && item !== "");
/** This function tells if a value is an object that is not a list. */
const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
/** This function gives the first field of `entry` that `known` does not have, or undefined. */
const unknownField = (entry, known) => Object.keys(entry).find((key) => !known.includes(key));
/** This function gives a name of the list after a check of its fields. The error names the entry by its index. */
function nameOf(entry, at) {
	const fail = (reason) => {
		throw new PrivateNameListError(`${at}: ${reason}`);
	};
	if (!isObject(entry)) return fail("the entry is not an object");
	if (unknownField(entry, [
		"id",
		"project",
		"seeds",
		"patterns",
		"word",
		"commonAfter"
	]) !== void 0) fail("the entry has a field that the schema does not have");
	const { id, project, seeds, patterns, word, commonAfter } = entry;
	if (typeof id !== "string" || id === "") fail("the field id is not a text");
	if (typeof project !== "string" || project === "") fail("the field project is not a text");
	if (!isTexts(seeds) || seeds.length === 0) fail("the field seeds is not a list of one or more texts");
	if (!isTexts(patterns)) fail("the field patterns is not a list of texts");
	if (word !== void 0 && (typeof word !== "string" || !WORD.test(word))) fail("the field word is not one word of letters, digits, _ and -");
	if (commonAfter !== void 0 && (!Array.isArray(commonAfter) || !commonAfter.every((item) => typeof item === "string" && AFTER.test(item)))) fail("the field commonAfter is not a list of lower-case words");
	if (commonAfter !== void 0 && word === void 0) fail("the field commonAfter has no field word");
	const rule = {
		id,
		project,
		seeds,
		patterns,
		...word === void 0 ? {} : { word },
		...commonAfter === void 0 ? {} : { commonAfter }
	};
	rule.patterns.forEach((source, index) => {
		try {
			new RegExp(source);
		} catch {
			fail(`pattern ${String(index + 1)} is not a valid regular expression`);
		}
	});
	compiledOf(rule);
	return rule;
}
/** This function gives an entry of the list `allow` after a check of its fields. */
function allowedOf(entry, at, ids) {
	const fail = (reason) => {
		throw new PrivateNameListError(`${at}: ${reason}`);
	};
	if (!isObject(entry)) return fail("the entry is not an object");
	if (unknownField(entry, [
		"repo",
		"path",
		"name",
		"why"
	]) !== void 0) fail("the entry has a field that the schema does not have");
	const { repo, path, name, why } = entry;
	if (typeof repo !== "string" || repo === "") fail("the field repo is not a text");
	if (typeof path !== "string" || path === "") fail("the field path is not a text");
	if (typeof why !== "string" || why === "") fail("the field why is not a text");
	if (name !== void 0 && (typeof name !== "string" || !ids.has(name))) fail("the field name is not the id of a name of the list");
	return {
		repo,
		path,
		why,
		...name === void 0 ? {} : { name }
	};
}
/**
* This function parses the text of a private name list, and checks it against the schema. It also checks each regular
* expression and the ids. It throws a `PrivateNameListError` when the text is not valid. The error shows no value of the text.
*/
function parsePrivateNames(text) {
	let data;
	try {
		data = JSON.parse(text);
	} catch {
		throw new PrivateNameListError("the text is not valid JSON");
	}
	if (!isObject(data)) throw new PrivateNameListError("the text is not a JSON object");
	if (unknownField(data, [
		"$schema",
		"$comment",
		"names",
		"allow"
	]) !== void 0) throw new PrivateNameListError("the object has a field that the schema does not have");
	if (data["$comment"] !== void 0 && typeof data["$comment"] !== "string") throw new PrivateNameListError("the field $comment is not a text");
	const names = data["names"];
	const allow = data["allow"] ?? [];
	if (!Array.isArray(names)) throw new PrivateNameListError("the field names is not a list");
	if (!Array.isArray(allow)) throw new PrivateNameListError("the field allow is not a list");
	const rules = names.map((entry, index) => nameOf(entry, `name ${String(index + 1)} of ${PRIVATE_NAME_LIST}`));
	const ids = /* @__PURE__ */ new Set();
	rules.forEach((rule, index) => {
		if (ids.has(rule.id)) throw new PrivateNameListError(`name ${String(index + 1)} of ${PRIVATE_NAME_LIST}: the id is also the id of an earlier name`);
		ids.add(rule.id);
	});
	return {
		names: rules,
		allow: allow.map((entry, index) => allowedOf(entry, `allow entry ${String(index + 1)} of ${PRIVATE_NAME_LIST}`, ids))
	};
}
/**
* This function merges private name lists into one list, in order. The names of each list come after the names of the
* lists before it. Thus the index of a name in a result counts across the lists. `parsePrivateNames` makes sure that an
* entry of `allow` refers to a name of its own list. The function throws a `PrivateNameListError` when two lists have
* the same id. Then an entry of `allow` can refer to the two names.
*/
function mergePrivateNames(lists) {
	const ids = /* @__PURE__ */ new Set();
	const names = [];
	lists.forEach((list, at) => {
		for (const rule of list.names) {
			if (ids.has(rule.id)) throw new PrivateNameListError(`name ${String(names.length + 1)} of ${PRIVATE_NAME_LIST} (list ${String(at + 1)}): the id is also the id of a name of an earlier list`);
			ids.add(rule.id);
			names.push(rule);
		}
	});
	return {
		names,
		allow: lists.flatMap((list) => list.allow)
	};
}
/** The words before a name in code: a declaration, a type or an operator. */
const CODE_BEFORE = /\b(class|interface|type|new|extends|implements|const|let|enum|struct|typeof|instanceof|as)\s+$/;
/** A line of code that imports or exports names. */
const CODE_LINE = /^\s*(import|export)\b/;
/** The words before a common noun: an article or a count. */
const COUNT_BEFORE = /\b(a|an|any|each|every|one|our|this|your)\s+$/i;
/** A word with a capital letter before the word: a title, or a name of more words. */
const TITLE_BEFORE = /[A-Z][\w-]*\s+$/;
/** The words with a capital letter that start a sentence part, not a title. */
const WORD_BEFORE = /\b(And|By|For|From|In|Of|See|To|With)\s+$/;
/**
* This function tells if the word of `rule` at `index` of `line` is a common word or code, and not the name of the
* project. Code is a type, a key or a part of a path. A common word comes after an article, in a title or before a noun.
*/
function isCommonUse(line, index, rule) {
	const word = rule.word ?? "";
	const before = line.slice(0, index);
	const after = line.slice(index + word.length);
	if (/^\s*[\]>{};]/.test(after) || /["[]$/.test(before) || /=>\s*$/.test(before)) return true;
	if (/^[<([{]/.test(after) || /^\.\w/.test(after) || after.startsWith("::") || /^:\s*[{[(]/.test(after)) return true;
	if (/^[-/]/.test(after) || /[-/]$/.test(before)) return true;
	if (/[<.]$/.test(before)) return true;
	if (CODE_BEFORE.test(before) || CODE_LINE.test(line)) return true;
	if (/[`'"]$/.test(before) && /^[`'"]/.test(after)) return true;
	if (/[\w)\]?]:\s*$/.test(before) && /^\s*([,;)=|&>]|$)/.test(after)) return true;
	if (COUNT_BEFORE.test(before)) return true;
	if (TITLE_BEFORE.test(before) && !WORD_BEFORE.test(before)) return true;
	const next = /^\s+([A-Za-z]+)/.exec(after)?.[1];
	if (next === void 0) return false;
	return /^[A-Z][a-z]/.test(next) || (rule.commonAfter ?? []).includes(next.toLowerCase());
}
/**
* This function gives each name of `names` in `line`, in the sequence of the list. Each name gives one hit at most: its
* first pattern match, or else its first word match that is not a common use.
*/
function nameMatches(line, names) {
	const hits = [];
	for (let at = 0; at < names.length; at++) {
		const hit = nameMatch(line, names, at);
		if (hit !== void 0) hits.push(hit);
	}
	return hits;
}
/** This function gives the hit of the name at position `at` of `names` in `line`, or undefined. */
function nameMatch(line, names, at) {
	const rule = names[at];
	if (rule === void 0) return void 0;
	const { patterns, word } = compiledOf(rule);
	for (const pattern of patterns) {
		const found = pattern.exec(line);
		if (found !== null) return {
			name: at + 1,
			rule,
			index: found.index
		};
	}
	if (word === void 0) return void 0;
	for (const found of line.matchAll(word)) if (!isCommonUse(line, found.index, rule)) return {
		name: at + 1,
		rule,
		index: found.index
	};
}
/** This function gives the name part of a repository: `name` for `owner/name`, in lower case. */
const repoName = (repo) => (repo.split("/").at(-1) ?? repo).toLowerCase();
/**
* This function tells if the list `allow` permits the name `id` in the file `path` of the repository `repo`. An entry
* with the repository `name` or `owner/name` matches the repository `owner/name`. Case of a repository is not significant.
*/
function isAllowedHit(allow, repo, path, id) {
	const full = repo.toLowerCase();
	return allow.some((entry) => {
		const named = entry.repo.toLowerCase();
		return (named.includes("/") ? named === full : named === repoName(repo)) && entry.path === path && (entry.name === void 0 || entry.name === id);
	});
}
/**
* This function gives each name of the list in one line of a file or of a message, in the sequence of the list. The line
* must have a seed of the list. Each name gives one hit at most. A permitted hit at the place does not count.
*/
function lineNameHits(list, line, place = {}) {
	if (!list.names.some((rule) => rule.seeds.some((seed) => line.includes(seed)))) return [];
	const { repo, path } = place;
	const hits = nameMatches(line, list.names);
	if (repo === void 0 || path === void 0) return hits;
	return hits.filter((hit) => !isAllowedHit(list.allow, repo, path, hit.rule.id));
}
/**
* This function gives the first name of the list in one line of a file or of a message, or undefined. It is the first
* hit of `lineNameHits`, so a permitted hit does not hide a hit of another name.
*/
function lineNameHit(list, line, place = {}) {
	return lineNameHits(list, line, place)[0];
}
/**
* This function gives the first name of the list whose pattern matches a path of a file, or undefined. Only the patterns
* apply, because a path has no sentence. The seeds and the list `allow` do not apply.
*/
function pathNameHit(list, path) {
	for (let at = 0; at < list.names.length; at++) {
		const rule = list.names[at];
		if (rule === void 0) continue;
		const found = compiledOf(rule).patterns.map((pattern) => pattern.exec(path)).find((match) => match !== null);
		if (found !== void 0 && found !== null) return {
			name: at + 1,
			rule,
			index: found.index
		};
	}
}

/**
* The pull request of a run: its title, its body and its number of commits. On a pull request, the event file of GitHub
* Actions (GITHUB_EVENT_PATH) has it. A run that `workflow_dispatch` starts has no pull request in its event file. For
* such a run, the shared CI of the template finds the open pull request of the branch and writes it to a JSON file. The
* variable CONVENTIONS_PULL_REQUEST names that file, and the variable CONVENTIONS_BASE gives the tip of its base branch.
*/
/** The variable that names a JSON file with the pull request of the run. The file has priority over the event file. */
const PULL_REQUEST_VARIABLE = "CONVENTIONS_PULL_REQUEST";
/** This function gives the JSON value of a file, or undefined when the file does not exist or does not parse. */
function readJson(file) {
	if (file === void 0 || file === "" || !existsSync(file)) return void 0;
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return;
	}
}
/** This function gives the facts of a pull request object, or undefined when the value is not an object. */
function factsOf(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return void 0;
	const { title, body, commits } = value;
	return {
		...typeof title === "string" ? { title } : {},
		...typeof body === "string" ? { body } : {},
		...typeof commits === "number" ? { commits } : {}
	};
}
/** This function tells if the run names a file of its pull request in CONVENTIONS_PULL_REQUEST. */
function namesPullRequestFile(env) {
	const file = env[PULL_REQUEST_VARIABLE];
	return file !== void 0 && file !== "";
}
/**
* This function gives the pull request of the run. When CONVENTIONS_PULL_REQUEST names a file, the function reads only
* that file. Else it reads the field `pull_request` of the event file. With no pull request, it gives undefined.
*/
function pullRequestOfRun(env) {
	if (namesPullRequestFile(env)) return factsOf(readJson(env[PULL_REQUEST_VARIABLE]));
	const event = readJson(env["GITHUB_EVENT_PATH"]);
	return factsOf(typeof event === "object" && event !== null ? event.pull_request : void 0);
}

/**
* The change that a check examines: the option `--base`, the merge commit of a pull request, or a push to the default
* branch. The rule release-files reads its changed files, and the runner reads the files that it adds.
*/
/** This function gives the range of the commits of a push to the default branch, from the event file of GitHub Actions. */
function pushRange(context) {
	const file = context.env["GITHUB_EVENT_PATH"];
	let event;
	try {
		event = file === void 0 || file === "" || !existsSync(file) ? void 0 : JSON.parse(readFileSync(file, "utf8"));
	} catch {
		event = void 0;
	}
	if (event === void 0) return { skipped: "the push has no event file (GITHUB_EVENT_PATH)" };
	const branch = event.repository?.default_branch;
	if (typeof branch !== "string" || event.ref !== `refs/heads/${branch}`) return { skipped: "the push is not to the default branch: the pull request of the branch has the change" };
	const before = typeof event.before === "string" ? event.before : "";
	if (!/^[0-9a-f]{40,64}$/.test(before) || /^0+$/.test(before)) return { skipped: "the push has no commit before it" };
	if (context.git([
		"rev-parse",
		"--verify",
		"--quiet",
		`${before}^{commit}`
	]) === void 0) return { skipped: `the checkout does not have ${before}, the commit before the push: fetch it, or set fetch-depth to 0` };
	return {
		diff: [before, "HEAD"],
		log: [`${before}..HEAD`],
		ends: [before, "HEAD"]
	};
}
/**
* This function gives the range of the change: the option `--base`, or the merge commit of a pull request. With the
* option `push`, a push to the default branch gives the commits of the push: from the commit before the push to HEAD.
*/
function rangeOf(context, options = {}) {
	if (context.base !== void 0) {
		if (context.git([
			"rev-parse",
			"--verify",
			"--quiet",
			`${context.base}^{commit}`
		]) === void 0) return { skipped: `git does not know the base ${context.base}` };
		return {
			diff: [`${context.base}...HEAD`],
			log: [`${context.base}..HEAD`],
			ends: [context.base, "HEAD"]
		};
	}
	const event = context.env["GITHUB_EVENT_NAME"];
	if (event === "push" && options.push === true) return pushRange(context);
	if (event !== "pull_request" && event !== "pull_request_target") return { skipped: "no base: the rule runs on a pull request, or with --base <ref>" };
	if ((context.git([
		"rev-list",
		"--parents",
		"-n",
		"1",
		"HEAD"
	])?.trim().split(/\s+/) ?? []).length !== 3) return { skipped: "HEAD is not the merge commit of the pull request" };
	if (context.git([
		"cat-file",
		"-e",
		"HEAD^1^{commit}"
	]) === void 0) return { skipped: "the checkout has no parent of HEAD: set fetch-depth to 2 or more" };
	return {
		diff: ["HEAD^1", "HEAD"],
		log: ["HEAD^1..HEAD"],
		ends: ["HEAD^1", "HEAD^2"]
	};
}

/**
* The rule `no-local-paths`: no tracked file names the home folder of a user of a computer. The commit messages of a
* change and the title and the body of its pull request do not name one either. The same is true for each private
* pattern of the environment variable `CONVENTIONS_PRIVATE_PATTERNS`. A break of a private pattern does not show the
* text or the pattern, because a public log must not name them.
*
* The module also has the core of the command `conventions pre-push`. The core has the setting of the private name list,
* the private patterns and the breaks of one text.
*/
/** The extensions of files that are not text. The rule does not read them. */
const BINARY = new Set(".png .jpg .jpeg .gif .webp .avif .ico .bmp .tiff .pdf .zip .gz .tgz .bz2 .xz .7z .tar .woff .woff2 .ttf .otf .eot .mp3 .mp4 .webm .mov .wav .ogg .wasm .node .exe .dll .so .dylib .bin .db .sqlite .duckdb".split(" "));
/** The largest file that the rule reads, in bytes. */
const MAX_BYTES = 2097152;
/** The names in a home path that do not identify a person: CI users, container users and placeholders. */
const DEFAULT_ALLOWED = [
	"runner",
	"runneradmin",
	"user",
	"username",
	"you",
	"me",
	"name",
	"yourname",
	"your-name",
	"example",
	"node",
	"ubuntu",
	"vscode",
	"codespace",
	"public",
	"default",
	"shared",
	"all users"
];
/** The forms of a home folder: Windows, macOS and Linux. The group `user` is the name of the user. */
const HOME_PATTERNS = [
	/\b[A-Za-z]:(?:\\{1,2}|\/)[Uu][Ss][Ee][Rr][Ss](?:\\{1,2}|\/)(?<user>[^\\/\s"'`<>|:*?%$(){}[\],;]+)/g,
	/(?<![\w.~-])\/Users\/(?<user>[^/\s"'`<>|:*?%$(){}[\],;]+)/g,
	/(?<![\w.~-])\/home\/(?<user>[^/\s"'`<>|:*?%$(){}[\],;]+)/g
];
/** The name of the environment variable of the private patterns. */
const PRIVATE_PATTERNS_VARIABLE = "CONVENTIONS_PRIVATE_PATTERNS";
/** The name of the environment variable of the path of the private name list. */
const PRIVATE_NAMES_FILE_VARIABLE = "CONVENTIONS_PRIVATE_NAMES_FILE";
/** The key of the git configuration of the path of the private name list. */
const PRIVATE_NAMES_FILE_CONFIG = "conventions.privateNamesFile";
/** This function gives the regular expression of a pattern, or undefined when the pattern is not valid. */
function compilePattern(source) {
	try {
		return new RegExp(source, "g");
	} catch {
		return;
	}
}
/** This function compiles the patterns of a check. A private pattern that is not valid has no matcher. */
function compile(privates, options) {
	const extra = (options.patterns ?? []).map((source) => ({ regex: new RegExp(source, "g") }));
	for (const pattern of privates.patterns ?? []) {
		const regex = compilePattern(pattern.source);
		if (regex !== void 0) extra.push({
			regex,
			secret: pattern
		});
	}
	return {
		...privates.names === void 0 ? {} : { names: privates.names },
		extra,
		allowed: new Set([...DEFAULT_ALLOWED, ...options.allow ?? []].map((name) => name.toLowerCase())),
		homes: options.homes !== false
	};
}
/** This function gives the breaks of one text with compiled patterns. */
function textBreaks(name, text, matchers, options) {
	const breaks = [];
	const first = options.firstLine ?? 1;
	const lines = text.split(/\r?\n/);
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index] ?? "";
		const at = first + index;
		const isReason = options.rootPackage === true && /^\s*"(?:reason|off)"\s*:/.test(line);
		if (matchers.homes && !isReason) for (const pattern of HOME_PATTERNS) for (const match of line.matchAll(pattern)) {
			const user = match.groups?.["user"] ?? "";
			if (user.length < 2 || matchers.allowed.has(user.toLowerCase())) continue;
			breaks.push({
				file: name,
				line: at,
				message: `The text "${match[0]}" is the home folder of a user.`
			});
		}
		if (matchers.names !== void 0) {
			const place = {
				...options.repo === void 0 ? {} : { repo: options.repo },
				...options.path === void 0 ? {} : { path: options.path }
			};
			const hit = options.isPath === true ? pathNameHit(matchers.names, line) : lineNameHit(matchers.names, line, place);
			if (hit !== void 0) breaks.push({
				file: name,
				line: at,
				message: `A text names name ${String(hit.name)} of ${PRIVATE_NAME_LIST}.`,
				fix: "Remove the text. The check does not show the text, because the name is private."
			});
		}
		for (const matcher of matchers.extra) {
			if (options.rootPackage === true && matcher.secret === void 0 && line.trim().replace(/,$/, "") === JSON.stringify(matcher.regex.source)) continue;
			for (const match of line.matchAll(matcher.regex)) breaks.push(matcher.secret === void 0 ? {
				file: name,
				line: at,
				message: `The text "${match[0]}" matches the pattern ${matcher.regex.source}.`,
				fix: "Remove the text."
			} : {
				file: name,
				line: at,
				message: `A text matches the private pattern on line ${String(matcher.secret.line)} of ${matcher.secret.label}.`,
				fix: "Remove the text. The check does not show the text, because the pattern is private."
			});
		}
	}
	return breaks;
}
/** This function gives the patterns of the lines of `text`, with the line of each (from 1). It skips empty lines. */
function patternLines(text, label) {
	return text.split("\n").map((source, index) => ({
		source: source.trim(),
		line: index + 1,
		label
	})).filter((pattern) => pattern.source !== "");
}
/** This function gives the private patterns of the environment variable, with the line of each (from 1). */
function privatePatterns(env) {
	return patternLines(env["CONVENTIONS_PRIVATE_PATTERNS"] ?? "", PRIVATE_PATTERNS_VARIABLE);
}
/**
* This function gives the paths of the private name lists, in order. The environment variable
* `CONVENTIONS_PRIVATE_NAMES_FILE` has priority. It has one path, or more paths with `separator` between them. The
* default `separator` is the `delimiter` of `node:path`: `;` on Windows, `:` on other systems. Else, each value of the git
* configuration `conventions.privateNamesFile` is a path. The function gives an empty array when neither has a value.
*/
function privateNamesFiles(env, git, separator = delimiter) {
	const fromEnv = (env["CONVENTIONS_PRIVATE_NAMES_FILE"] ?? "").split(separator).map((path) => path.trim()).filter((path) => path !== "");
	if (fromEnv.length > 0) return fromEnv;
	return (git([
		"config",
		"--type=path",
		"--get-all",
		"conventions.privateNamesFile"
	]) ?? "").split(/\r?\n/).map((path) => path.trim()).filter((path) => path !== "");
}
/** This function gives a break for each private pattern that is not a valid regular expression. A break does not show the pattern. */
function invalidPatternBreaks(patterns) {
	return patterns.filter((pattern) => compilePattern(pattern.source) === void 0).map((pattern) => ({
		file: pattern.label,
		line: pattern.line,
		message: `Line ${String(pattern.line)} of ${pattern.label} is not a valid regular expression.`,
		fix: "Correct the regular expression. The check does not show the pattern, because it is private."
	}));
}
/**
* This function gives the breaks of one text: a file, a commit message or the body of a pull request. Each break has the
* file `name`. A break of a private source does not show the text, the name or the pattern. A line has one break or no
* break of the private name list. The breaks of home folders use `HOME_PATTERNS` and the permitted names. A private pattern
* that is not valid gives no break here: refer to `invalidPatternBreaks`.
*/
function privateTextBreaks(name, text, privates, options = {}) {
	return textBreaks(name, text, compile(privates, options), options);
}
/**
* This function gives the texts of the change that are not files. They are each commit message of a pull request (or of the
* range of `--base`). They are also the title and the body of the pull request, from the event file of GitHub Actions or
* from the file of CONVENTIONS_PULL_REQUEST.
*/
function changeTexts(context) {
	const texts = [];
	const range = rangeOf(context);
	if (!("skipped" in range)) {
		const log = context.git([
			"log",
			"--no-merges",
			"--format=%H%x00%B%x1e",
			...range.log
		]) ?? "";
		for (const entry of log.split("")) {
			const [sha, message] = entry.replace(/^\s+/, "").split("\0");
			if (sha !== void 0 && sha !== "" && message !== void 0) texts.push({
				name: `commit ${sha.slice(0, 12)}`,
				text: message
			});
		}
	}
	const pullRequest = pullRequestOfRun(context.env);
	if (pullRequest?.title !== void 0) texts.push({
		name: "pull request title",
		text: pullRequest.title
	});
	if (pullRequest?.body !== void 0) texts.push({
		name: "pull request body",
		text: pullRequest.body
	});
	return texts;
}
const noLocalPaths = {
	id: "no-local-paths",
	title: "No tracked file, commit message of the change or text of its pull request has a private pattern or the home folder of a user (`C:\\Users\\<name>`, `/Users/<name>`, `/home/<name>`).",
	reason: "A public file must not name a computer, a user or a path of a computer. A local path also works only on one computer.",
	fix: "Use a path relative to the repository, `~`, an environment variable, or a placeholder such as `<you>`.",
	sources: [
		{
			repo: "client",
			rule: "I12",
			doc: "packages/documentation/ARCHITECTURE.md:201"
		},
		{
			repo: "systems",
			rule: "no-identifying-names",
			doc: "CLAUDE.md:12"
		},
		{
			repo: "systems",
			rule: "no-private-identifiers",
			doc: "CLAUDE.md:12"
		},
		{
			repo: "systems",
			rule: "no-private-names",
			doc: "CLAUDE.md:12"
		},
		{
			repo: "coeval",
			rule: "no-private-names",
			doc: "CLAUDE.md:22"
		}
	],
	options: {
		allow: {
			type: "strings",
			default: [],
			description: "More user names that do not identify a person."
		},
		patterns: {
			type: "strings",
			default: [],
			description: "More regular expressions of text that no file has. The environment variable CONVENTIONS_PRIVATE_PATTERNS adds one on each line, so a private name stays out of package.json."
		}
	},
	check(context, options) {
		const files = context.gitFiles();
		if (files === void 0) return { skipped: "the root is not in a git repository" };
		const settings = {
			allow: Array.isArray(options["allow"]) ? [...options["allow"]] : [],
			patterns: Array.isArray(options["patterns"]) ? [...options["patterns"]] : []
		};
		const privates = privatePatterns(context.env);
		const matchers = compile({ patterns: privates }, settings);
		const rootFile = context.rootPackage.file;
		const breaks = invalidPatternBreaks(privates);
		const add = (items) => {
			for (const item of items) breaks.push(item);
		};
		for (const file of files) {
			if (BINARY.has(extname(file).toLowerCase())) continue;
			const path = join(context.root, file);
			let text;
			try {
				if (statSync(path).size > MAX_BYTES) continue;
				text = readFileSync(path, "utf8");
			} catch {
				continue;
			}
			if (text.includes("\0")) continue;
			add(textBreaks(file, text, matchers, { rootPackage: file === rootFile }));
		}
		for (const change of changeTexts(context)) add(textBreaks(change.name, change.text, matchers, {}));
		return breaks;
	},
	noRead(context) {
		if (!isCi(context.env) || privatePatterns(context.env).length > 0) return void 0;
		return `CI gives no ${PRIVATE_PATTERNS_VARIABLE}, so the rule did not look for private names. It looked only for home folders and the patterns of its options.`;
	}
};

/**
* The commands `conventions pre-push` and `conventions hook install`. The hook `pre-push` of git starts the first
* command before each push. It examines the new commits of the push with the private name list, which is outside
* of the public repositories. The second command writes that hook.
*/
/** The line of `conventions pre-push` when no setting names a private name list and no environment variable has a pattern. */
const NO_READ_LINE = `conventions pre-push: No read: no private name list. Set ${PRIVATE_NAMES_FILE_VARIABLE} or the git config ${PRIVATE_NAMES_FILE_CONFIG}.`;
/** A sha of no commit: git gives it for a ref that the push deletes, or for a ref that the remote does not have. */
const ZERO = /^0+$/;
/** The form of a sha of a commit. */
const SHA = /^[0-9a-f]{40,64}$/;
/**
* This function reads the settings of the rule `no-local-paths` in the root `package.json`: the state, the permitted names
* and the globs of `ignore` and `generated`. They apply only to the home folders. A private pattern always counts. The
* function reads only the entry of `no-local-paths`, so the bundle `private-names.mjs` does not hold the other rules.
*/
function homeSettings(root, readFile) {
	try {
		const manifest = JSON.parse(readFile(join(root, "package.json")));
		const config = parseRuleConfig(manifest["conventions"], noLocalPaths);
		const allow = config.options["allow"];
		return {
			on: config.off === void 0,
			allow: Array.isArray(allow) ? [...allow] : [],
			ignore: [...config.ignore, ...config.generated ?? []]
		};
	} catch {
		return {
			on: true,
			allow: [],
			ignore: []
		};
	}
}
/** This function gives the text of a path in a header of a patch, without the quotes of git. */
function unquote(path) {
	if (!path.startsWith("\"") || !path.endsWith("\"")) return path;
	const bytes = [];
	const body = path.slice(1, -1);
	const escapes = {
		a: 7,
		b: 8,
		t: 9,
		n: 10,
		v: 11,
		f: 12,
		r: 13,
		"\"": 34,
		"\\": 92
	};
	for (let index = 0; index < body.length; index++) {
		if (body.charAt(index) !== "\\") {
			const char = String.fromCodePoint(body.codePointAt(index) ?? 0);
			bytes.push(...Buffer.from(char, "utf8"));
			index += char.length - 1;
			continue;
		}
		const octal = /^[0-7]{3}/.exec(body.slice(index + 1));
		if (octal !== null) {
			bytes.push(parseInt(octal[0], 8));
			index += 3;
			continue;
		}
		const next = body.charAt(index + 1);
		bytes.push(escapes[next] ?? next.charCodeAt(0));
		index += 1;
	}
	return Buffer.from(bytes).toString("utf8");
}
/**
* This function gives the added lines of a patch of `git show --unified=0`, in runs of lines that follow each other.
* It reads the counts of each hunk, so an added line that starts with `+++` is a line, not a header. It also reads the
* combined patch of a merge commit, with one column of marks for each parent.
*/
function addedRuns(patch) {
	const runs = [];
	let file;
	let columns = 1;
	let parentLeft = [];
	let resultLeft = 0;
	let next = 0;
	for (const raw of patch.split("\n")) {
		const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
		if (line.startsWith("\\")) continue;
		if (resultLeft > 0 || parentLeft.some((count) => count > 0)) {
			const marks = line.slice(0, columns);
			const removed = marks.includes("-");
			for (let column = 0; column < columns; column++) {
				const mark = marks.charAt(column);
				if (mark === "-" || !removed && mark === " ") parentLeft[column] = (parentLeft[column] ?? 0) - 1;
			}
			if (removed) continue;
			resultLeft -= 1;
			if (marks.includes("+") && file !== void 0) {
				const text = line.slice(columns);
				const last = runs.at(-1);
				if (last !== void 0 && last.file === file && last.first + last.lines.length === next) last.lines.push(text);
				else runs.push({
					file,
					first: next,
					lines: [text]
				});
			}
			next += 1;
			continue;
		}
		if (line.startsWith("diff ")) {
			file = void 0;
			continue;
		}
		if (line.startsWith("+++ ")) {
			const path = unquote(line.slice(4));
			file = path === "/dev/null" ? void 0 : path.replace(/^b\//, "");
			continue;
		}
		const hunk = /^(@{2,}) ((?:-\d+(?:,\d+)? )+)\+(\d+)(?:,(\d+))? \1/.exec(line);
		if (hunk === null) continue;
		columns = (hunk[1] ?? "@@").length - 1;
		parentLeft = (hunk[2] ?? "").trim().split(" ").map((range) => {
			const count = /^-\d+(?:,(\d+))?$/.exec(range)?.[1];
			return count === void 0 ? 1 : Number(count);
		});
		next = Number(hunk[3]);
		resultLeft = hunk[4] === void 0 ? 1 : Number(hunk[4]);
	}
	return runs;
}
/** This function gives the place of a break as `file:line`. */
const placeOf = (item) => item.line === void 0 ? item.file : `${item.file}:${String(item.line)}`;
/** This function examines one commit: its message, the paths that it adds or changes, and each line that it adds. */
function readCommit(sha, privates, home, repo, git) {
	const short = sha.slice(0, 12);
	const message = git([
		"show",
		"-s",
		"--format=%B",
		sha
	]);
	const names = git([
		"show",
		"--format=",
		"--name-only",
		"--diff-filter=AMRC",
		"-z",
		"--no-ext-diff",
		sha
	]);
	const patch = git([
		"-c",
		"core.quotePath=false",
		"show",
		"--format=",
		"--no-color",
		"--unified=0",
		"--no-ext-diff",
		"--no-textconv",
		"--src-prefix=a/",
		"--dst-prefix=b/",
		sha
	]);
	if (message === void 0 || names === void 0 || patch === void 0) return void 0;
	const breaks = [];
	const add = (items) => {
		for (const item of items) breaks.push(item);
	};
	const text = message.replace(/\s+$/, "");
	add(privateTextBreaks(`commit ${short} message`, text, privates, {
		allow: home.allow,
		homes: home.on
	}));
	let lines = text === "" ? 0 : text.split(/\r?\n/).length;
	const runs = addedRuns(patch);
	const paths = names.replace(/^\n+/, "").split("\0").filter((path) => path !== "");
	for (const run of runs) if (!paths.includes(run.file)) paths.push(run.file);
	const shown = /* @__PURE__ */ new Map();
	paths.forEach((path, index) => {
		const homes = home.on && !matchesAny(path, home.ignore);
		const found = privateTextBreaks(`commit ${short} path ${String(index + 1)}`, path, privates, {
			allow: home.allow,
			homes,
			isPath: true
		});
		lines += 1;
		shown.set(path, found.length > 0 ? `commit ${short} path ${String(index + 1)}` : `commit ${short} ${path}`);
		for (const item of found) breaks.push({
			file: item.file,
			message: item.message.replace(/^A text /, "The path "),
			...item.fix === void 0 ? {} : { fix: item.fix }
		});
	});
	for (const run of runs) {
		const homes = home.on && !matchesAny(run.file, home.ignore);
		const place = {
			...repo === void 0 ? {} : { repo },
			path: run.file
		};
		add(privateTextBreaks(shown.get(run.file) ?? `commit ${short} ${run.file}`, run.lines.join("\n"), privates, {
			allow: home.allow,
			homes,
			firstLine: run.first,
			rootPackage: run.file === "package.json",
			...place
		}));
		lines += run.lines.length;
	}
	return {
		breaks,
		lines
	};
}
/** This function gives the reason of a read that failed, in words. */
function readReason(error) {
	const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
	if (code === "ENOENT") return "the file does not exist";
	if (code === "EISDIR") return "the path is a folder";
	if (code === "EACCES" || code === "EPERM") return "the file has no read permission";
	return error instanceof Error ? error.message : String(error);
}
/**
* This function gives the repository `owner/name` of the push: from the URL of the hook, else from `git remote get-url`.
* It gives undefined when neither URL is a URL of a GitHub repository.
*/
function repoOfPush(options) {
	return (options.url === void 0 ? void 0 : repositoryOfRemote(options.url)) ?? repositoryOfRemote(options.git([
		"remote",
		"get-url",
		options.remote
	]) ?? "");
}
/**
* This function is the command `conventions pre-push`. It examines each new commit of the push: its message, the paths
* that it adds or changes, and each line that it adds. It writes the breaks to `stderr`, and gives the exit code: 1 on a
* break, 0 on a pass. With no private name list and no private pattern, it writes the line `NO_READ_LINE` and gives 0.
* The settings can name more than one list (`privateNamesFiles`). The command then examines the merge of the lists.
*
* With the option `base`, the command is the check of a change in CI. It examines each commit of `base..head` with
* the same rules, and the title and the body of the pull request of the run. A message then tells that the check fails,
* not that the push stops.
*/
function prePush(options, io) {
	const readFile = options.readFile ?? ((path) => readFileSync(path, "utf8"));
	const change = options.base !== void 0;
	const stops = change ? "The check fails." : "The push stops.";
	const files = privateNamesFiles(options.env, options.git);
	const patterns = privatePatterns(options.env);
	if (files.length === 0 && patterns.length === 0) {
		io.stderr(`${NO_READ_LINE}\n`);
		return 0;
	}
	let names;
	if (files.length > 0) {
		const source = privateNamesFiles({ ["CONVENTIONS_PRIVATE_NAMES_FILE"]: options.env["CONVENTIONS_PRIVATE_NAMES_FILE"] }, () => void 0).length > 0 ? PRIVATE_NAMES_FILE_VARIABLE : `the git config ${PRIVATE_NAMES_FILE_CONFIG}`;
		const lists = [];
		for (const [at, file] of files.entries()) {
			const which = files.length === 1 ? `the private name list that ${source} names` : `private name list ${String(at + 1)} of the ${String(files.length)} that ${source} names`;
			let text;
			try {
				text = readFile(resolve(options.root, file));
			} catch (error) {
				io.stderr(`conventions pre-push: Cannot read ${which}: ${readReason(error)}. Correct the setting or the file. ${stops}\n`);
				return 1;
			}
			try {
				lists.push(parsePrivateNames(text));
			} catch (error) {
				const reason = error instanceof PrivateNameListError ? error.reason : "the parse failed";
				io.stderr(`conventions pre-push: ${which.charAt(0).toUpperCase()}${which.slice(1)} is not valid: ${reason}. Correct the file. ${stops}\n`);
				return 1;
			}
		}
		try {
			names = mergePrivateNames(lists);
		} catch (error) {
			const reason = error instanceof PrivateNameListError ? error.reason : "the merge failed";
			io.stderr(`conventions pre-push: The private name lists that ${source} names are not valid together: ${reason}. Give each name its own id. ${stops}\n`);
			return 1;
		}
	}
	const privates = {
		...names === void 0 ? {} : { names },
		patterns
	};
	const repo = names === void 0 || names.allow.length === 0 ? void 0 : repoOfPush(options);
	const home = homeSettings(options.root, readFile);
	const breaks = invalidPatternBreaks(patterns);
	const commits = /* @__PURE__ */ new Set();
	if (options.base !== void 0) {
		const head = options.head ?? "HEAD";
		const listed = options.git([
			"rev-list",
			head,
			`^${options.base}`,
			"--"
		]);
		if (listed === void 0) {
			io.stderr(`conventions pre-push: git cannot list the commits of ${options.base}..${head}. ${stops}\n`);
			return 1;
		}
		for (const sha of listed.split(/\r?\n/)) if (SHA.test(sha.trim())) commits.add(sha.trim());
	}
	for (const line of change ? [] : options.input.split(/\r?\n/)) {
		if (line.trim() === "") continue;
		const [localRef, localSha, , remoteSha] = line.trim().split(/\s+/);
		if (localSha === void 0 || remoteSha === void 0 || !SHA.test(localSha) || !SHA.test(remoteSha)) {
			io.stderr(`conventions pre-push: The input line "${line.trim()}" does not have the form <local ref> <local sha> <remote ref> <remote sha>. The push stops.\n`);
			return 1;
		}
		if (ZERO.test(localSha)) continue;
		const others = [
			"rev-list",
			localSha,
			"--not",
			`--remotes=${options.remote}`
		];
		const listed = ZERO.test(remoteSha) ? options.git(others) : options.git([
			"rev-list",
			localSha,
			`^${remoteSha}`
		]) ?? options.git(others);
		if (listed === void 0) {
			io.stderr(`conventions pre-push: git cannot list the new commits of ${localRef ?? localSha}. The push stops.\n`);
			return 1;
		}
		for (const sha of listed.split(/\r?\n/)) if (SHA.test(sha.trim())) commits.add(sha.trim());
	}
	let lines = 0;
	for (const sha of commits) {
		const read = readCommit(sha, privates, home, repo, options.git);
		if (read === void 0) {
			io.stderr(`conventions pre-push: git cannot show the commit ${sha.slice(0, 12)}. ${stops}\n`);
			return 1;
		}
		for (const item of read.breaks) breaks.push(item);
		lines += read.lines;
	}
	const pullRequest = change ? pullRequestOfRun(options.env) : void 0;
	let texts = 0;
	for (const [name, text] of [["pull request title", pullRequest?.title], ["pull request body", pullRequest?.body]]) {
		if (text === void 0) continue;
		texts += 1;
		for (const item of privateTextBreaks(name, text, privates, {
			allow: home.allow,
			homes: home.on
		})) breaks.push(item);
		lines += text === "" ? 0 : text.replace(/\r?\n$/, "").split(/\r?\n/).length;
	}
	const read = `${String(commits.size)} commits${texts > 0 ? " and the text of the pull request" : ""}, ${String(lines)} lines read`;
	if (breaks.length === 0) {
		io.stderr(`conventions pre-push: ${read}, 0 breaks.\n`);
		return 0;
	}
	const out = [`conventions pre-push: ${read}, ${String(breaks.length)} breaks. ${stops}`];
	for (const item of breaks) {
		out.push(`  ${placeOf(item)}  ${item.message}`);
		if (item.fix !== void 0) out.push(`    fix: ${item.fix}`);
	}
	out.push(change ? "Remove each text from the commits (git commit --amend, or git rebase) and from the pull request. Then push again." : "Change the commits (git commit --amend, or git rebase), and push again.");
	io.stderr(`${out.join("\n")}\n`);
	return 1;
}
/**
* This function reads the arguments of the command `pre-push`. The git hook gives the name of the remote and its URL.
* A check in CI gives `--base <ref>` and, as an option, `--head <ref>`. The function gives undefined for other arguments.
*/
function parsePrePushArgs(args) {
	const positional = [];
	const range = {};
	for (let index = 0; index < args.length; index++) {
		const arg = args[index] ?? "";
		if (arg === "--base" || arg === "--head") {
			const value = args[++index];
			if (value === void 0 || value === "" || value.startsWith("-")) return void 0;
			range[arg === "--base" ? "base" : "head"] = value;
		} else if (arg.startsWith("-")) return void 0;
		else positional.push(arg);
	}
	const { base, head } = range;
	if (base !== void 0) return positional.length > 0 ? void 0 : {
		remote: "origin",
		base,
		...head === void 0 ? {} : { head }
	};
	const [remote, url] = positional;
	if (remote === void 0 || head !== void 0 || positional.length > 2) return void 0;
	return {
		remote,
		...url === void 0 ? {} : { url }
	};
}
/**
* The options of each git start of the check. With them, a git configuration starts no command: no hook, no external diff
* and no file system monitor. A textconv driver has its own name, so each diff command also gives `--no-textconv`.
*/
const SAFE_GIT_OPTIONS = [
	"-c",
	"core.hooksPath=/dev/null",
	"-c",
	"diff.external=",
	"-c",
	"core.fsmonitor=false"
];
/** This function gives the git function of the check in `root`: `runGit` with the safe options before the arguments. */
function checkGit(root) {
	return (args) => runGit(root, [...SAFE_GIT_OPTIONS, ...args]);
}
/**
* This function starts the command `pre-push` in the root of the git working tree of `io.cwd`. The bin and the bundle
* `private-names.mjs` of the shared actions use it. Only the git hook reads `io.stdin`. Each git start uses `checkGit`.
*/
function runPrePushArgs(args, io) {
	const top = checkGit(io.cwd)(["rev-parse", "--show-toplevel"])?.trim() ?? "";
	const root = top === "" ? io.cwd : top;
	const { remote, url, base, head } = args;
	return prePush({
		remote,
		...url === void 0 ? {} : { url },
		...base === void 0 ? {} : { base },
		...head === void 0 ? {} : { head },
		input: base === void 0 ? io.stdin ?? "" : "",
		env: io.env,
		root,
		git: checkGit(root)
	}, io);
}
/** The marker line of the hook that `conventions hook install` writes. The command rewrites only a hook with this line. */
const HOOK_MARKER = "# conventions hook: pre-push";
/** The first version of the package with the command `conventions pre-push`. */
const FIRST_PRE_PUSH_VERSION = "0.37.1";
/** This function gives the version of this package, from its package.json, or FIRST_PRE_PUSH_VERSION when it cannot read it. */
function ownVersion() {
	try {
		const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
		return typeof version === "string" && /^\d+\.\d+\.\d+/.test(version) ? version : FIRST_PRE_PUSH_VERSION;
	} catch {
		return FIRST_PRE_PUSH_VERSION;
	}
}
/**
* A Node program for the hook. Argument 1 is a package.json, and argument 2 is a version. The program exits 0 when the
* version of the package.json is the same as or later than argument 2, and 1 otherwise. A pre-release counts as its release. It has no single quote, so the shell
* gives it as one argument.
*/
const AT_LEAST = "let v;try{v=JSON.parse(require(\"fs\").readFileSync(process.argv[1],\"utf8\")).version}catch{process.exit(1)}const a=String(v).split(\"-\")[0].split(\".\").map(Number),b=process.argv[2].split(\".\").map(Number);for(let i=0;i<3;i++)if(a[i]!==b[i])process.exit(a[i]>b[i]?0:1);process.exit(0)";
/**
* The text of the hook `pre-push` that `conventions hook install` writes: a POSIX shell script.
*
* Git keeps one hooks folder for all worktrees of a repository, but each worktree has its own node_modules. A worktree
* of an older branch can have a conventions with no pre-push command (before 0.37.1). Then the hook starts the
* version that wrote it, with pnpm dlx. The hook stays closed: when no conventions can start, the push stops.
*/
const PRE_PUSH_HOOK = `#!/bin/sh
${HOOK_MARKER}
# The command "conventions hook install" wrote this file, and each install writes it again.
# The hook examines the new commits of each push with the private name list.
# All worktrees use this file. A worktree with a conventions older than ${FIRST_PRE_PUSH_VERSION} has no pre-push command,
# so then the hook starts the version that wrote it.
root="$(git rev-parse --show-toplevel)" || exit 1
bin="$root/node_modules/.bin/conventions"
pkg="$root/node_modules/@mark1russell7/conventions/package.json"
if [ -x "$bin" ] && node -e '${AT_LEAST}' "$pkg" ${FIRST_PRE_PUSH_VERSION} 2>/dev/null; then
  exec "$bin" pre-push "$@"
fi
exec pnpm dlx @mark1russell7/conventions@${ownVersion()} pre-push "$@"
`;

/**
* The entry of the bundle `private-names.mjs` of the shared actions (`tsdown.actions.config.ts`). The step "Private names
* of the change" of `reusable-ci.yml` starts it before the install. Thus the step that has the private name list runs
* no code of the repository or of its dependencies. The bundle takes `--base <ref>` and, as an option, `--head <ref>`, as
* `conventions pre-push` does in CI.
*/
const args = parsePrePushArgs(process.argv.slice(2));
const stderr = (text) => {
	process.stderr.write(text);
};
if (args?.base === void 0) {
	stderr("private-names.mjs: The bundle takes --base <ref> and, as an option, --head <ref>.\n");
	process.exitCode = 2;
} else process.exitCode = runPrePushArgs(args, {
	cwd: process.cwd(),
	env: process.env,
	stderr
});

export {  };
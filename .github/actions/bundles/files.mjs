// The bundle of src/files-bundle.ts of @mark1russell7/conventions. Do not edit: pnpm build:actions writes it.
/** The characters of a regular expression that a glob character escapes. */
const SPECIAL = /* @__PURE__ */ new Set([..."\\^$.|+()[]{}"]);
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
		out += SPECIAL.has(char) ? `\\${char}` : char;
		index++;
	}
	return out;
}
/** This function gives a regular expression that matches a whole relative path with `/` for `glob`. */
function globToRegExp(glob, options = {}) {
	return new RegExp(`^${source(normalize(glob), options.dot ?? true, true)}$`);
}
/** This function tells if the relative path `path` with `/` matches `glob`. */
function matchesGlob(path, glob, options = {}) {
	return globToRegExp(glob, options).test(path);
}

export { globToRegExp, matchesGlob };
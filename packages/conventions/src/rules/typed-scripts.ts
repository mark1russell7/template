/**
 * The rule `typed-scripts`: git keeps no JavaScript source and no shell script with logic. Each
 * script is TypeScript, which Node starts directly (type stripping), with types and tests like the code.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { byCode } from "../workspace.ts";
import type { Break, Rule } from "../rule.ts";

/** The interpreters of a `#!` line that make a file without an extension a script of a kind. */
const SHEBANG = /^#!\s*(?:\S*\/)?(?:env\s+(?:-\S+\s+)*)?(node|bash|sh|zsh|dash|ksh|pwsh)\b/;

/** This function gives the extension of a file with its dot, in lower case, or `""`. */
function extensionOf(file: string): string {
  const name = file.slice(file.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot).toLowerCase();
}

/** This function gives the lines of a shell script that do work: not empty, not a comment, not the `#!` line. */
export function codeLines(text: string): number {
  return text.split(/\r?\n/).filter((line) => {
    const trimmed = line.trim();
    return trimmed !== "" && !trimmed.startsWith("#");
  }).length;
}

/** This function reads the first line of a file, or `""` when the file cannot be read. */
function firstLine(path: string): string {
  try {
    const text = readFileSync(path, "utf8");
    const end = text.indexOf("\n");
    return end < 0 ? text : text.slice(0, end);
  } catch {
    return "";
  }
}

export const typedScripts: Rule = {
  id: "typed-scripts",
  title: "Git keeps no JavaScript source (`.js`, `.mjs`, `.cjs`, `.jsx`) and no shell script of more than one line of code: each script is TypeScript.",
  reason:
    "A script has bugs like the code, and types and tests find them. Node 22.18 and later runs a `.ts` file directly, so a script in JavaScript or in a shell language has no cost to save and no check. A shell file stays only as a launcher of one line.",
  fix: "Rename the file to `.ts`, add the types, and check it with `tsc --noEmit` and a test. Move the logic of a shell script into a `.ts` file, and keep the shell file as one line that starts it, or remove it. A file that must stay (generated output, vendored code, a configuration that a tool reads only as JavaScript) goes in `ignore` with its reason.",
  sources: [{ repo: "fleet", rule: "typed-everything", doc: "docs/STRATEGY.md:78" }],
  options: {
    javascript: { type: "strings", default: [".js", ".mjs", ".cjs", ".jsx"], description: "The extensions of JavaScript source." },
    shell: { type: "strings", default: [".sh", ".bash", ".zsh", ".ps1"], description: "The extensions of shell scripts." },
    shellLines: { type: "number", default: 1, description: "The most lines of code that a shell script can have: a launcher." },
  },
  check(context, options) {
    const files = context.gitFiles();
    if (files === undefined) return { skipped: "the root is not in a git repository" };
    const javascript = new Set(Array.isArray(options["javascript"]) ? options["javascript"] : []);
    const shell = new Set(Array.isArray(options["shell"]) ? options["shell"] : []);
    const limit = typeof options["shellLines"] === "number" ? options["shellLines"] : 1;
    const breaks: Break[] = [];
    for (const file of [...files].sort(byCode)) {
      let extension = extensionOf(file);
      if (extension === "") {
        const interpreter = SHEBANG.exec(firstLine(join(context.root, file)))?.[1];
        if (interpreter === undefined) continue;
        extension = interpreter === "node" ? ".js" : ".sh";
        if (!javascript.has(extension) && !shell.has(extension)) continue;
      }
      if (javascript.has(extension)) {
        breaks.push({ file, message: `${file} is JavaScript.`, fix: `Rename ${file} to .ts, add the types, and check it with tsc and a test.` });
      } else if (shell.has(extension)) {
        let lines = 0;
        try {
          lines = codeLines(readFileSync(join(context.root, file), "utf8"));
        } catch {
          continue;
        }
        if (lines > limit) {
          breaks.push({
            file,
            message: `${file} is a shell script with ${lines} lines of code (the most is ${limit}).`,
            fix: `Move the logic of ${file} into a .ts file, and keep ${file} as a launcher of ${limit} line(s), or remove it.`,
          });
        }
      }
    }
    return breaks;
  },
};

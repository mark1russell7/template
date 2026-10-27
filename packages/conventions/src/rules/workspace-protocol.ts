/**
 * The rule `workspace-protocol`: a package uses another package of the workspace through `workspace:`.
 */
import { keyLine, specifiersOf, type Break, type Rule } from "../rule.ts";

/** The fields that the rule examines. A peer dependency often keeps a range for its users, so the rule does not examine it. */
const FIELDS = ["dependencies", "devDependencies", "optionalDependencies"] as const;

export const workspaceProtocol: Rule = {
  id: "workspace-protocol",
  title: "A dependency on a package of this workspace uses the `workspace:` protocol.",
  reason:
    "A version range or a git ref of a package of the same repository gets an old copy from the registry or from git, not the source next to it. Then a change and its test do not meet.",
  fix: 'Use `"workspace:*"`. pnpm writes the real version when it publishes the package.',
  sources: [
    { repo: "client", rule: "workspace-protocol", doc: "CLAUDE.md:52" },
    { repo: "client", rule: "workspace-deps", doc: "CLAUDE.md:52" },
    { repo: "coeval", rule: "pinned-deps", doc: "CLAUDE.md:41" },
    { repo: "headroom", rule: "non-npm-deps-pinned", doc: "CLAUDE.md:38" },
    { repo: "crawler", rule: "mcp-workspace-dep", doc: "CLAUDE.md:55" },
  ],
  options: {
    prefix: { type: "string", default: "workspace:", description: 'The start of each specifier, for example "workspace:*" to refuse "workspace:^".' },
  },
  check(context, options) {
    const prefix = typeof options["prefix"] === "string" ? options["prefix"] : "workspace:";
    const names = new Set(context.packages.map((info) => info.manifest["name"]).filter((name): name is string => typeof name === "string"));
    const breaks: Break[] = [];
    for (const info of [context.rootPackage, ...context.packages]) {
      for (const field of FIELDS) {
        for (const [name, spec] of specifiersOf(info.manifest, field)) {
          if (!names.has(name) || name === info.manifest["name"] || spec.startsWith(prefix)) continue;
          const line = keyLine(info.text, field, name);
          breaks.push({
            file: info.file,
            ...(line === undefined ? {} : { line }),
            message: `${field} "${name}" is "${spec}", but "${name}" is a package of this workspace.`,
            fix: `Use "${prefix === "workspace:" ? "workspace:*" : prefix}".`,
          });
        }
      }
    }
    return breaks;
  },
};

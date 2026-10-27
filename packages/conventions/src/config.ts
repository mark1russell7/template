/**
 * The configuration of the check: the field `conventions` of the root `package.json`. Each exception
 * needs a reason: a rule that is off, files that a rule ignores, and a changed option. Thus each
 * exception is visible.
 */
import type { OptionValue, Options, Rule } from "./rule.ts";

/** The configuration of one rule, after the check of its fields. */
export interface RuleConfig {
  /** The reason why the rule is off. The rule is on when this field is missing. */
  readonly off?: string;
  /** The globs of files that the rule does not report. */
  readonly ignore: readonly string[];
  /** The reason of `ignore` or of the changed options. */
  readonly reason?: string;
  /** The options of the rule, with the defaults. */
  readonly options: Options;
}

/** The configuration of the check. */
export interface ConventionsConfig {
  /** The globs of the package folders. The default is the globs of the workspace. */
  readonly packages?: readonly string[];
  /** The configuration of each rule, by its id. */
  readonly rules: Readonly<Record<string, RuleConfig>>;
}

/** The fields of the configuration of a rule that are not options. */
const RULE_FIELDS = ["off", "ignore", "reason"];

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");

/** This function gives the options of a rule with their defaults. */
export function defaultOptions(rule: Rule): Options {
  return Object.fromEntries(Object.entries(rule.options).map(([name, spec]) => [name, spec.default]));
}

/**
 * This function reads the field `conventions` of the root `package.json` (`value`), and gives the
 * configuration of each rule of `rules`.
 *
 * @throws Error when the field has a wrong shape, an unknown rule or option, or an exception or a changed option without a reason
 */
export function parseConfig(value: unknown, rules: readonly Rule[]): ConventionsConfig {
  const byId = new Map(rules.map((rule) => [rule.id, rule]));
  const result: Record<string, RuleConfig> = {};
  for (const rule of rules) result[rule.id] = { ignore: [], options: defaultOptions(rule) };
  if (value === undefined) return { rules: result };
  if (!isObject(value)) throw new Error("The field conventions of package.json must be an object.");
  const unknown = Object.keys(value).filter((key) => key !== "packages" && key !== "rules" && key !== "$comment");
  if (unknown.length > 0) throw new Error(`conventions has unknown fields: ${unknown.join(", ")}.`);
  const packages = value["packages"];
  if (packages !== undefined && !isStrings(packages)) throw new Error("conventions.packages must be an array of globs.");
  const rulesValue = value["rules"] ?? {};
  if (!isObject(rulesValue)) throw new Error("conventions.rules must be an object, with a rule id for each key.");
  for (const [id, entry] of Object.entries(rulesValue)) {
    const rule = byId.get(id);
    if (rule === undefined) throw new Error(`conventions.rules has an unknown rule: ${id}. The rules are: ${[...byId.keys()].join(", ")}.`);
    const where = `conventions.rules["${id}"]`;
    if (!isObject(entry)) throw new Error(`${where} must be an object, for example { "off": "<reason>" }.`);
    const off = entry["off"];
    if (off !== undefined && (typeof off !== "string" || off.trim() === "")) throw new Error(`${where}.off must be the reason why the rule is off, as text.`);
    const ignore = entry["ignore"] ?? [];
    if (!isStrings(ignore)) throw new Error(`${where}.ignore must be an array of globs.`);
    const reason = entry["reason"];
    if (reason !== undefined && (typeof reason !== "string" || reason.trim() === "")) throw new Error(`${where}.reason must be text.`);
    if (ignore.length > 0 && reason === undefined) throw new Error(`${where}.ignore needs a reason: add "reason": "<why these files are an exception>".`);
    const options: Record<string, OptionValue> = { ...defaultOptions(rule) };
    const changed: string[] = [];
    for (const [name, option] of Object.entries(entry)) {
      if (RULE_FIELDS.includes(name)) continue;
      const spec = rule.options[name];
      if (spec === undefined) {
        const known = [...RULE_FIELDS, ...Object.keys(rule.options)].join(", ");
        throw new Error(`${where} has an unknown field: ${name}. The fields are: ${known}.`);
      }
      const good = spec.type === "strings" ? isStrings(option) : typeof option === spec.type;
      if (!good) throw new Error(`${where}.${name} must be ${spec.type === "strings" ? "an array of strings" : `a ${spec.type}`}.`);
      options[name] = option as OptionValue;
      changed.push(name);
    }
    // A changed option can make a rule weaker, so it needs a reason, as `ignore` does
    if (changed.length > 0 && reason === undefined && off === undefined) {
      throw new Error(`${where} changes the option${changed.length > 1 ? "s" : ""} ${changed.join(", ")}, and needs a reason: add "reason": "<why this repository changes the default>".`);
    }
    result[id] = {
      ...(off === undefined ? {} : { off }),
      ignore,
      ...(reason === undefined ? {} : { reason }),
      options,
    };
  }
  return { ...(packages === undefined ? {} : { packages }), rules: result };
}

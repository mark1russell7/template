/**
 * An evaluator of the `if` conditions of GitHub workflows, for the workflow explorer. A value that is known only when
 * the workflow starts (the outputs of a step, the result of a job) is `UNKNOWN`. Thus a condition is true, false or
 * unknown. The evaluator knows the operators `!`, `==`, `!=`, `<`, `<=`, `>`, `>=`, `&&`, `||` and the parentheses.
 * It knows the functions `always`, `success`, `failure`, `cancelled`, `contains`, `startsWith`, `endsWith` and `fromJSON`.
 */

/** A value that the page cannot know before the workflow runs. */
export const UNKNOWN: unique symbol = Symbol("unknown");

/** A value of an expression. */
export type Value = string | number | boolean | null | typeof UNKNOWN;

/** A context value that a condition reads, and its value. */
export interface Reference {
  readonly path: string;
  readonly value: Value;
}

/** The result of a condition: its value, and the context values that it read. */
export interface Result {
  readonly value: Value;
  readonly refs: readonly Reference[];
}

type Token = { kind: "op" | "str" | "num" | "id"; text: string };

const TOKEN = /\s*(?:(\|\||&&|==|!=|<=|>=|[!<>(),])|'((?:[^']|'')*)'|(-?\d+(?:\.\d+)?)|([A-Za-z_][\w-]*(?:\.[A-Za-z_*][\w-]*)*))/y;

/** This function splits an expression into its tokens. */
function tokens(text: string): Token[] {
  const list: Token[] = [];
  TOKEN.lastIndex = 0;
  let index = 0;
  while (index < text.length) {
    if (text.slice(index).trim() === "") break;
    TOKEN.lastIndex = index;
    const match = TOKEN.exec(text);
    if (!match) throw new Error(`The expression has an unknown part at ${index}: ${text.slice(index, index + 20)}`);
    index = TOKEN.lastIndex;
    if (match[1] !== undefined) list.push({ kind: "op", text: match[1] });
    else if (match[2] !== undefined) list.push({ kind: "str", text: match[2].replace(/''/g, "'") });
    else if (match[3] !== undefined) list.push({ kind: "num", text: match[3] });
    else if (match[4] !== undefined) list.push({ kind: "id", text: match[4] });
  }
  return list;
}

/** This function tells if a known value is true for GitHub: false, 0, an empty text and null are false. */
export const truthy = (value: Exclude<Value, typeof UNKNOWN>): boolean => value !== false && value !== 0 && value !== "" && value !== null && !Number.isNaN(value);

const toNumber = (value: Exclude<Value, typeof UNKNOWN>): number => {
  if (value === null) return 0;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string") return value.trim() === "" ? 0 : Number(value);
  return value;
};

/** This function compares two values as GitHub does: texts with no case, other types as numbers. */
function compare(a: Value, b: Value, op: string): Value {
  if (a === UNKNOWN || b === UNKNOWN) return UNKNOWN;
  if (typeof a === "string" && typeof b === "string") {
    const x = a.toLowerCase();
    const y = b.toLowerCase();
    return op === "==" ? x === y : op === "!=" ? x !== y : op === "<" ? x < y : op === "<=" ? x <= y : op === ">" ? x > y : x >= y;
  }
  const x = toNumber(a);
  const y = toNumber(b);
  return op === "==" ? x === y : op === "!=" ? x !== y : op === "<" ? x < y : op === "<=" ? x <= y : op === ">" ? x > y : x >= y;
}

const text = (value: Value): string | typeof UNKNOWN => (value === UNKNOWN ? UNKNOWN : value === null ? "" : String(value));

/** This function applies a function of the expression language. A function that the evaluator does not know gives `UNKNOWN`. */
function call(name: string, args: readonly Value[]): Value {
  switch (name.toLowerCase()) {
    // The explorer supposes that each step before passes.
    case "always":
    case "success":
      return true;
    case "failure":
    case "cancelled":
      return false;
    case "contains":
    case "startswith":
    case "endswith": {
      const a = text(args[0] ?? null);
      const b = text(args[1] ?? null);
      if (a === UNKNOWN || b === UNKNOWN) return UNKNOWN;
      const x = a.toLowerCase();
      const y = b.toLowerCase();
      return name.toLowerCase() === "contains" ? x.includes(y) : name.toLowerCase() === "startswith" ? x.startsWith(y) : x.endsWith(y);
    }
    case "fromjson": {
      const a = args[0];
      if (typeof a !== "string") return UNKNOWN;
      try {
        const parsed: unknown = JSON.parse(a);
        return typeof parsed === "object" && parsed !== null ? UNKNOWN : (parsed as Value);
      } catch {
        return UNKNOWN;
      }
    }
    default:
      return UNKNOWN;
  }
}

/**
 * This function evaluates a condition. `lookup` gives the value of a context path, for example `inputs.deploy`. An
 * empty condition is true, as in GitHub. A condition in `${{ }}` is the same as without it.
 *
 * @throws Error when the condition has a part that the evaluator does not know
 */
export function evaluate(condition: string, lookup: (path: string) => Value): Result {
  const source = condition.trim().replace(/^\$\{\{([\s\S]*)\}\}$/, "$1");
  if (source.trim() === "") return { value: true, refs: [] };
  const list = tokens(source);
  const refs: Reference[] = [];
  let at = 0;
  const peek = (): Token | undefined => list[at];
  const take = (op?: string): Token => {
    const token = list[at];
    if (token === undefined || (op !== undefined && token.text !== op)) throw new Error(`The expression needs "${op ?? "a value"}" at token ${at}: ${source}`);
    at += 1;
    return token;
  };

  const primary = (): Value => {
    const token = take();
    if (token.kind === "str") return token.text;
    if (token.kind === "num") return Number(token.text);
    if (token.kind === "op" && token.text === "(") {
      const value = or();
      take(")");
      return value;
    }
    if (token.kind === "op" && token.text === "!") {
      const value = primary();
      return value === UNKNOWN ? UNKNOWN : !truthy(value);
    }
    if (token.kind !== "id") throw new Error(`The expression has "${token.text}" where it needs a value: ${source}`);
    if (token.text === "true" || token.text === "false") return token.text === "true";
    if (token.text === "null") return null;
    if (peek()?.text === "(") {
      take("(");
      const args: Value[] = [];
      while (peek()?.text !== ")") {
        args.push(or());
        if (peek()?.text === ",") take(",");
      }
      take(")");
      return call(token.text, args);
    }
    const value = lookup(token.text);
    if (!refs.some((r) => r.path === token.text)) refs.push({ path: token.text, value });
    return value;
  };

  const comparison = (): Value => {
    const left = primary();
    const op = peek();
    if (op?.kind === "op" && ["==", "!=", "<", "<=", ">", ">="].includes(op.text)) {
      at += 1;
      return compare(left, primary(), op.text);
    }
    return left;
  };

  const and = (): Value => {
    let value = comparison();
    while (peek()?.text === "&&") {
      at += 1;
      const right = comparison();
      if (value === UNKNOWN) value = right !== UNKNOWN && !truthy(right) ? right : UNKNOWN;
      else if (truthy(value)) value = right;
    }
    return value;
  };

  function or(): Value {
    let value = and();
    while (peek()?.text === "||") {
      at += 1;
      const right = and();
      if (value === UNKNOWN) value = right !== UNKNOWN && truthy(right) ? right : UNKNOWN;
      else if (!truthy(value)) value = right;
    }
    return value;
  }

  const value = or();
  if (at < list.length) throw new Error(`The expression has more after token ${at}: ${source}`);
  return { value, refs };
}

/** This function gives the state of a condition: the step starts, it does not start, or only the workflow run can tell. */
export function stateOf(value: Value): "runs" | "skipped" | "unknown" {
  if (value === UNKNOWN) return "unknown";
  return truthy(value) ? "runs" : "skipped";
}

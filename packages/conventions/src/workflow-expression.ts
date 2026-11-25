/**
 * A small reader of the expressions of GitHub Actions (`${{ ... }}`) for one event. It answers two questions of the runner
 * budget. The first question: which parts of a run does a concurrency group depend on (the branch, the commit or the run)?
 * The second question: can a job run on an event (its `if`)? The reader knows the literals, the contexts, the operators
 * (`!`, `==`, `!=`, `<`, `<=`, `>`, `>=`, `&&`, `||`), the brackets and the calls of functions. It does not know the value of
 * a context, except `github.event_name`, and if `github.head_ref` is empty.
 */

/**
 * A part of a run that a value depends on. `ref` is the branch or the pull request, and `commit` is the commit. `run` is
 * the run (`github.run_id`), `input` is an input of the run, and `other` is another context.
 */
export type RunPart = "ref" | "commit" | "run" | "input" | "other";

/** A value of an expression: its parts, and if it is truthy (true, false, or unknown). */
export interface ExpressionValue {
  readonly parts: ReadonlySet<RunPart>;
  readonly truthy: boolean | undefined;
  /** The text of a value that the reader knows, for `==` and `!=`. */
  readonly text?: string;
}

/** The events of a pull request: `github.head_ref` is not empty only on these. */
const PULL_REQUEST_EVENTS: ReadonlySet<string> = new Set(["pull_request", "pull_request_target", "pull_request_review", "pull_request_review_comment"]);

const literal = (text: string, truthy: boolean): ExpressionValue => ({ parts: new Set(), truthy, text });
const unknownBool: ExpressionValue = { parts: new Set(), truthy: undefined };
const union = (a: ExpressionValue, b: ExpressionValue): ExpressionValue => ({ parts: new Set([...a.parts, ...b.parts]), truthy: a.truthy === b.truthy ? a.truthy : undefined });

/** This function gives the part of a context path (lower case, with dots), or undefined for `github.event_name`. */
function partOf(path: string): RunPart {
  if (/^github\.(ref|ref_name|head_ref|base_ref)$/.test(path) || /^github\.event\.(number|pull_request\.(number|head\.ref))$/.test(path)) return "ref";
  if (/^github\.(sha|event\.after|event\.pull_request\.head\.sha)$/.test(path)) return "commit";
  if (/^github\.run_(id|number|attempt)$/.test(path)) return "run";
  if (/^(inputs|github\.event\.inputs)(\.|$)/.test(path)) return "input";
  return "other";
}

/** This function gives the value of a context path on the event. */
function contextValue(path: string, event: string): ExpressionValue {
  const name = path.toLowerCase();
  if (name === "github.event_name") return literal(event, event !== "");
  // The workflow, the repository and the actor are the same for each run of a burst: they split no group.
  if (/^github\.(workflow|repository|repository_owner|event\.repository\.\w+)$/.test(name)) return { parts: new Set(), truthy: true };
  if (name === "github.head_ref") return { parts: new Set(["ref"]), truthy: PULL_REQUEST_EVENTS.has(event) };
  const part = partOf(name);
  return { parts: new Set([part]), truthy: part === "ref" || part === "commit" || part === "run" ? true : undefined };
}

type Token = { readonly kind: "string" | "number" | "name" | "op"; readonly text: string };

/** This function gives the tokens of an expression, or undefined when it has a character that GitHub does not take. */
function tokensOf(body: string): Token[] | undefined {
  const tokens: Token[] = [];
  let at = 0;
  while (at < body.length) {
    const rest = body.slice(at);
    const space = /^\s+/.exec(rest);
    if (space) {
      at += space[0].length;
      continue;
    }
    const match =
      /^'((?:[^']|'')*)'/.exec(rest) ?? /^(-?\d+(?:\.\d+)?)/.exec(rest) ?? /^([A-Za-z_][\w-]*(?:\s*(?:\.\s*[A-Za-z_*][\w-]*|\[\s*'(?:[^']|'')*'\s*\]|\[\s*\*\s*\]))*)/.exec(rest) ?? /^(&&|\|\||==|!=|<=|>=|[!<>(),])/.exec(rest);
    if (!match) return undefined;
    const text = match[0];
    const kind = text.startsWith("'") ? "string" : /^-?\d/.test(text) ? "number" : /^[A-Za-z_]/.test(text) ? "name" : "op";
    tokens.push({ kind, text: kind === "string" ? (match[1] ?? "").replaceAll("''", "'") : text });
    at += text.length;
  }
  return tokens;
}

/** This function gives the path of a context name: lower case, with dots, and `['x']` as `.x`. */
const pathOf = (name: string): string =>
  name
    .replace(/\s+/g, "")
    .replace(/\['((?:[^']|'')*)'\]/g, (_, key: string) => `.${key.replaceAll("''", "'")}`)
    .toLowerCase();

/** This function reads an expression on the event. It gives undefined when the expression does not parse. */
export function evaluateExpression(body: string, event: string): ExpressionValue | undefined {
  const tokens = tokensOf(body);
  if (tokens === undefined || tokens.length === 0) return undefined;
  let at = 0;
  const peek = (): Token | undefined => tokens[at];
  const take = (text: string): boolean => {
    if (peek()?.kind === "op" && peek()?.text === text) {
      at++;
      return true;
    }
    return false;
  };
  const primary = (): ExpressionValue | undefined => {
    const token = tokens[at++];
    if (token === undefined) return undefined;
    if (token.kind === "string") return literal(token.text, token.text !== "");
    if (token.kind === "number") return literal(String(Number(token.text)), Number(token.text) !== 0);
    if (token.kind === "op") {
      if (token.text !== "(") return undefined;
      const inner = or();
      return inner !== undefined && take(")") ? inner : undefined;
    }
    const name = token.text.toLowerCase();
    if (name === "true" || name === "false") return literal(name, name === "true");
    if (name === "null") return literal("", false);
    if (!take("(")) return contextValue(pathOf(token.text), event);
    const args: ExpressionValue[] = [];
    if (!take(")")) {
      do {
        const arg = or();
        if (arg === undefined) return undefined;
        args.push(arg);
      } while (take(","));
      if (!take(")")) return undefined;
    }
    const parts = new Set(args.flatMap((arg) => [...arg.parts]));
    if (name === "format" || name === "join" || name === "tojson") return { parts, truthy: name === "format" ? undefined : true };
    if (name === "contains" || name === "startswith" || name === "endswith" || name === "always" || name === "success" || name === "failure" || name === "cancelled") return unknownBool;
    return { parts, truthy: undefined };
  };
  const not = (): ExpressionValue | undefined => {
    if (!take("!")) return primary();
    const value = not();
    return value === undefined ? undefined : { parts: new Set(), truthy: value.truthy === undefined ? undefined : !value.truthy };
  };
  const compare = (): ExpressionValue | undefined => {
    const left = not();
    if (left === undefined) return undefined;
    const op = peek();
    if (op?.kind !== "op" || !["==", "!=", "<", "<=", ">", ">="].includes(op.text)) return left;
    at++;
    const right = not();
    if (right === undefined) return undefined;
    // GitHub compares texts with no case.
    if ((op.text === "==" || op.text === "!=") && left.text !== undefined && right.text !== undefined) {
      const same = left.text.toLowerCase() === right.text.toLowerCase();
      return literal(String(same === (op.text === "==")), same === (op.text === "=="));
    }
    return unknownBool;
  };
  const and = (): ExpressionValue | undefined => {
    let left = compare();
    while (left !== undefined && take("&&")) {
      const right = compare();
      if (right === undefined) return undefined;
      left = left.truthy === false ? left : left.truthy === true ? right : union(left, right);
    }
    return left;
  };
  const or = (): ExpressionValue | undefined => {
    let left = and();
    while (left !== undefined && take("||")) {
      const right = and();
      if (right === undefined) return undefined;
      left = left.truthy === true ? left : left.truthy === false ? right : union(left, right);
    }
    return left;
  };
  const value = or();
  return value !== undefined && at === tokens.length ? value : undefined;
}

/** This function gives the bodies of the expressions of a text (the parts between `${{` and `}}`). */
function bodiesOf(text: string): string[] {
  // A scan with indexOf takes linear time. A lazy regular expression can take polynomial time on a text such as "${{${{${{".
  const bodies: string[] = [];
  let at = text.indexOf("${{");
  while (at >= 0) {
    const end = text.indexOf("}}", at + 3);
    if (end < 0) break;
    bodies.push(text.slice(at + 3, end));
    at = text.indexOf("${{", end + 2);
  }
  return bodies;
}

/**
 * This function gives the parts of a run that a concurrency group depends on, on the event. A group with no expression
 * depends on no part: all runs share it. An expression that does not parse depends on the run, so each run has its own group.
 */
export function groupParts(group: string, event: string): ReadonlySet<RunPart> {
  const parts = new Set<RunPart>();
  for (const body of bodiesOf(group)) {
    const value = evaluateExpression(body, event);
    if (value === undefined) parts.add("run");
    else for (const part of value.parts) parts.add(part);
  }
  return parts;
}

/**
 * This function tells if a job with the condition `condition` (an `if`, with or with no `${{ }}`) can run on the event.
 * It is false only when the condition is false on each run of the event.
 */
export function mayRun(condition: string, event: string): boolean {
  const text = condition.trim();
  if (text === "") return true;
  const whole = /^\$\{\{([\s\S]*)\}\}$/.exec(text);
  const value = evaluateExpression(whole ? (whole[1] ?? "") : text, event);
  return value?.truthy !== false;
}

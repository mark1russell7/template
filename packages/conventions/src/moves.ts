/**
 * The repositories that moved to another owner. GitHub sends a web or API request for the old name to the new
 * name, but a call of a reusable workflow or an action (`uses: owner/repo/...@ref`) does not follow that redirect.
 * The run then fails before it starts, with "workflow file issue". The rule `moved-repo-calls` reads this table.
 *
 * The move procedure adds a row for each move. The rows come from the GitHub API: `gh api repos/<from>` gives the
 * `full_name` `<to>`. Each owner and name is in lower case, because GitHub compares them without case.
 */

/** A move of a repository: the old `owner/name` and the new one. */
export interface RepoMove {
  readonly from: string;
  readonly to: string;
}

/** Each known move. Read on 2026-11-25 from `gh api repos/mark1russell7/<name>` for each repository of metrograph-labs. */
export const MOVES: readonly RepoMove[] = [
  { from: "mark1russell7/alerts", to: "metrograph-labs/alerts" },
  { from: "mark1russell7/capacity", to: "metrograph-labs/capacity" },
  { from: "mark1russell7/codeatlas", to: "metrograph-labs/codeatlas" },
  { from: "mark1russell7/highways", to: "metrograph-labs/highways" },
  { from: "mark1russell7/ireko", to: "metrograph-labs/ireko" },
  { from: "mark1russell7/layout-contract", to: "metrograph-labs/layout-contract" },
  { from: "mark1russell7/netdiag", to: "metrograph-labs/netdiag" },
  { from: "mark1russell7/packing", to: "metrograph-labs/packing" },
  { from: "mark1russell7/systems", to: "metrograph-labs/systems" },
  { from: "mark1russell7/typeset", to: "metrograph-labs/typeset" },
  { from: "mark1russell7/vex", to: "metrograph-labs/vex" },
];

/**
 * This function reads a move in the form `owner/name=owner/name`, as the option `moves` of the rule gives it, or gives
 * undefined when the text has another form.
 */
export function parseMove(text: string): RepoMove | undefined {
  const match = /^\s*([\w.-]+\/[\w.-]+)\s*=\s*([\w.-]+\/[\w.-]+)\s*$/.exec(text);
  if (match === null) return undefined;
  return { from: (match[1] ?? "").toLowerCase(), to: (match[2] ?? "").toLowerCase() };
}

/**
 * This function gives the last place of a repository after each move of `moves`, or undefined when it did not move. A
 * chain of moves (a to b, then b to c) gives c. A loop stops at the first repeat.
 */
export function movedTo(repo: string, moves: readonly RepoMove[]): string | undefined {
  const next = new Map(moves.map((move) => [move.from.toLowerCase(), move.to.toLowerCase()]));
  const seen = new Set<string>();
  let at = repo.toLowerCase();
  while (next.has(at) && !seen.has(at)) {
    seen.add(at);
    at = next.get(at) ?? at;
  }
  return at === repo.toLowerCase() ? undefined : at;
}

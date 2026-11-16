/**
 * The owners of the repositories: the GitHub accounts that hold them. Each account has its own pool of concurrent jobs, so
 * a repository can move from one owner to the other. A reader of all repositories reads each owner, and a gate of the
 * runners keeps one lane for each owner. Thus no reader names an owner in its code. This file has no import, so a workflow
 * with a sparse checkout and no install can import it from the source.
 */

/** A GitHub account that holds repositories. */
export interface Owner {
  /** The login of the account. */
  readonly login: string;
  /** The kind of the account. The path `users/<login>/repos` of the API lists the repositories of both kinds. */
  readonly kind: "user" | "organization";
  /** The plan of the account. */
  readonly plan: "pro" | "team";
  /** The concurrent jobs of the plan: 40 for GitHub Pro, 60 for an organization on GitHub Team. */
  readonly jobs: number;
  /** The concurrent macOS jobs of the plan. */
  readonly macos: number;
}

/**
 * The owners, the personal account first. The organization got the plan Team on 2026-11-16, with its own pool of 60 jobs.
 * An owner with no public repository adds no read.
 */
export const OWNERS: readonly Owner[] = [
  { login: "mark1russell7", kind: "user", plan: "pro", jobs: 40, macos: 5 },
  { login: "metrograph-labs", kind: "organization", plan: "team", jobs: 60, macos: 5 },
];

/** This function gives the owner with this login, with no regard to case, or undefined. */
export function ownerOf(login: string): Owner | undefined {
  return OWNERS.find((owner) => owner.login.toLowerCase() === login.toLowerCase());
}

/** This function reads a list of logins with commas. An empty value gives the login of each owner of `OWNERS`. */
export function ownersOf(value: string | undefined): string[] {
  const named = (value ?? "")
    .split(",")
    .map((login) => login.trim())
    .filter(Boolean);
  return named.length > 0 ? [...new Set(named)] : OWNERS.map((owner) => owner.login);
}

/**
 * This function gives each repository name that more than one owner has, in lower case and in order. A reader that keys
 * its records by the name of the repository must stop on such a name, because the two repositories become one record.
 */
export function sharedNames(repos: readonly { readonly owner: string; readonly name: string }[]): string[] {
  const owners = new Map<string, Set<string>>();
  for (const repo of repos) {
    const name = repo.name.toLowerCase();
    owners.set(name, (owners.get(name) ?? new Set<string>()).add(repo.owner.toLowerCase()));
  }
  return [...owners]
    .filter(([, logins]) => logins.size > 1)
    .map(([name]) => name)
    .sort();
}

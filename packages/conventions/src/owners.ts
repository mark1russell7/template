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
 * This function gives each repository name that more than one owner has, in lower case and in order. If a reader keys its
 * records by the name alone, the two repositories of such a name become one record. Thus the reader takes its keys from
 * `repoKeyer`.
 */
export function sharedNames(repos: readonly RepoRef[]): string[] {
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

/** A repository: the login of its owner and its name, as the API gives them. */
export interface RepoRef {
  /** The login of the owner. */
  readonly owner: string;
  /** The name of the repository. */
  readonly name: string;
}

/**
 * This function gives the record key of each repository of a list. The key is the name when one owner has the name, and
 * `owner/name` when more than one owner has it (see `sharedNames`).
 *
 * - The records of a name that one owner has keep the key that they had before the second owner came.
 * - Two repositories with one name become two records, so a fork in the other owner stops no reader.
 * - The key of a repository that is not in the list is its name, unless the list has its name with more than one owner.
 * - The separator is `/` by default. A key for a file name or a database id takes a separator that no login and no name has, for example `~`.
 * - A separator that a login or a name can have gives an error, because two keys can then be equal.
 */
export function repoKeyer(repos: readonly RepoRef[], separator: string = "/"): (repo: RepoRef) => string {
  if (separator === "" || /[A-Za-z0-9._-]/u.test(separator)) {
    throw new Error(`The separator "${separator}" is empty or has a character that a login or a repository name can have.`);
  }
  const shared = new Set(sharedNames(repos));
  return (repo) => (shared.has(repo.name.toLowerCase()) ? `${repo.owner}${separator}${repo.name}` : repo.name);
}

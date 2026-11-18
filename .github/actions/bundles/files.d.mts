
/**
 * The entry of the bundle `files.mjs` of the shared actions: the glob functions of `@mark1russell7/files`. A script of
 * an action imports the bundle, because it starts with no install.
 */
/**
 * Globs: a glob pattern to a regular expression, with no file system access.
 *
 * The syntax:
 *
 * - `*` matches characters in one segment of a path.
 * - `**` as a whole segment matches zero or more segments. Thus `a/**` matches `a`, and `**\/b` matches `b`.
 * - `?` matches one character of a segment.
 * - `[abc]` or `[!abc]` matches one character of a set, or one character that is not in the set.
 * - `{a,b}` matches one of the alternatives. The alternatives can have globs and groups.
 *
 * A pattern uses `/`. The functions read a `\` as `/`, and they remove a leading `./`.
 */
/** The options of a match. */
interface GlobOptions {
  /**
   * The value `true` (the default) lets `*`, `?`, `**` and a set match a `.` at the start of a segment.
   * With `false`, a dot entry matches only a pattern segment that starts with `.`, as in a shell.
   */
  readonly dot?: boolean | undefined;
}
/** This function gives a regular expression that matches a whole relative path with `/` for `glob`. */
export declare function globToRegExp(glob: string, options?: GlobOptions): RegExp;
/** This function tells if the relative path `path` with `/` matches `glob`. */
export declare function matchesGlob(path: string, glob: string, options?: GlobOptions): boolean;
export type { GlobOptions };
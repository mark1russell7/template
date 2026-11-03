/**
 * The probe of `site-pages check` in TypeScript. A probe source can be TypeScript, so the typecheck of the site examines it.
 * The check removes its types before it runs the probe, so a site needs no build step for its probe.
 */

import { stripTypeScriptTypes } from "node:module";

/** A probe file in TypeScript: `.ts`, `.mts` or `.cts`. */
export const TYPESCRIPT_PROBE: RegExp = /\.[cm]?ts$/i;

/**
 * This function gives the JavaScript of a probe in TypeScript. It removes the types, and the line `export {};` that makes the
 * file a module for the typecheck. Each line stays at its position, so the line of an error is the line of the source. Syntax
 * that is not only types (an `enum`, a `namespace`) causes an error.
 */
export function probeScript(source: string): string {
  return stripTypeScriptTypes(source, { mode: "strip" }).replace(/^export \{\s*\};?[ \t]*$/m, "");
}

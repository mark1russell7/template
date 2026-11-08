// Tests that the site config and the Pages workflows agree: each key of the site config is an input of
// reusable-pages.yml with the same default, so a caller with no .github/site.json keeps its site.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { SITE_CONFIG_KEYS } from "../../packages/site-pages/src/config/site-config.ts";

const workflows = join(import.meta.dirname, "..", "..", ".github", "workflows");
const pages = readFileSync(join(workflows, "reusable-pages.yml"), "utf8");

/** This function gives the default of one input of a workflow file, or undefined when the input has no default. */
function defaultOf(workflow: string, key: string): unknown {
  const block = new RegExp(`\\n      ${key}:\\n((?:        .*\\n)*)`).exec(workflow);
  if (block === null) return undefined;
  const line = /^        default: (.*)$/m.exec(block[1] ?? "");
  if (line === null) return undefined;
  const text = (line[1] ?? "").trim();
  if (text === "true") return true;
  if (text === "false") return false;
  return text.startsWith('"') ? (JSON.parse(text) as string) : text;
}

describe("the site config and reusable-pages.yml", () => {
  it("gives each key of the site config the default of the input of the same name", () => {
    for (const [key, spec] of Object.entries(SITE_CONFIG_KEYS)) {
      const value = defaultOf(pages, key);
      assert.notEqual(value, undefined, `reusable-pages.yml has the input ${key} with a default`);
      assert.deepEqual(key === "env" ? (JSON.parse(value as string) as unknown) : value, spec.default, `the default of ${key}`);
    }
  });
});

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Script } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import { BARE_ERROR_SHAPE, BARE_ERROR_WATCH, BARE_ERRORS, readBareErrorMode } from "./bare-errors.ts";

const shape = new RegExp(BARE_ERROR_SHAPE);

describe("BARE_ERROR_SHAPE", () => {
  it("matches the text of a thrown value and the messages of the browser", () => {
    for (const text of [
      "Error: boom",
      "TypeError: Failed to fetch",
      "The save failed (DOMException: The operation was aborted.)",
      "Failed to fetch",
      "NetworkError when attempting to fetch resource.",
      "Cannot read properties of undefined (reading 'id')",
      "items.map is not a function",
      "[object Object]",
      "Unexpected token '<' in JSON at position 0",
    ]) {
      expect(shape.test(text), text).toBe(true);
    }
  });

  it("does not match a sentence about an error", () => {
    for (const text of ["No error: the save worked.", "The job failed, and the view shows why.", "Errors: 0", "Try again", "MyErrorHandler is ready"]) {
      expect(shape.test(text), text).toBe(false);
    }
  });
});

describe("the page scripts", () => {
  it("are valid scripts", () => {
    expect(() => new Script(BARE_ERROR_WATCH)).not.toThrow();
    expect(() => new Script(BARE_ERRORS)).not.toThrow();
  });
});

describe("readBareErrorMode", () => {
  let folder: string | undefined;
  afterEach(() => {
    if (folder) rmSync(folder, { recursive: true, force: true });
    folder = undefined;
  });
  const manifest = (text: string): string => {
    folder = mkdtempSync(join(tmpdir(), "bare-errors-"));
    writeFileSync(join(folder, "package.json"), text);
    return folder;
  };

  it("gives report with no package.json, no field or a broken file", () => {
    expect(readBareErrorMode(join(tmpdir(), "no-such-folder-of-site-pages"))).toBe("report");
    expect(readBareErrorMode(manifest(JSON.stringify({ name: "x" })))).toBe("report");
  });

  it("gives the value of the field", () => {
    expect(readBareErrorMode(manifest(JSON.stringify({ sitePages: { bareErrors: "fail" } })))).toBe("fail");
  });

  it("gives an Error for another value", () => {
    expect(readBareErrorMode(manifest(JSON.stringify({ sitePages: { bareErrors: "warn" } })))).toEqual(
      new Error(`the field sitePages.bareErrors of package.json must be fail or report, not "warn"`),
    );
  });
});

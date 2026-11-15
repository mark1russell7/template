import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findBrowser, launch, NoReplyError, type Browser } from "./browser.ts";

const executable = findBrowser();
if (executable === undefined && process.env["CI"]) throw new Error("CI has no Chromium browser for the tests of the page calls");

describe.skipIf(executable === undefined)("a call of a function in the page", () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await launch(executable as string, 30_000);
    await browser.page.send("Runtime.enable");
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  it("gives each value to the function as an argument, not as text of the code", async () => {
    const text = `"); globalThis.hit = true; ("</script> `;
    const reply = await browser.page.call<[string, { a: number[] }, boolean]>(
      "function (text, data) { return [text, data, globalThis.hit === true]; }",
      text,
      { a: [1, 2] },
    );
    expect(reply).toEqual([text, { a: [1, 2] }, false]);
  });

  it("waits for a promise of the function", async () => {
    expect(await browser.page.call<number>("async function (n) { await new Promise((go) => setTimeout(go, 10)); return n + 1; }", 41)).toBe(42);
  });

  it("throws with the message of an exception in the page", async () => {
    await expect(browser.page.call("function (text) { throw new Error(text); }", "no link")).rejects.toThrow("no link");
  });
});

describe.skipIf(executable === undefined)("a call of the page with no reply", () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await launch(executable as string, 30_000, 500);
    await browser.page.send("Runtime.enable");
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  it("fails after the time limit of a call with the method in its message, and the next call has its reply", async () => {
    const hang = browser.page.evaluate("new Promise(() => {})");
    await expect(hang).rejects.toBeInstanceOf(NoReplyError);
    await expect(hang).rejects.toThrow("the browser did not answer Runtime.evaluate in 500 ms");
    expect(await browser.page.evaluate<number>("1 + 1")).toBe(2);
  });
});

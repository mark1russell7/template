import { describe, expect, it } from "vitest";
import { probeScript, TYPESCRIPT_PROBE } from "./probe.ts";

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (body: string) => () => Promise<unknown>;

const SOURCE = [
  "declare const check: (name: string, ok: unknown, detail?: unknown) => boolean;",
  "declare const $: (selector: string) => HTMLElement | null;",
  "",
  "const out = $(\"#out\") as HTMLElement | null;",
  "check(\"the output has text\", (out?.textContent ?? \"\").length > 0);",
  "",
  "export {};",
  "check(\"a second check\", true);",
].join("\n");

describe("probeScript", () => {
  it("removes the types and the export line, and keeps each line at its position", () => {
    const script = probeScript(SOURCE);
    expect(script).not.toMatch(/declare|as HTMLElement|export/);
    expect(script.split("\n")).toHaveLength(SOURCE.split("\n").length);
    expect(script.split("\n")[4]).toContain('check("the output has text"');
    expect(script.split("\n")[7]).toBe('check("a second check", true);');
  });

  it("gives the body of an async function that runs", async () => {
    const seen: string[] = [];
    const body = `const check = (name) => { seen.push(name); return true; }; const $ = () => ({ textContent: "x" });\n${probeScript(SOURCE)}`;
    const run = new Function("seen", `return (async () => {${body}})();`) as (seen: string[]) => Promise<void>;
    await run(seen);
    expect(seen).toEqual(["the output has text", "a second check"]);
    expect(() => new AsyncFunction(probeScript(SOURCE))).not.toThrow();
  });

  it("causes an error for syntax that is not only types", () => {
    expect(() => probeScript("enum Mode { A }\ncheck(\"x\", true);")).toThrow();
  });

  it("knows the TypeScript probe files by their extension", () => {
    expect(["probe.ts", "probe.mts", "probe.cts", "PROBE.TS"].every((file) => TYPESCRIPT_PROBE.test(file))).toBe(true);
    expect(["probe.js", "probe.d.tsx", "probe.tsx"].some((file) => TYPESCRIPT_PROBE.test(file))).toBe(false);
  });
});

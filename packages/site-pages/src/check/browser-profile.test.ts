import { describe, expect, it, vi } from "vitest";

// Each removal fails as on Windows, when a child process of the browser keeps a file of the profile open.
const removals = vi.hoisted(() => [] as string[]);
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return {
    ...fs,
    rmSync: (path: string) => {
      removals.push(path);
      throw Object.assign(new Error(`EPERM: operation not permitted, rmdir '${path}'`), { code: "EPERM" });
    },
  };
});

import { launch } from "./browser.ts";

describe("launch: a browser profile that cannot be removed", () => {
  it("keeps the error of the browser and writes a warning", async () => {
    const warnings: string[] = [];
    const write = vi.spyOn(process.stderr, "write").mockImplementation((text) => {
      warnings.push(String(text));
      return true;
    });
    try {
      // Node is the browser here: it refuses the flags of Chromium and stops at once.
      await expect(launch(process.execPath, 10_000)).rejects.toThrow(/the browser (stopped|did not start)/);
    } finally {
      write.mockRestore();
    }
    expect(removals).toHaveLength(1);
    expect(warnings.join("")).toContain(`site-pages check: the browser profile ${removals[0]} stays in the temporary folder: EPERM`);
    const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
    fs.rmSync(removals[0]!, { recursive: true, force: true });
  });
});

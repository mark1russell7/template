import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

// A one-off check. It leaves the branch before the merge.
it("writes the same record", () => {
  const record = new URL("./packing-record.json", import.meta.url);
  const before = readFileSync(record, "utf8");
  execFileSync(process.execPath, [fileURLToPath(new URL("../scripts/measure-packing.ts", import.meta.url))], { stdio: "inherit" });
  expect(readFileSync(record, "utf8") === before).toBe(true);
}, 170_000);

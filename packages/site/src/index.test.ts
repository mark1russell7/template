import { describe, expect, it } from "vitest";
import * as entry from "./index.ts";

describe("the entry", () => {
  it("loads", () => {
    expect(entry).toBeTypeOf("object");
  });
});

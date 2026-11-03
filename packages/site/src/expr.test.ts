import { describe, expect, it } from "vitest";
import { evaluate, UNKNOWN, type Value } from "./expr.ts";

const context: Record<string, Value> = {
  "inputs.on": true,
  "inputs.off": false,
  "inputs.text": "",
  "inputs.n": 0,
  "github.event_name": "push",
  "steps.x.outputs.run": UNKNOWN,
};
const lookup = (path: string): Value => (path in context ? (context[path] as Value) : UNKNOWN);
const value = (text: string): Value => evaluate(text, lookup).value;

describe("the evaluator of conditions", () => {
  it("knows the operators of GitHub", () => {
    expect(value("inputs.on")).toBe(true);
    expect(value("!inputs.on")).toBe(false);
    expect(value("inputs.on && inputs.off")).toBe(false);
    expect(value("inputs.off || inputs.on")).toBe(true);
    expect(value("github.event_name == 'PUSH'")).toBe(true);
    expect(value("github.event_name != 'push'")).toBe(false);
    expect(value("inputs.text != '{}' && inputs.text != ''")).toBe(false);
    expect(value("inputs.n != 0")).toBe(false);
    expect(value("(inputs.off || inputs.on) && github.event_name == 'push'")).toBe(true);
    expect(value("${{ inputs.on }}")).toBe(true);
    expect(value("")).toBe(true);
  });

  it("knows the functions of the status and of texts", () => {
    expect(value("always() && inputs.on")).toBe(true);
    expect(value("!cancelled()")).toBe(true);
    expect(value("failure()")).toBe(false);
    expect(value("contains('abc', 'B')")).toBe(true);
    expect(value("startsWith(github.event_name, 'pu')")).toBe(true);
  });

  it("gives UNKNOWN for a value that only the run knows, unless the other part decides", () => {
    expect(value("steps.x.outputs.run == 'true'")).toBe(UNKNOWN);
    expect(value("steps.x.outputs.run == 'true' && inputs.off")).toBe(false);
    expect(value("inputs.off && steps.x.outputs.run == 'true'")).toBe(false);
    expect(value("steps.x.outputs.run == 'true' || inputs.on")).toBe(true);
    expect(value("steps.x.outputs.run == 'true' && inputs.on")).toBe(UNKNOWN);
  });

  it("gives the context values that a condition reads", () => {
    expect(evaluate("inputs.on && github.event_name == 'push'", lookup).refs).toEqual([
      { path: "inputs.on", value: true },
      { path: "github.event_name", value: "push" },
    ]);
  });

  it("refuses a condition that it cannot read", () => {
    expect(() => value("inputs.on &&")).toThrow();
    expect(() => value("inputs.on # x")).toThrow();
  });
});

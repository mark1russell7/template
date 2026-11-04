/**
 * This script measures the placements of `@mark1russell7/packing`, and it writes `src/packing-record.json`. The site
 * shows that record in its response explorer. The inputs come from seeds and no value comes from a clock, so each run
 * writes the same bytes on one JavaScript engine.
 *
 * Start it in `packages/site`: `pnpm run measure:packing`.
 */

import { writeFileSync } from "node:fs";
import { checkHard, measure, packWith, type PackInput } from "@mark1russell7/packing";
import { random } from "@mark1russell7/rigor-generators";
import { fitResponse, parseResponseRecord } from "@mark1russell7/rigor-statistics";

const BOXES = [10, 32, 100, 316, 1000];
const SPREADS = [0.25, 0.5, 0.75, 1];
const SEEDS = [1, 2, 3];
const RULES = ["bl", "bssf", "baf", "cp"];
const ITERATIONS = [2, 4, 8, 16];
/** The mean side of a box before the spread. */
const SIDE = 20;
/** The width of the container, as a multiple of the side of a square with the area of all the boxes. */
const ROOM = 1.1;

type Value = string | number | null;

/** One way to pack: its values in the record, the strategy and its options. */
interface Arm {
  readonly values: Readonly<Record<string, Value>>;
  readonly strategy: string;
  readonly options: unknown;
}

const plain = (strategy: string): Arm => ({ values: { strategy, rule: null, iterations: null }, strategy, options: {} });
const ARMS: readonly Arm[] = [
  plain("rows"),
  plain("shelf"),
  plain("skyline"),
  ...RULES.map((rule) => ({ values: { strategy: "maxrects", rule, iterations: null }, strategy: "maxrects", options: { rule } })),
  ...ITERATIONS.map((iterations) => ({ values: { strategy: "restarts", rule: null, iterations }, strategy: "restarts", options: { member: "skyline", iterations } })),
];

/** This function gives a seeded input: each side is a log-normal draw, and the width of the container is fixed. */
function inputOf(count: number, spread: number, seed: number): PackInput {
  const draw = random(`packing-record:${count}:${spread}:${seed}`);
  const side = (): number => Math.max(1, Math.round(SIDE * Math.exp(draw.normal(0, spread))));
  const items = Array.from({ length: count }, (_, i) => ({ id: `b${i}`, w: side(), h: side() }));
  const area = items.reduce((sum, item) => sum + item.w * item.h, 0);
  const w = Math.max(Math.ceil(Math.sqrt(area) * ROOM), ...items.map((item) => item.w));
  return { container: { w, fixed: "width" }, items };
}

/** This function gives a measured value with four decimals, so the record stays small. */
const short = (value: number): number => Math.round(value * 1e4) / 1e4;

const points = BOXES.flatMap((boxes) =>
  SPREADS.flatMap((spread) =>
    SEEDS.flatMap((seed) => {
      const input = inputOf(boxes, spread, seed);
      return ARMS.map((arm, a) => {
        const output = packWith(arm.strategy, input, arm.options, seed);
        const breaks = Object.values(checkHard(input, output)).reduce((sum, count) => sum + count, 0);
        if (breaks !== 0) throw new Error(`${arm.strategy} broke a hard rule at ${boxes} boxes.`);
        const measured = measure(input, output);
        return {
          id: `${boxes}.${spread}.${seed}.${a}`,
          group: `${boxes}.${spread}.${seed}`,
          values: { ...arm.values, boxes, spread },
          measures: { fill: short(measured["pack.fill"]), aspect: short(measured["pack.aspect"]) },
        };
      });
    }),
  ),
);

const record = fitResponse(
  {
    schema: "response-records/1",
    name: "placements of the packing package",
    dimensions: [
      { id: "strategy", label: "Strategy", unit: "", kind: "categorical", levels: ["rows", "shelf", "skyline", "maxrects", "restarts"] },
      { id: "boxes", label: "Boxes", unit: "", kind: "continuous", range: [10, 1000], log: true },
      { id: "spread", label: "Size spread", unit: "", kind: "continuous", range: [0.25, 1] },
      { id: "rule", label: "Rule", unit: "", kind: "categorical", levels: RULES, when: { dimension: "strategy", levels: ["maxrects"] } },
      { id: "iterations", label: "Restarts", unit: "", kind: "continuous", range: [2, 16], log: true, when: { dimension: "strategy", levels: ["restarts"] } },
    ],
    measures: [
      { id: "fill", label: "Fill", unit: "", direction: "higher", range: [0, 1] },
      { id: "aspect", label: "Aspect", unit: "", direction: "none" },
    ],
    points,
  },
  { log: ["aspect"], degree: 3 },
);

const parsed = parseResponseRecord(JSON.parse(JSON.stringify(record)));
if (!parsed.ok) throw new Error(JSON.stringify(parsed.faults.slice(0, 5)));
writeFileSync(new URL("../src/packing-record.json", import.meta.url), `${JSON.stringify(record)}\n`);

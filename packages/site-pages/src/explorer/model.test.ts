import { fitResponse, type ResponseData, type ResponseRecord } from "@mark1russell7/rigor-statistics";
import { describe, expect, it } from "vitest";
import {
  axisChoices,
  axisOf,
  axisTicks,
  bandPath,
  cellEdges,
  cellText,
  curveText,
  errorSentence,
  facetChoices,
  fadeOf,
  formatValue,
  heatRange,
  heatStep,
  holdControls,
  linePath,
  MAX_PANELS,
  MAX_STEPS,
  MAX_STOPS,
  MIN_STEPS,
  nextStepsCap,
  numberTable,
  numberTicks,
  openRecord,
  placeOn,
  planSteps,
  READ_BUDGET,
  setAxis,
  setFacet,
  setHold,
  setMeasure,
  settle,
  stopsOf,
  toleranceOf,
  valueRange,
  veilOf,
  viewOf,
  type CurvePanel,
  type ExplorerState,
  type SurfacePanel,
} from "./model.ts";

const SIZES = [1, 10, 100];
const WIDTHS = [0, 0.5, 1];
const DEPTHS = [1, 2, 4];
const MODES = ["fast", "slow"];

/** This function gives a measured response with a parent, two conditional dimensions and a log measure. */
function data(): ResponseData {
  const points: ResponseData["points"][number][] = [];
  const add = (strategy: string, depth: number | null, mode: string | null, size: number, width: number, seed: number): void => {
    const value = 10 + Math.log10(size) * (depth ?? 2) + width * (mode === "slow" ? 3 : 1) + (seed - 1) * 0.1;
    const id = `${strategy}.${depth}.${mode}.${size}.${width}.${seed}`;
    points.push({ id, group: `${size}.${width}.${seed}`, values: { strategy, size, width, depth, mode }, measures: { score: value, time: value ** 2 } });
  };
  for (const size of SIZES) {
    for (const width of WIDTHS) {
      for (const seed of [1, 2, 3]) {
        add("plain", null, null, size, width, seed);
        for (const depth of DEPTHS) add("deep", depth, null, size, width, seed);
        for (const mode of MODES) add("moded", null, mode, size, width, seed);
      }
    }
  }
  return {
    schema: "response-records/1",
    name: "test",
    dimensions: [
      { id: "strategy", label: "Strategy", unit: "", kind: "categorical", levels: ["plain", "deep", "moded"] },
      { id: "size", label: "Size", unit: "mm", kind: "continuous", range: [1, 100], log: true },
      { id: "width", label: "Width", unit: "", kind: "continuous", range: [0, 1] },
      { id: "depth", label: "Depth", unit: "", kind: "continuous", range: [1, 4], when: { dimension: "strategy", levels: ["deep"] } },
      { id: "mode", label: "Mode", unit: "", kind: "categorical", levels: MODES, when: { dimension: "strategy", levels: ["moded"] } },
    ],
    measures: [
      { id: "score", label: "Score", unit: "pt", direction: "higher" },
      { id: "time", label: "Time", unit: "", direction: "lower" },
    ],
    points,
  };
}

const record: ResponseRecord = fitResponse(data(), { log: ["time"] });

/** This function gives a record with one table model of two categorical dimensions. */
function tableRecord(): ResponseRecord {
  const points = ["a", "b"].flatMap((left) =>
    ["p", "q", "r"].flatMap((right) =>
      [1, 2, 3, 4].map((seed) => ({ id: `${left}${right}${seed}`, group: `${left}${right}${seed}`, values: { left, right }, measures: { score: seed + left.charCodeAt(0) } })),
    ),
  );
  return fitResponse({
    schema: "response-records/1",
    name: "cells",
    dimensions: [
      { id: "left", label: "Left", unit: "", kind: "categorical", levels: ["a", "b"] },
      { id: "right", label: "Right", unit: "", kind: "categorical", levels: ["p", "q", "r"] },
    ],
    measures: [{ id: "score", label: "Score", unit: "", direction: "none" }],
    points,
  });
}

describe("openRecord", () => {
  it("gives the record of good data, from text and from data", () => {
    expect(openRecord(JSON.stringify(record)).ok).toBe(true);
    expect(openRecord(record).ok).toBe(true);
  });

  it("gives faults with paths for bad data, and it does not throw", () => {
    const bad = JSON.parse(JSON.stringify(record));
    bad.points[0].values.size = "large";
    const opened = openRecord(bad);
    expect(opened.ok).toBe(false);
    if (!opened.ok) expect(opened.faults.some((fault) => fault.path.startsWith("points[0]"))).toBe(true);
  });

  it("gives one fault for text that is not JSON", () => {
    const opened = openRecord("{ not json");
    expect(opened.ok).toBe(false);
    if (!opened.ok) expect(opened.faults[0]?.path).toBe("");
  });
});

describe("settle", () => {
  it("chooses a continuous dimension with no condition, and held values that were measured", () => {
    const state = settle(record);
    expect(state.measure).toBe("score");
    expect(state.x).toBe("size");
    expect(state.y).toBeNull();
    expect(state.facet).toBeNull();
    expect(stopsOf(record, record.dimensions[1] as never)).toContain(state.hold["size"]);
    expect(Object.keys(state.hold).sort()).toEqual(["depth", "mode", "size", "strategy", "width"]);
  });

  it("corrects unknown fields", () => {
    const state = settle(record, { measure: "no", x: "no", y: "no", facet: "no", hold: { strategy: "no", size: 7 } });
    expect(state.measure).toBe("score");
    expect(state.x).toBe("size");
    expect(state.y).toBeNull();
    expect(state.facet).toBeNull();
    expect(MODES.concat(["plain", "deep", "moded"])).toContain(state.hold["strategy"]);
    expect(SIZES).toContain(state.hold["size"]);
  });

  it("moves the parent to a level that a varied conditional dimension needs", () => {
    expect(settle(record, { x: "mode", hold: { strategy: "plain" } }).hold["strategy"]).toBe("moded");
  });

  it("removes a second axis that a view refuses", () => {
    expect(settle(record, { x: "depth", y: "strategy" }).y).toBeNull();
    expect(settle(record, { x: "strategy", y: "depth" }).y).toBeNull();
    expect(settle(record, { x: "depth", y: "mode" }).y).toBeNull();
    expect(settle(record, { x: "size", y: "size" }).y).toBeNull();
  });

  it("removes panels that a view refuses", () => {
    expect(settle(record, { x: "size", facet: "size" }).facet).toBeNull();
    expect(settle(record, { x: "depth", facet: "strategy" }).facet).toBeNull();
    expect(settle(record, { x: "size", facet: "depth", hold: { strategy: "plain" } }).facet).toBeNull();
  });
});

describe("the choices of the controls", () => {
  const state = settle(record, { hold: { strategy: "plain" } });
  const reason = (slot: "x" | "y", id: string, at: ExplorerState = state): string =>
    axisChoices(record, at, slot).find((c) => c.id === id)?.reason ?? "";

  it("disables and labels a varied dimension with its parent outside the condition", () => {
    expect(reason("x", "depth")).toBe("It applies only when Strategy is deep");
    expect(reason("x", "mode")).toBe("It applies only when Strategy is moded");
    expect(axisChoices(record, state, "x").find((c) => c.id === "depth")?.disabled).toBe(true);
  });

  it("does not take a disabled choice", () => {
    expect(setAxis(record, state, "x", "depth")).toBe(state);
    expect(setFacet(record, state, "mode")).toBe(state);
    const deep = settle(record, { x: "depth" });
    expect(setHold(record, deep, "strategy", "plain")).toBe(deep);
    expect(setAxis(record, state, "x", null)).toBe(state);
  });

  it("keeps a parent held while its conditional dimension varies", () => {
    const deep = setAxis(record, setHold(record, state, "strategy", "deep"), "x", "depth");
    expect(deep.x).toBe("depth");
    const control = holdControls(record, deep).find((c) => c.id === "strategy");
    expect(control?.options.filter((o) => !o.disabled).map((o) => o.value)).toEqual(["deep"]);
    expect(control?.options.find((o) => o.value === "plain")?.reason).not.toBe("");
    expect(reason("y", "strategy", deep)).not.toBe("");
  });

  it("refuses a conditional axis when the other axis is its parent", () => {
    expect(reason("y", "depth", settle(record, { x: "strategy" }))).toBe("It needs Strategy held");
  });

  it("refuses two varied dimensions with no common level", () => {
    expect(reason("y", "mode", settle(record, { x: "depth" }))).not.toBe("");
  });

  it("names the other axis", () => {
    expect(reason("y", "size")).toBe("It is on the other axis");
    expect(reason("x", "size", settle(record, { x: "width", y: "size" }))).toBe("It is on the other axis");
  });

  it("disables a held conditional dimension outside its condition, and it tells why", () => {
    const control = holdControls(record, state).find((c) => c.id === "depth");
    expect(control?.applies).toBe(false);
    expect(control?.note).toContain("only when Strategy is deep");
  });

  it("keeps a held conditional dimension open when its parent varies or is in panels", () => {
    expect(holdControls(record, settle(record, { x: "strategy" })).find((c) => c.id === "depth")?.applies).toBe(true);
    expect(holdControls(record, settle(record, { facet: "strategy" })).find((c) => c.id === "depth")?.applies).toBe(true);
  });

  it("gives reasons for the panels that it refuses", () => {
    const facets = facetChoices(record, settle(record, { x: "depth" }));
    expect(facets.find((c) => c.id === "strategy")?.disabled).toBe(true);
    expect(facetChoices(record, state).find((c) => c.id === "size")?.reason).toBe("It is on an axis");
    expect(facetChoices(record, state).find((c) => c.id === "depth")?.reason).not.toBe("");
  });

  it("removes panels when the dimension goes on an axis", () => {
    const moved = setAxis(record, settle(record, { facet: "width" }), "x", "width");
    expect(moved.x).toBe("width");
    expect(moved.facet).toBeNull();
  });

  it("refuses panels for a dimension with too many values", () => {
    const wide = JSON.parse(JSON.stringify(record)) as ResponseRecord;
    (wide.dimensions[0] as { levels: string[] }).levels = Array.from({ length: MAX_PANELS + 1 }, (_, i) => `l${i}`);
    expect(facetChoices(wide, settle(wide, {})).find((c) => c.id === "strategy")?.disabled).toBe(true);
  });

  it("changes the measure", () => {
    expect(setMeasure(record, state, "time").measure).toBe("time");
  });

  /** This function gives each state that the choices of the controls reach from the first state. */
  function reachable(start: ExplorerState): ExplorerState[] {
    const seen = new Map<string, ExplorerState>([[JSON.stringify(start), start]]);
    const queue = [start];
    while (queue.length > 0) {
      const at = queue.pop() as ExplorerState;
      const next: ExplorerState[] = [setAxis(record, at, "y", null), setFacet(record, at, null)];
      for (const m of record.measures) next.push(setMeasure(record, at, m.id));
      for (const slot of ["x", "y"] as const) for (const c of axisChoices(record, at, slot)) if (!c.disabled) next.push(setAxis(record, at, slot, c.id));
      for (const c of facetChoices(record, at)) if (!c.disabled) next.push(setFacet(record, at, c.id));
      for (const c of holdControls(record, at)) for (const o of c.options.slice(0, 2)) if (!o.disabled) next.push(setHold(record, at, c.id, o.value));
      for (const reached of next) {
        const key = JSON.stringify(reached);
        if (!seen.has(key)) {
          seen.set(key, reached);
          queue.push(reached);
        }
      }
    }
    return [...seen.values()];
  }

  it("offers no combination that a view refuses", () => {
    const states = reachable(state);
    expect(states.length).toBeGreaterThan(200);
    expect(states.some((s) => s.x === "depth" && s.y !== null)).toBe(true);
    expect(states.some((s) => s.x === "strategy" && s.facet === "mode")).toBe(true);
    for (const reached of states) {
      const view = viewOf(record, reached, { stepsCap: MIN_STEPS });
      expect(view.problem, JSON.stringify(reached)).toBe("");
      expect(view.panels.length).toBeGreaterThan(0);
    }
  });
});

describe("planSteps and nextStepsCap", () => {
  it("gives the largest grid for a small record", () => {
    expect(planSteps(10, 1, 2, 1)).toBe(MAX_STEPS);
  });

  it("bounds the reads of a surface from the number of points", () => {
    const steps = planSteps(5000, 1, 2, 1);
    expect(steps).toBeLessThan(MAX_STEPS);
    expect(steps * steps * 5000).toBeLessThanOrEqual(READ_BUDGET);
  });

  it("shares the reads between the panels and a level axis", () => {
    expect(planSteps(2000, 4, 2, 1)).toBeLessThan(planSteps(2000, 1, 2, 1));
    expect(planSteps(2000, 1, 1, 8)).toBeLessThan(planSteps(2000, 1, 1, 1));
  });

  it("keeps the smallest honest grid, and it obeys the cap", () => {
    expect(planSteps(1e7, 8, 2, 1)).toBe(MIN_STEPS);
    expect(planSteps(10, 1, 2, 1, 12)).toBe(12);
  });

  it("drops the grid after a surface that took too long", () => {
    expect(nextStepsCap(33, 40, 50)).toBe(Number.POSITIVE_INFINITY);
    expect(nextStepsCap(33, 200, 50)).toBe(16);
    expect(nextStepsCap(33, 51, 50)).toBe(32);
    expect(nextStepsCap(6, 5000, 50)).toBe(MIN_STEPS);
  });
});

describe("viewOf", () => {
  it("gives a curve with a band and the measured points", () => {
    const view = viewOf(record, settle(record, { hold: { width: 0.5, strategy: "plain" } }));
    const panel = view.panels[0] as CurvePanel;
    expect(panel.kind).toBe("curve");
    expect(panel.slice.curve).toHaveLength(MAX_STEPS);
    expect(panel.slice.points).toHaveLength(9);
    expect(panel.slice.curve[0]?.low).toBeLessThan(panel.slice.curve[0]?.high as number);
    expect(view.error?.folds).toBe(5);
    expect(view.errorText).toContain("over 5 folds");
  });

  it("gives one panel for each value of the facet", () => {
    const view = viewOf(record, settle(record, { facet: "strategy" }));
    expect(view.panels.map((p) => p.title)).toEqual(["Strategy: plain", "Strategy: deep", "Strategy: moded"]);
  });

  it("reads a held conditional dimension as null outside its condition", () => {
    const view = viewOf(record, settle(record, { hold: { strategy: "plain", depth: 4 } }));
    expect((view.panels[0] as CurvePanel).slice.held["depth"]).toBeNull();
  });

  it("gives a surface with the planned grid, and it tells the size", () => {
    const view = viewOf(record, settle(record, { x: "size", y: "width" }), { stepsCap: 9 });
    const panel = view.panels[0] as SurfacePanel;
    expect(panel.kind).toBe("surface");
    expect(panel.cells).toBe(false);
    expect(panel.surface.x).toHaveLength(9);
    expect(panel.surface.y).toHaveLength(9);
    expect(view.steps).toBe(9);
    expect(view.gridText).toContain("9");
  });

  it("drops the next grid after a slow surface, and it says so", () => {
    let time = 0;
    const view = viewOf(record, settle(record, { x: "size", y: "width" }), {
      now: () => {
        time += 100;
        return time;
      },
    });
    expect(view.elapsedMs).toBe(100);
    expect(view.nextCap).toBeLessThan(view.steps);
    expect(view.gridText).toContain("100 ms");
  });

  it("gives cells for a table model", () => {
    const table = tableRecord();
    const view = viewOf(table, settle(table, { x: "left", y: "right" }));
    const panel = view.panels[0] as SurfacePanel;
    expect(panel.cells).toBe(true);
    expect(view.modelText).toContain("no smooth surface");
  });

  it("gives only the measured points for a measure with no model, and it says so", () => {
    const bare: ResponseRecord = { ...record, models: record.models.filter((m) => m.measure !== "time") };
    const view = viewOf(bare, settle(bare, { measure: "time", hold: { strategy: "deep", depth: 2, width: 0 } }));
    const panel = view.panels[0];
    expect(panel?.kind).toBe("points");
    expect(panel?.kind === "points" ? panel.points : []).toHaveLength(9);
    expect(view.modelText).toContain("no valid model");
    expect(view.error).toBeNull();
    const surface = viewOf(bare, settle(bare, { measure: "time", x: "size", y: "width", hold: { strategy: "plain" } }));
    const dots = surface.panels[0];
    expect(dots?.kind === "points" ? dots.points : []).toHaveLength(27);
  });

  it("gives the text of a refused request, and it does not throw", () => {
    const view = viewOf(record, { ...settle(record), hold: { ...settle(record).hold, strategy: "none" } });
    expect(view.problem).not.toBe("");
    expect(view.panels).toEqual([]);
  });

  it("gives panels of plain points with a facet", () => {
    const bare: ResponseRecord = { ...record, models: [] };
    const view = viewOf(bare, settle(bare, { facet: "strategy", hold: { width: 0 } }));
    expect(view.panels.every((p) => p.kind === "points")).toBe(true);
    expect(view.panels).toHaveLength(3);
  });
});

describe("the stops of a dimension", () => {
  it("thins a dimension with many measured values, and it gives a tolerance", () => {
    const points = Array.from({ length: 200 }, (_, i) => ({ id: `p${i}`, values: { size: 1 + i }, measures: { score: i } }));
    const many = fitResponse({
      schema: "response-records/1",
      name: "many",
      dimensions: [{ id: "size", label: "Size", unit: "", kind: "continuous", range: [1, 200] }],
      measures: [{ id: "score", label: "Score", unit: "", direction: "none" }],
      points,
    });
    expect(stopsOf(many, many.dimensions[0] as never).length).toBeLessThanOrEqual(MAX_STOPS);
    expect(toleranceOf(many)).toBeGreaterThan(0);
    expect(toleranceOf(record)).toBe(0);
  });
});

describe("the plain words", () => {
  const measure = record.measures[0] as ResponseRecord["measures"][number];
  const model = record.models[0] as ResponseRecord["models"][number];
  const error = { n: 120, folds: 5, mae: 0.5, rmse: 0.7, baselineMae: 2, skill: 0.75 };

  it("tells the error, the folds and the mean", () => {
    const text = errorSentence(measure, { ...model, scale: "linear" } as never, error);
    expect(text).toContain("120");
    expect(text).toContain("5 folds");
    expect(text).toContain("0.5 pt");
    expect(text).toContain("75%");
  });

  it("tells a log error as a factor", () => {
    expect(errorSentence({ ...measure, unit: "" }, { ...model, scale: "log" } as never, { ...error, mae: 0.301 })).toContain("factor of 2");
  });

  it("formats values", () => {
    expect(formatValue(1000)).toBe("1,000");
    expect(formatValue("skyline")).toBe("skyline");
  });

  it("tells one place", () => {
    const axis = axisOf(record.dimensions[1] as never);
    expect(curveText(axis, { at: 10, value: 2, low: 1, high: 3, nearest: 0 })).toContain("10");
    expect(cellText(axis, axis, 1, 2, { value: 2, low: 1, high: 3, nearest: 0.25 })).toContain("2");
  });
});

describe("the geometry", () => {
  const size = axisOf(record.dimensions[1] as never);
  const strategy = axisOf(record.dimensions[0] as never);

  it("places a value on a log axis and on a level axis", () => {
    expect(placeOn(size, 10)).toBeCloseTo(0.5);
    expect(placeOn(strategy, "deep")).toBeCloseTo(0.5);
    expect(placeOn(axisOf(record.dimensions[2] as never), 0.25)).toBeCloseTo(0.25);
  });

  it("gives round ticks", () => {
    expect(numberTicks(0, 1, false, 4).map((t) => t.text)).toEqual(["0", "0.2", "0.4", "0.6", "0.8", "1"]);
    expect(numberTicks(10, 1000, true, 3).map((t) => t.text)).toEqual(["10", "100", "1,000"]);
    expect(axisTicks(strategy, 4).map((t) => t.text)).toEqual(["plain", "deep", "moded"]);
    expect(axisTicks(size, 3).at(-1)?.place).toBeCloseTo(1);
  });

  it("gives the same value range to each panel", () => {
    const view = viewOf(record, settle(record, { facet: "strategy" }));
    const [low, high] = valueRange(view);
    expect(low).toBeLessThan(high);
    const log = viewOf(record, settle(record, { measure: "time" }));
    expect(log.log).toBe(true);
    expect(valueRange(log)[0]).toBeGreaterThan(0);
  });

  it("gives a color step for a value", () => {
    expect(heatStep(0, [0, 1], false)).toBe(0);
    expect(heatStep(1, [0, 1], false)).toBe(8);
    expect(heatStep(10, [1, 100], true)).toBe(4);
    const view = viewOf(record, settle(record, { x: "size", y: "width" }));
    const [low, high] = heatRange(view);
    expect(low).toBeLessThan(high);
  });

  it("fades with the distance from the data", () => {
    expect(fadeOf(0)).toBe(1);
    expect(fadeOf(1)).toBeLessThan(fadeOf(0.25));
    expect(veilOf(0)).toBe(0);
    expect(veilOf(0.5)).toBeGreaterThan(veilOf(0.1));
  });

  it("gives the edges of cells and the paths", () => {
    expect(cellEdges([0, 0.5, 1])).toEqual([0, 0.25, 0.75, 1]);
    expect(linePath([[0, 1], [2, 3]])).toContain("L");
    expect(bandPath([[0, 1]], [[0, 2]])).toContain("Z");
  });
});

describe("numberTable", () => {
  it("gives each place of a curve", () => {
    const view = viewOf(record, settle(record));
    const table = numberTable(view, view.panels[0] as CurvePanel);
    expect(table.rows).toHaveLength(MAX_STEPS);
  });

  it("gives rows for a surface", () => {
    const view = viewOf(record, settle(record, { x: "size", y: "width", hold: { strategy: "plain" } }), { stepsCap: 5 });
    const table = numberTable(view, view.panels[0] as SurfacePanel);
    expect(table.rows.length).toBeGreaterThan(0);
  });
});

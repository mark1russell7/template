/**
 * The pure core of the response explorer: the state, the rules of the controls and the data of a view. This module
 * reads a record of the format `response-records/1` only with `@mark1russell7/rigor-statistics`. It has no DOM and no
 * clock of its own, so a test gives it each input.
 *
 * The rules of the controls follow the rules of a conditional dimension. The functions `axisChoices`, `facetChoices`
 * and `holdControls` offer only combinations that `sliceResponse` and `surfaceResponse` accept. The function `settle`
 * gives the nearest good state for any wanted state.
 */

import {
  heldOutError,
  parseResponseRecord,
  quantile,
  sliceResponse,
  surfaceResponse,
  type ParsedResponseRecord,
  type ResponseBand,
  type ResponseCurvePoint,
  type ResponseDimension,
  type ResponseHeldOutError,
  type ResponseInputValue,
  type ResponseMeasure,
  type ResponseModel,
  type ResponsePoint,
  type ResponseRecord,
  type ResponseSlice,
  type ResponseSurface,
  type ResponseValue,
} from "@mark1russell7/rigor-statistics";

/** The largest number of values on a continuous axis. It is the default of `ResponseViewOptions.steps`. */
export const MAX_STEPS = 33;
/** The smallest number of values on a continuous axis. A smaller grid shows too little of the response. */
export const MIN_STEPS = 5;
/**
 * The largest number of point reads of one view. The field `nearest` of each place reads each point, so the cost of a
 * view is its number of places times the number of points. This number keeps a view under about 50 ms on a slow phone.
 */
export const READ_BUDGET = 400_000;
/** The time of one surface in milliseconds. A longer surface gives a smaller grid for the next surface. */
export const SURFACE_BUDGET_MS = 50;
/** The largest number of panels of one view. */
export const MAX_PANELS = 8;
/** The largest number of stops of a held continuous dimension. */
export const MAX_STOPS = 33;
/** The distance from a measurement, from 0 to 1, at which a band has its weakest color. */
export const FADE_END = 0.5;
/** The number of steps of the color scale of a surface. The CSS classes `rx-h0` to `rx-h8` give the colors. */
export const HEAT_STEPS = 9;

/** The choices of a visitor. */
export interface ExplorerState {
  /** The id of the measure. */
  readonly measure: string;
  /** The id of the dimension of the horizontal axis. */
  readonly x: string;
  /** The id of the dimension of the vertical axis of a surface. The value `null` gives a curve. */
  readonly y: string | null;
  /** The id of the dimension with one panel for each of its values. The value `null` gives one panel. */
  readonly facet: string | null;
  /** The held value of each dimension. A dimension on an axis keeps its value for a later view. */
  readonly hold: Readonly<Record<string, ResponseValue>>;
}

/** The two axes of a view. */
export type AxisSlot = "x" | "y";

/** A dimension that a control offers. */
export interface DimensionChoice {
  readonly id: string;
  readonly label: string;
  readonly disabled: boolean;
  /** The reason of a disabled choice. A good choice has an empty string. */
  readonly reason: string;
}

/** A value that a hold control offers. */
export interface HoldOption {
  readonly value: ResponseValue;
  readonly text: string;
  readonly disabled: boolean;
  readonly reason: string;
}

/** The control of one held dimension. */
export interface HoldControl {
  readonly id: string;
  readonly label: string;
  /** The value `levels` gives one button for each level. The value `stops` gives a slider over the measured values. */
  readonly kind: "levels" | "stops";
  /** The value `false` means that the dimension has no value at the held level of its parent. */
  readonly applies: boolean;
  /** The condition of the dimension, as text. A dimension with no condition has an empty string. */
  readonly note: string;
  readonly options: readonly HoldOption[];
  readonly value: ResponseValue;
}

/** One axis of a chart. A number axis has a linear or log place. A level axis has one equal band for each level. */
export interface AxisSpec {
  readonly id: string;
  readonly label: string;
  readonly kind: "number" | "levels";
  readonly log: boolean;
  /** The two ends of a number axis. */
  readonly range: readonly [number, number];
  /** The levels of a level axis. */
  readonly levels: readonly ResponseValue[];
}

/** The fields of each kind of panel. */
interface PanelBase {
  /** The name of the panel in a view with panels. The only panel of a view has an empty string. */
  readonly title: string;
  /** The value of the facet dimension in this panel. */
  readonly level: ResponseValue | null;
}

/** A fitted curve with its band and the measured points. */
export interface CurvePanel extends PanelBase {
  readonly kind: "curve";
  readonly slice: ResponseSlice;
}

/** A fitted surface. With `cells`, the view shows separate cells with their values, not a smooth surface. */
export interface SurfacePanel extends PanelBase {
  readonly kind: "surface";
  readonly cells: boolean;
  readonly surface: ResponseSurface;
}

/** A measured point of a panel with no model. */
export interface PlainPoint {
  readonly id: string;
  /** The value of each varied dimension. */
  readonly at: readonly ResponseValue[];
  readonly value: number;
}

/** The measured points of a measure with no model. */
export interface PointsPanel extends PanelBase {
  readonly kind: "points";
  readonly points: readonly PlainPoint[];
}

/** One panel of a view. */
export type ExplorerPanel = CurvePanel | SurfacePanel | PointsPanel;

/** The data of one view. */
export interface ExplorerView {
  readonly measure: ResponseMeasure;
  readonly x: AxisSpec;
  readonly y: AxisSpec | null;
  readonly panels: readonly ExplorerPanel[];
  /** The value `true` gives a log value axis. */
  readonly log: boolean;
  /** The held-out error. A measure with no model has none. */
  readonly error: ResponseHeldOutError | null;
  /** The held-out error in plain words. */
  readonly errorText: string;
  /** The kind of the model in plain words. */
  readonly modelText: string;
  /** The size of the grid of a surface in plain words. A curve has an empty string. */
  readonly gridText: string;
  /** The text of a request that the record refused. A good view has an empty string. */
  readonly problem: string;
  /** The number of values on a continuous axis of this view. */
  readonly steps: number;
  /** The time of this view in milliseconds. */
  readonly elapsedMs: number;
  /** The largest number of steps of the next view. */
  readonly nextCap: number;
}

/** The inputs of `viewOf`. */
export interface ViewOptions {
  /** The largest number of steps. The value of `nextCap` of the last view goes here. */
  readonly stepsCap?: number;
  /** The time of a surface in milliseconds. The default is `SURFACE_BUDGET_MS`. */
  readonly budgetMs?: number;
  /** The clock in milliseconds. The default gives 0, so a view with no clock does not drop its grid. */
  readonly now?: () => number;
}

/** A rectangle of a table of numbers. */
export interface NumberTable {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly string[])[];
}

/** One tick of an axis. */
export interface Tick {
  /** The place on the axis, from 0 to 1. */
  readonly place: number;
  readonly text: string;
}

/**
 * This function reads a record from JSON text or from parsed data. It does not throw: bad data gives faults with
 * their paths.
 */
export function openRecord(value: unknown): ParsedResponseRecord {
  if (typeof value !== "string") return parseResponseRecord(value);
  try {
    return parseResponseRecord(JSON.parse(value));
  } catch (error) {
    return { ok: false, faults: [{ path: "", message: `this text is not JSON: ${String(error)}.` }] };
  }
}

const numberText = new Intl.NumberFormat("en-US", { maximumSignificantDigits: 3 });

/** This function gives the text of a value: a number with three significant digits, or the text of a level. */
export function formatValue(value: ResponseInputValue): string {
  if (value === null) return "none";
  return typeof value === "number" ? numberText.format(value) : value;
}

/** This function gives the dimension with an id that the state or the record names. */
function dimensionOf(record: ResponseRecord, id: string): ResponseDimension {
  const dimension = record.dimensions.find((d) => d.id === id);
  if (dimension === undefined) throw new RangeError(`The record has no dimension "${id}".`);
  return dimension;
}

/** This function gives the measured values of a dimension, with no `null`. */
function measuredValues(record: ResponseRecord, id: string): ResponseValue[] {
  return record.points.flatMap((p) => {
    const value = p.values[id];
    return value === null || value === undefined ? [] : [value];
  });
}

const stopCache = new WeakMap<ResponseRecord, Map<string, readonly ResponseValue[]>>();

/** This function gives the distinct measured values of a continuous dimension, in order. */
function distinctNumbers(record: ResponseRecord, id: string): number[] {
  const numbers = measuredValues(record, id).filter((v) => typeof v === "number");
  return [...new Set(numbers)].sort((a, b) => a - b);
}

/**
 * This function gives the values that a visitor can hold: each level, or the measured values of a continuous dimension.
 * With more than `MAX_STOPS` measured values, it gives that number of quantiles of them.
 */
export function stopsOf(record: ResponseRecord, dimension: ResponseDimension): readonly ResponseValue[] {
  if (dimension.kind !== "continuous") return dimension.levels;
  let stops = stopCache.get(record);
  if (stops === undefined) stopCache.set(record, (stops = new Map()));
  const known = stops.get(dimension.id);
  if (known !== undefined) return known;
  const distinct = distinctNumbers(record, dimension.id);
  const thin = (): number[] => [...new Set(Array.from({ length: MAX_STOPS }, (_, i) => quantile(distinct, i / (MAX_STOPS - 1), "nearest-rank")))];
  const found = distinct.length === 0 ? [dimension.range[0]] : distinct.length > MAX_STOPS ? thin() : distinct;
  stops.set(dimension.id, found);
  return found;
}

/** This function gives the place of a number on a continuous dimension, from 0 to 1. */
function shareOf(dimension: ResponseDimension & { kind: "continuous" }, value: number): number {
  const scale = (v: number): number => (dimension.log === true ? Math.log10(v) : v);
  const [low, high] = dimension.range;
  return (scale(value) - scale(low)) / (scale(high) - scale(low));
}

/**
 * This function gives the option `tolerance` of a view. A dimension with all its measured values as stops needs none.
 * A thinned dimension needs half of its largest gap, so each measured point matches a stop.
 */
export function toleranceOf(record: ResponseRecord): number {
  let tolerance = 0;
  for (const dimension of record.dimensions) {
    if (dimension.kind !== "continuous") continue;
    const stops = stopsOf(record, dimension) as readonly number[];
    if (stops.length === distinctNumbers(record, dimension.id).length) continue;
    for (let i = 1; i < stops.length; i++) {
      const gap = shareOf(dimension, stops[i] as number) - shareOf(dimension, stops[i - 1] as number);
      tolerance = Math.max(tolerance, gap / 2);
    }
  }
  return tolerance;
}

/** This function gives the usual value of a dimension: the measured median, or the most common level in `among`. */
function usualValue(record: ResponseRecord, dimension: ResponseDimension, among?: readonly ResponseValue[]): ResponseValue {
  const values = measuredValues(record, dimension.id);
  if (dimension.kind === "continuous") {
    const numbers = values.filter((v) => typeof v === "number");
    return numbers.length === 0 ? dimension.range[0] : quantile(numbers, 0.5, "nearest-rank");
  }
  const levels: readonly ResponseValue[] = among ?? dimension.levels;
  const count = (level: ResponseValue): number => values.filter((v) => v === level).length;
  return levels.reduce((best, level) => (count(level) > count(best) ? level : best), levels[0] as ResponseValue);
}

/** This function gives the stop of a dimension that is nearest to a value, or `undefined` for a value of no use. */
function nearestStop(record: ResponseRecord, dimension: ResponseDimension, value: ResponseValue | undefined): ResponseValue | undefined {
  const stops = stopsOf(record, dimension);
  if (value === undefined) return undefined;
  if (dimension.kind !== "continuous") return stops.includes(value) ? value : undefined;
  if (typeof value !== "number") return undefined;
  const far = (stop: ResponseValue): number => Math.abs(shareOf(dimension, stop as number) - shareOf(dimension, value));
  return stops.reduce((best, stop) => (far(stop) < far(best) ? stop : best));
}

/** This function gives the levels that the parent of each varied conditional dimension needs. */
function neededLevels(record: ResponseRecord, varied: readonly string[]): Map<string, readonly ResponseValue[]> {
  const needed = new Map<string, readonly ResponseValue[]>();
  for (const id of varied) {
    const when = dimensionOf(record, id).when;
    if (when === undefined) continue;
    const earlier = needed.get(when.dimension);
    needed.set(when.dimension, earlier === undefined ? when.levels : earlier.filter((level) => when.levels.includes(level)));
  }
  return needed;
}

/** This function gives the condition of a dimension as a phrase of a sentence. */
function whenText(record: ResponseRecord, dimension: ResponseDimension): string {
  const when = dimension.when;
  if (when === undefined) return "";
  return `only when ${dimensionOf(record, when.dimension).label} is ${when.levels.map(formatValue).join(" or ")}`;
}

const variedOf = (state: Pick<ExplorerState, "x" | "y">): string[] => (state.y === null ? [state.x] : [state.x, state.y]);

/** This function gives the values of a dimension in panels, inside the needs of the varied dimensions. */
function panelLevels(record: ResponseRecord, state: Pick<ExplorerState, "x" | "y">, id: string): readonly ResponseValue[] {
  const stops = stopsOf(record, dimensionOf(record, id));
  const needed = neededLevels(record, variedOf(state)).get(id);
  return needed === undefined ? stops : stops.filter((value) => needed.includes(value));
}

/** This function gives the reason that a dimension cannot be in panels. A good dimension gives an empty string. */
function facetBlock(record: ResponseRecord, state: Pick<ExplorerState, "x" | "y" | "hold">, dimension: ResponseDimension): string {
  if (variedOf(state).includes(dimension.id)) return "It is on an axis";
  const when = dimension.when;
  if (when !== undefined && !variedOf(state).includes(when.dimension) && !when.levels.includes(state.hold[when.dimension] as ResponseValue)) return `It applies ${whenText(record, dimension)}`;
  const count = panelLevels(record, state, dimension.id).length;
  if (count > MAX_PANELS) return `It has ${count} values, and a view has ${MAX_PANELS} panels or fewer`;
  if (count < 2) return "It has one value here";
  return "";
}

/** This function gives the reason that a dimension cannot go on an axis. A good dimension gives an empty string. */
function axisBlock(record: ResponseRecord, state: ExplorerState, slot: AxisSlot, dimension: ResponseDimension): string {
  const otherId = slot === "x" ? state.y : state.x;
  if (dimension.id === otherId) return "It is on the other axis";
  const other = otherId === null ? undefined : dimensionOf(record, otherId);
  if (other?.when?.dimension === dimension.id) return `${other.label} needs it held`;
  const when = dimension.when;
  if (when === undefined) return "";
  const parent = dimensionOf(record, when.dimension);
  if (parent.id === otherId) return `It needs ${parent.label} held`;
  const shared = other?.when?.dimension === parent.id ? when.levels.filter((level) => other.when?.levels.includes(level) === true) : when.levels;
  const inView = parent.id === state.facet ? stopsOf(record, parent) : [state.hold[parent.id] as ResponseValue];
  return inView.some((level) => shared.includes(level)) ? "" : `It applies ${whenText(record, dimension)}`;
}

/** This function gives the first dimension with no condition, and a continuous dimension before another kind. */
function firstAxis(record: ResponseRecord): string {
  const plain = record.dimensions.filter((d) => d.when === undefined);
  const chosen = plain.find((d) => d.kind === "continuous") ?? plain[0] ?? record.dimensions[0];
  return (chosen as ResponseDimension).id;
}

/**
 * This function gives the nearest good state for a wanted state. Each unknown or missing field takes its usual value.
 * A parent moves to a level that a varied conditional dimension needs. A combination that a view refuses loses its
 * second axis or its panels.
 */
export function settle(record: ResponseRecord, wanted: Partial<ExplorerState> = {}): ExplorerState {
  const known = (id: string | null | undefined): boolean => id !== null && id !== undefined && record.dimensions.some((d) => d.id === id);
  const measure = record.measures.some((m) => m.id === wanted.measure) ? (wanted.measure as string) : (record.measures[0]?.id ?? "");
  const x = known(wanted.x) ? (wanted.x as string) : firstAxis(record);
  const parentOf = (id: string): string | undefined => dimensionOf(record, id).when?.dimension;
  let y = known(wanted.y) && wanted.y !== x ? (wanted.y as string) : null;
  if (y !== null && (parentOf(y) === x || parentOf(x) === y || [...neededLevels(record, [x, y]).values()].some((levels) => levels.length === 0))) y = null;

  const hold: Record<string, ResponseValue> = {};
  for (const dimension of record.dimensions) hold[dimension.id] = nearestStop(record, dimension, wanted.hold?.[dimension.id]) ?? usualValue(record, dimension);

  const facetId = known(wanted.facet) ? (wanted.facet as string) : null;
  const facet = facetId !== null && facetBlock(record, { x, y, hold }, dimensionOf(record, facetId)) === "" ? facetId : null;
  for (const [parent, levels] of neededLevels(record, variedOf({ x, y }))) {
    if (parent === facet || levels.includes(hold[parent] as ResponseValue)) continue;
    hold[parent] = usualValue(record, dimensionOf(record, parent), levels);
  }
  return { measure, x, y, facet: facet !== null && facetBlock(record, { x, y, hold }, dimensionOf(record, facet)) === "" ? facet : null, hold };
}

/** This function gives each dimension as a choice for an axis. A disabled choice tells its reason. */
export function axisChoices(record: ResponseRecord, state: ExplorerState, slot: AxisSlot): readonly DimensionChoice[] {
  return record.dimensions.map((d) => {
    const reason = axisBlock(record, state, slot, d);
    return { id: d.id, label: d.label, disabled: reason !== "", reason };
  });
}

/** This function gives each dimension as a choice for panels. A disabled choice tells its reason. */
export function facetChoices(record: ResponseRecord, state: ExplorerState): readonly DimensionChoice[] {
  return record.dimensions.map((d) => {
    const reason = facetBlock(record, state, d);
    return { id: d.id, label: d.label, disabled: reason !== "", reason };
  });
}

/** This function gives the control of each held dimension. A dimension on an axis or in panels has no control. */
export function holdControls(record: ResponseRecord, state: ExplorerState): readonly HoldControl[] {
  const needed = neededLevels(record, variedOf(state));
  const held = record.dimensions.filter((d) => !variedOf(state).includes(d.id) && d.id !== state.facet);
  return held.map((d) => {
    const parent = d.when?.dimension;
    const open = parent === undefined || parent === state.facet || variedOf(state).includes(parent);
    const applies = open || d.when?.levels.includes(state.hold[parent as string] as ResponseValue) === true;
    const levels = needed.get(d.id);
    const options = stopsOf(record, d).map((value): HoldOption => {
      const locked = levels !== undefined && !levels.includes(value);
      const reason = !applies ? `It applies ${whenText(record, d)}` : locked ? "A varied dimension has no value at this level" : "";
      return { value, text: formatValue(value), disabled: reason !== "", reason };
    });
    const note = d.when === undefined ? "" : `Applies ${whenText(record, d)}`;
    return { id: d.id, label: d.label, kind: d.kind === "continuous" ? "stops" : "levels", applies, note, options, value: state.hold[d.id] as ResponseValue };
  });
}

/** This function gives the state with a new measure. */
export function setMeasure(record: ResponseRecord, state: ExplorerState, measure: string): ExplorerState {
  return settle(record, { ...state, measure });
}

/** This function gives the state with a new axis. It does not take a disabled choice. The value `null` removes the y axis. */
export function setAxis(record: ResponseRecord, state: ExplorerState, slot: AxisSlot, id: string | null): ExplorerState {
  if (id === null) return slot === "y" ? settle(record, { ...state, y: null }) : state;
  if (axisBlock(record, state, slot, dimensionOf(record, id)) !== "") return state;
  return settle(record, { ...state, [slot]: id, facet: state.facet === id ? null : state.facet });
}

/** This function gives the state with new panels. It does not take a disabled choice. The value `null` gives one panel. */
export function setFacet(record: ResponseRecord, state: ExplorerState, id: string | null): ExplorerState {
  if (id !== null && facetBlock(record, state, dimensionOf(record, id)) !== "") return state;
  return settle(record, { ...state, facet: id });
}

/** This function gives the state with a new held value. It does not take a disabled value. */
export function setHold(record: ResponseRecord, state: ExplorerState, id: string, value: ResponseValue): ExplorerState {
  const control = holdControls(record, state).find((c) => c.id === id);
  const option = control?.options.find((o) => o.value === value);
  if (option === undefined || option.disabled) return state;
  return settle(record, { ...state, hold: { ...state.hold, [id]: value } });
}

/**
 * This function gives the number of steps of a view, from the number of points, before the call. The field `nearest`
 * reads each point at each place, so the number of places comes from `READ_BUDGET`.
 *
 * @param points - The number of points of the record.
 * @param panels - The number of panels of the view.
 * @param continuous - The number of continuous axes of the view.
 * @param levels - The number of levels of a level axis of a surface, or 1.
 * @param cap - The largest result.
 */
export function planSteps(points: number, panels: number, continuous: number, levels: number, cap: number = MAX_STEPS): number {
  const places = READ_BUDGET / (Math.max(1, points) * Math.max(1, panels));
  const room = continuous === 2 ? Math.sqrt(places) : places / Math.max(1, levels);
  return Math.max(MIN_STEPS, Math.min(cap, MAX_STEPS, Math.floor(room)));
}

/** This function gives the cap of the next view: a smaller grid when this surface took more than the budget. */
export function nextStepsCap(steps: number, elapsedMs: number, budgetMs: number): number {
  if (elapsedMs <= budgetMs) return Number.POSITIVE_INFINITY;
  return Math.max(MIN_STEPS, Math.min(steps - 1, Math.floor(steps * Math.sqrt(budgetMs / elapsedMs))));
}

/** This function gives the axis of a dimension. */
export function axisOf(dimension: ResponseDimension): AxisSpec {
  const { id, label, unit } = dimension;
  const name = unit === "" ? label : `${label} (${unit})`;
  if (dimension.kind === "continuous") return { id, label: name, kind: "number", log: dimension.log === true, range: dimension.range, levels: [] };
  return { id, label: name, kind: "levels", log: false, range: [0, 1], levels: dimension.levels };
}

/** This function gives the place of a value on an axis, from 0 to 1. A value outside a number axis goes past the ends. */
export function placeOn(axis: AxisSpec, value: ResponseValue): number {
  if (axis.kind === "levels") return (axis.levels.indexOf(value) + 0.5) / axis.levels.length;
  const scale = (v: number): number => (axis.log ? Math.log10(v) : v);
  const [low, high] = axis.range;
  return (scale(value as number) - scale(low)) / (scale(high) - scale(low));
}

/** This function gives true for a point that matches the held values, with the rules of `sliceResponse`. */
function pointMatches(record: ResponseRecord, point: ResponsePoint, measure: string, varied: readonly string[], hold: Readonly<Record<string, ResponseValue>>, tolerance: number): boolean {
  if (typeof point.measures[measure] !== "number") return false;
  return record.dimensions.every((d) => {
    const value = point.values[d.id] ?? null;
    if (varied.includes(d.id)) return value !== null;
    const parent = d.when === undefined ? null : (point.values[d.when.dimension] ?? null);
    const present = d.when === undefined || (parent !== null && d.when.levels.includes(parent));
    const wanted = present ? (hold[d.id] as ResponseValue) : null;
    if (typeof value !== "number" || typeof wanted !== "number" || d.kind !== "continuous") return value === wanted;
    return Math.abs(shareOf(d, value) - shareOf(d, wanted)) <= tolerance;
  });
}

/** This function gives the error of a measure in plain words. */
export function errorSentence(measure: ResponseMeasure, model: ResponseModel, error: ResponseHeldOutError): string {
  const unit = measure.unit === "" ? "" : ` ${measure.unit}`;
  const amount = (value: number): string => (model.scale === "log" ? `a factor of ${formatValue(10 ** value)}` : `${formatValue(value)}${unit}`);
  const seen = `On ${error.n} points that each fit did not see, over ${error.folds} folds, the model misses by ${amount(error.mae)} on average.`;
  const base = `A plain mean misses by ${amount(error.baselineMae)}.`;
  if (error.skill === null) return `${seen} ${base}`;
  return error.skill > 0 ? `${seen} ${base} The model removes ${Math.round(error.skill * 100)}% of that miss.` : `${seen} ${base} The model is no better than the mean.`;
}

/** This function gives the name of a panel. */
const panelTitle = (facet: ResponseDimension | undefined, level: ResponseValue | null): string => (facet === undefined || level === null ? "" : `${facet.label}: ${formatValue(level)}`);

/** This function gives the panels of a measure with no model: the measured points that match the held values. */
function pointPanels(record: ResponseRecord, state: ExplorerState, levels: readonly (ResponseValue | null)[], facet: ResponseDimension | undefined, tolerance: number): ExplorerPanel[] {
  const varied = variedOf(state);
  return levels.map((level) => {
    const hold = level === null || facet === undefined ? state.hold : { ...state.hold, [facet.id]: level };
    const points = record.points.flatMap((p): PlainPoint[] => {
      if (!pointMatches(record, p, state.measure, varied, hold, tolerance)) return [];
      return [{ id: p.id, at: varied.map((id) => p.values[id] as ResponseValue), value: p.measures[state.measure] as number }];
    });
    return { kind: "points", title: panelTitle(facet, level), level, points };
  });
}

/** This function gives the held values of a request: each dimension that does not vary. */
function requestHold(state: ExplorerState, facet: ResponseDimension | undefined, level: ResponseValue | null): Record<string, ResponseValue> {
  const varied = variedOf(state);
  const hold = Object.fromEntries(Object.entries(state.hold).filter(([id]) => !varied.includes(id)));
  return facet === undefined || level === null ? hold : { ...hold, [facet.id]: level };
}

/** This function gives the text of the size of a grid. */
function gridSentence(x: readonly ResponseValue[], y: readonly ResponseValue[], cells: boolean, elapsedMs: number, budgetMs: number): string {
  if (cells) return `The grid has ${x.length} by ${y.length} measured levels.`;
  const size = `The grid has ${x.length} by ${y.length} places.`;
  return elapsedMs > budgetMs ? `${size} This surface took ${Math.round(elapsedMs)} ms, so the next grid is smaller.` : size;
}

/** This function gives the steps of a view from its axes and the plan of `planSteps`. */
function stepsOfView(record: ResponseRecord, state: ExplorerState, panels: number, cap: number): number {
  const axes = variedOf(state).map((id) => dimensionOf(record, id));
  const fixed = axes.filter((d) => d.kind !== "continuous");
  const levels = fixed.reduce((count, d) => count * (d as { levels: readonly ResponseValue[] }).levels.length, 1);
  return planSteps(record.points.length, panels, axes.length - fixed.length, levels, cap);
}

/**
 * This function gives the data of a view. It does not throw. A request that the record refuses gives the text in
 * `problem`, and no panels. A measure with no model gives only the measured points, and a table model gives cells.
 */
export function viewOf(record: ResponseRecord, state: ExplorerState, options: ViewOptions = {}): ExplorerView {
  const { budgetMs = SURFACE_BUDGET_MS, stepsCap = MAX_STEPS, now = (): number => 0 } = options;
  const measure = record.measures.find((m) => m.id === state.measure) ?? (record.measures[0] as ResponseMeasure);
  const model = record.models.find((m) => m.measure === measure.id);
  const x = axisOf(dimensionOf(record, state.x));
  const y = state.y === null ? null : axisOf(dimensionOf(record, state.y));
  const facet = state.facet === null ? undefined : dimensionOf(record, state.facet);
  const levels = facet === undefined ? [null] : panelLevels(record, state, facet.id);
  const steps = stepsOfView(record, state, levels.length, stepsCap);
  const tolerance = toleranceOf(record);
  const base = { measure, x, y, log: model?.scale === "log", steps, elapsedMs: 0, nextCap: stepsCap, gridText: "", problem: "" };

  if (model === undefined) {
    const modelText = "This measure has no valid model in the record, so the view shows only the measured points.";
    return { ...base, panels: pointPanels(record, state, levels, facet, tolerance), error: null, errorText: "", modelText };
  }
  const modelText = model.kind === "table" ? "The model is the mean of each measured cell, so the view shows cells and no smooth surface." : "The model is a smooth fit over all the dimensions.";
  try {
    const start = now();
    const panels = levels.map((level): ExplorerPanel => {
      const hold = requestHold(state, facet, level);
      const title = panelTitle(facet, level);
      if (state.y === null) return { kind: "curve", title, level, slice: sliceResponse(record, measure.id, { vary: state.x, hold, steps, tolerance }) };
      const surface = surfaceResponse(record, measure.id, { vary: [state.x, state.y], hold, steps, tolerance });
      return { kind: "surface", title, level, cells: model.kind === "table" || (x.kind === "levels" && y?.kind === "levels"), surface };
    });
    const elapsedMs = Math.max(0, now() - start);
    const first = panels[0];
    const surface = first?.kind === "surface" ? first : undefined;
    const late = surface !== undefined && !surface.cells ? nextStepsCap(steps, elapsedMs, budgetMs) : Number.POSITIVE_INFINITY;
    const gridText = surface === undefined ? "" : gridSentence(surface.surface.x, surface.surface.y, surface.cells, elapsedMs, budgetMs);
    const error = heldOutError(record, measure.id);
    return { ...base, panels, error, errorText: errorSentence(measure, model, error), modelText, gridText, elapsedMs, nextCap: Math.min(stepsCap, late) };
  } catch (error) {
    return { ...base, panels: [], error: null, errorText: "", modelText, problem: error instanceof Error ? error.message : String(error) };
  }
}

/** This function gives the strength of the band at a distance from a measurement: 1 at a measurement, 0.15 far away. */
export function fadeOf(nearest: number): number {
  return 1 - 0.85 * Math.min(1, nearest / FADE_END);
}

/** This function gives the share of the neutral veil of a surface cell at a distance from a measurement. */
export function veilOf(nearest: number): number {
  return 0.8 * Math.min(1, nearest / FADE_END);
}

/** This function gives a round step for a range and a number of ticks: 1, 2 or 5 times a power of 10. */
function roundStep(span: number, count: number): number {
  const raw = span / Math.max(1, count);
  const power = 10 ** Math.floor(Math.log10(raw));
  const share = raw / power;
  return (share <= 1 ? 1 : share <= 2 ? 2 : share <= 5 ? 5 : 10) * power;
}

/** This function gives round numbers in a range, for about `count` ticks. */
function roundNumbers(low: number, high: number, count: number): number[] {
  if (!(high > low)) return [low];
  const step = roundStep(high - low, count);
  const out: number[] = [];
  for (let i = Math.ceil(low / step - 1e-9); i * step <= high + step * 1e-9; i++) out.push(Number((i * step).toPrecision(12)));
  return out;
}

/** This function gives the values 1, 2 and 5 times each power of 10 in a range, for about `count` ticks. */
function logNumbers(low: number, high: number, count: number): number[] {
  const out: number[] = [];
  for (let power = Math.floor(Math.log10(low)); power <= Math.ceil(Math.log10(high)); power++) {
    for (const factor of [1, 2, 5]) {
      const value = Number((factor * 10 ** power).toPrecision(12));
      if (value >= low * (1 - 1e-9) && value <= high * (1 + 1e-9)) out.push(value);
    }
  }
  const powers = out.filter((value) => Number.isInteger(Math.log10(value)));
  return out.length > count && powers.length >= 2 ? powers : out;
}

/** This function gives the ticks of a number range. A log range with too few round values gives linear round values. */
export function numberTicks(low: number, high: number, log: boolean, count: number): readonly Tick[] {
  const scale = (v: number): number => (log ? Math.log10(v) : v);
  const logged = log ? logNumbers(low, high, count) : [];
  const values = logged.length >= 3 ? logged : roundNumbers(low, high, count);
  return values.map((value) => ({ place: high > low ? (scale(value) - scale(low)) / (scale(high) - scale(low)) : 0.5, text: formatValue(value) }));
}

/** This function gives the ticks of an axis. */
export function axisTicks(axis: AxisSpec, count: number): readonly Tick[] {
  if (axis.kind === "number") return numberTicks(axis.range[0], axis.range[1], axis.log, count);
  return axis.levels.map((level) => ({ place: placeOn(axis, level), text: formatValue(level) }));
}

/** This function gives the values of one panel that the value axis must show. */
function panelValues(panel: ExplorerPanel, varied: number): number[] {
  if (panel.kind === "points") return varied === 1 ? panel.points.map((p) => p.value) : [];
  if (panel.kind === "curve") return [...panel.slice.curve.flatMap((c) => [c.low, c.high]), ...panel.slice.points.map((p) => p.value)];
  return [];
}

/**
 * This function gives the two ends of the value axis of a curve view. All the panels of a view share them, so two
 * panels compare by eye. A range of one value grows, so the axis keeps a length.
 */
export function valueRange(view: ExplorerView): readonly [number, number] {
  const values = view.panels.flatMap((panel) => panelValues(panel, view.y === null ? 1 : 2)).filter((v) => Number.isFinite(v) && (!view.log || v > 0));
  if (values.length === 0) return view.log ? [1, 10] : [0, 1];
  const low = Math.min(...values);
  const high = Math.max(...values);
  if (view.log) {
    const margin = high > low ? (high / low) ** 0.05 : 2;
    return [low / margin, high * margin];
  }
  const margin = high > low ? (high - low) * 0.05 : Math.max(Math.abs(low) * 0.1, 1);
  return [low - margin, high + margin];
}

/** This function gives each fitted value of a surface view, with the values of a view of plain points. */
function heatValues(view: ExplorerView): number[] {
  return view.panels.flatMap((panel) => {
    if (panel.kind === "surface") return panel.surface.cells.flatMap((row) => row.map((cell) => cell.value));
    return panel.kind === "points" ? panel.points.map((p) => p.value) : [];
  });
}

/** This function gives the two ends of the color scale of a surface view. All the panels share them. */
export function heatRange(view: ExplorerView): readonly [number, number] {
  const values = heatValues(view).filter((v) => Number.isFinite(v) && (!view.log || v > 0));
  if (values.length === 0) return [0, 1];
  return [Math.min(...values), Math.max(...values)];
}

/** This function gives the step of the color scale of a value, from 0 to `HEAT_STEPS - 1`. */
export function heatStep(value: number, range: readonly [number, number], log: boolean): number {
  const [low, high] = range;
  if (!(high > low)) return Math.floor(HEAT_STEPS / 2);
  const share = log ? (Math.log10(value) - Math.log10(low)) / (Math.log10(high) - Math.log10(low)) : (value - low) / (high - low);
  return Math.max(0, Math.min(HEAT_STEPS - 1, Math.floor(share * HEAT_STEPS)));
}

/** This function gives the edges of the cells around places on an axis, from 0 to 1. There is one more edge than places. */
export function cellEdges(places: readonly number[]): readonly number[] {
  const inner = places.slice(1).map((place, i) => (place + (places[i] as number)) / 2);
  return [0, ...inner, 1];
}

/** A point of a path, in the pixels of a chart. */
export type Pixel = readonly [number, number];

/** This function gives the path of a line through pixels. */
export function linePath(pixels: readonly Pixel[]): string {
  return pixels.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`).join("");
}

/** This function gives the closed path of a band between its upper and its lower pixels. */
export function bandPath(upper: readonly Pixel[], lower: readonly Pixel[]): string {
  return `${linePath([...upper, ...[...lower].reverse()])}Z`;
}

/** This function gives the distance from a measurement in plain words. */
function nearText(nearest: number): string {
  return nearest === 0 ? "A point was measured here." : `The nearest measured point is ${Math.round(nearest * 100)}% of an axis away.`;
}

/** This function gives the text of one place of a band. */
function bandText(band: ResponseBand): string {
  return `fitted ${formatValue(band.value)}, band ${formatValue(band.low)} to ${formatValue(band.high)}. ${nearText(band.nearest)}`;
}

/** This function gives the text of one place of a curve. */
export function curveText(axis: AxisSpec, place: ResponseCurvePoint): string {
  return `${axis.label} ${formatValue(place.at)}: ${bandText(place)}`;
}

/** This function gives the text of one place of a surface. */
export function cellText(x: AxisSpec, y: AxisSpec, atX: ResponseValue, atY: ResponseValue, band: ResponseBand): string {
  return `${x.label} ${formatValue(atX)}, ${y.label} ${formatValue(atY)}: ${bandText(band)}`;
}

/** This function gives the numbers of a panel: each place of a curve, or the measured points of a surface. */
export function numberTable(view: ExplorerView, panel: ExplorerPanel): NumberTable {
  const axes = view.y === null ? [view.x.label] : [view.x.label, view.y.label];
  if (panel.kind === "curve") {
    const rows = panel.slice.curve.map((c) => [formatValue(c.at), formatValue(c.value), formatValue(c.low), formatValue(c.high), `${Math.round(c.nearest * 100)}%`]);
    return { columns: [view.x.label, "Fitted", "Low", "High", "Distance"], rows };
  }
  const points: readonly { readonly at: readonly ResponseValue[]; readonly value: number }[] = panel.kind === "points" ? panel.points : panel.surface.points;
  return { columns: [...axes, "Measured"], rows: points.map((p) => [...p.at.map(formatValue), formatValue(p.value)]) };
}

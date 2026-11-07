/// <reference lib="dom" />
/**
 * The DOM view of the response explorer. This module draws SVG with no framework. The core in `model.ts` gives each
 * rule and each number, and this module connects the core to the page.
 */

import { h, type Child } from "../chrome.ts";
import {
  axisChoices,
  axisTicks,
  bandPath,
  cellEdges,
  cellText,
  curveText,
  facetChoices,
  fadeOf,
  formatValue,
  heatRange,
  heatStep,
  HEAT_STEPS,
  holdControls,
  levelForm,
  linePath,
  MAX_STEPS,
  numberTable,
  numberTicks,
  openRecord,
  placeOn,
  setAxis,
  setFacet,
  setHold,
  setMeasure,
  settle,
  SURFACE_BUDGET_MS,
  valueRange,
  veilOf,
  viewOf,
  type AxisSpec,
  type CurvePanel,
  type DimensionChoice,
  type ExplorerPanel,
  type ExplorerState,
  type ExplorerView,
  type HoldControl,
  type Pixel,
  type PointsPanel,
  type SurfacePanel,
  type Tick,
} from "./model.ts";
import type { ResponseRecord, ResponseValue } from "@mark1russell7/rigor-statistics";

/** The options of `mountExplorer`. */
export interface ExplorerOptions {
  /** The first state. The explorer corrects a state that a record refuses. */
  readonly initial?: Partial<ExplorerState>;
  /** The time of a surface in milliseconds. The default is `SURFACE_BUDGET_MS`. */
  readonly budgetMs?: number;
  /** The clock in milliseconds. The default is `performance.now`. */
  readonly now?: () => number;
}

/** The result of `mountExplorer`. */
export interface ExplorerHandle {
  /** This method gives the choices of the visitor. It gives `null` for a record with faults. */
  state(): ExplorerState | null;
  /** This method removes the explorer from its host. */
  destroy(): void;
}

const SVG = "http://www.w3.org/2000/svg";
/** The most faults that the view lists. */
const MAX_FAULTS = 20;
/** The width of a chart with no layout, for example in a test. */
const FALLBACK_WIDTH = 640;
const MARGIN = { top: 10, right: 14, bottom: 42, left: 50 };
/** The height of a line of text of an axis, in pixels. */
const CHAR_WIDTH = 6.4;

let mounts = 0;

/** This function makes an SVG element with attributes and children. */
function s(tag: string, attrs: Readonly<Record<string, string | number>>, ...children: readonly (Node | string)[]): SVGElement {
  const el = document.createElementNS(SVG, tag);
  for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, String(value));
  el.append(...children);
  return el;
}

/** The plot of a chart: the pixels of its area and of its axes. */
interface Plot {
  readonly width: number;
  readonly height: number;
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** This function gives the plot of a chart. Long level names need room for their turned text. */
function plotOf(width: number, height: number, view: ExplorerView): Plot {
  const turned = turnedLevels(view.x, width - MARGIN.left - MARGIN.right);
  const longest = Math.max(0, ...view.x.levels.map((level) => formatValue(level).length));
  const bottom = height - MARGIN.bottom - (turned ? Math.min(60, longest * CHAR_WIDTH * 0.7) : 0);
  const left = view.y?.kind === "levels" ? Math.min(110, Math.max(MARGIN.left, 12 + Math.max(...view.y.levels.map((level) => formatValue(level).length)) * CHAR_WIDTH)) : MARGIN.left;
  return { width, height, left, top: MARGIN.top, right: width - MARGIN.right, bottom };
}

/** This function gives true when the levels of an axis do not fit side by side. */
function turnedLevels(axis: AxisSpec, room: number): boolean {
  if (axis.kind !== "levels") return false;
  const longest = Math.max(0, ...axis.levels.map((level) => formatValue(level).length));
  return (longest + 1) * CHAR_WIDTH > room / Math.max(1, axis.levels.length);
}

/** This function gives the ticks of an axis that fit in a length. */
function fittedTicks(axis: AxisSpec, length: number): readonly Tick[] {
  return axisTicks(axis, Math.max(2, Math.floor(length / 70)));
}

/** This function draws the horizontal axis. */
function xAxis(plot: Plot, axis: AxisSpec): SVGElement {
  const length = plot.right - plot.left;
  const turned = turnedLevels(axis, length);
  const ticks = fittedTicks(axis, length).map((tick) => {
    const x = plot.left + tick.place * length;
    const label = turned
      ? s("text", { class: "rx-tick", x, y: plot.bottom + 14, "text-anchor": "end", transform: `rotate(-35 ${x} ${plot.bottom + 14})` }, tick.text)
      : s("text", { class: "rx-tick", x, y: plot.bottom + 15, "text-anchor": x + (tick.text.length * CHAR_WIDTH) / 2 > plot.width ? "end" : "middle" }, tick.text);
    return s("g", {}, s("line", { class: "rx-axis", x1: x, x2: x, y1: plot.bottom, y2: plot.bottom + 4 }), label);
  });
  const name = s("text", { class: "rx-axis-name", x: (plot.left + plot.right) / 2, y: plot.height - 6, "text-anchor": "middle" }, axis.log ? `${axis.label}, log scale` : axis.label);
  return s("g", {}, s("line", { class: "rx-axis", x1: plot.left, x2: plot.right, y1: plot.bottom, y2: plot.bottom }), ...ticks, name);
}

/** This function draws the value axis with its grid lines. */
function valueAxis(plot: Plot, ticks: readonly Tick[]): SVGElement {
  const length = plot.bottom - plot.top;
  const lines = ticks.map((tick) => {
    const y = plot.bottom - tick.place * length;
    return s("g", {}, s("line", { class: "rx-grid", x1: plot.left, x2: plot.right, y1: y, y2: y }), s("text", { class: "rx-tick", x: plot.left - 6, y: y + 4, "text-anchor": "end" }, tick.text));
  });
  return s("g", {}, ...lines);
}

/** This function draws the vertical axis of a surface. */
function surfaceAxis(plot: Plot, axis: AxisSpec): SVGElement {
  const length = plot.bottom - plot.top;
  const ticks = axisTicks(axis, Math.max(2, Math.floor(length / 45))).map((tick) => {
    const y = plot.bottom - tick.place * length;
    return s("text", { class: "rx-tick", x: plot.left - 6, y: y + 4, "text-anchor": "end" }, tick.text);
  });
  return s("g", {}, ...ticks);
}

/** The scale of the value axis of a view. */
interface ValueScale {
  readonly range: readonly [number, number];
  readonly log: boolean;
}

/** This function gives the place of a value on the value axis, from 0 to 1. */
function valuePlace(scale: ValueScale, value: number): number {
  const [low, high] = scale.range;
  if (scale.log) return (Math.log10(Math.max(value, low)) - Math.log10(low)) / (Math.log10(high) - Math.log10(low));
  return (value - low) / (high - low);
}

/** This function gives a small steady offset for a dot from its id, so the dots of one level do not all overlap. */
function jitter(id: string, room: number): number {
  let hash = 7;
  for (const char of id) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) % 1009;
  return (hash / 1008 - 0.5) * room;
}

/** The handler of a panel: it moves the mark of the cursor and it gives the text of a place. */
interface Cursor {
  /** The number of places across and up. */
  readonly columns: number;
  readonly rows: number;
  /** This method gives the place at a pixel. */
  at(x: number, y: number): readonly [number, number];
  /** This method moves the mark and gives the text of the place. */
  show(column: number, row: number): string;
}

/** This function connects the pointer and the arrow keys of a chart to its cursor. */
function connect(svg: SVGElement, cursor: Cursor, tell: (text: string) => void): void {
  let column = -1;
  let row = 0;
  const move = (nextColumn: number, nextRow: number): void => {
    column = Math.max(0, Math.min(cursor.columns - 1, nextColumn));
    row = Math.max(0, Math.min(cursor.rows - 1, nextRow));
    tell(cursor.show(column, row));
  };
  svg.addEventListener("pointermove", (event) => {
    const box = svg.getBoundingClientRect();
    const [c, r] = cursor.at((event as PointerEvent).clientX - box.left, (event as PointerEvent).clientY - box.top);
    move(c, r);
  });
  svg.addEventListener("keydown", (event) => {
    const steps: Readonly<Record<string, readonly [number, number]>> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const step = steps[(event as KeyboardEvent).key];
    if (step === undefined) return;
    event.preventDefault();
    move(column < 0 ? 0 : column + step[0], row + step[1]);
  });
}

/** This function makes the frame of a chart with its text for a screen reader. */
function chartFrame(plot: Plot, label: string): SVGElement {
  return s("svg", { class: "rx-svg", width: plot.width, height: plot.height, viewBox: `0 0 ${plot.width} ${plot.height}`, role: "img", "aria-label": label, tabindex: 0 });
}

/** This function draws a band with one strength for each place along the axis. */
function fadedBand(plot: Plot, panel: CurvePanel, scale: ValueScale, axis: AxisSpec, id: string): SVGElement[] {
  const length = plot.right - plot.left;
  const height = plot.bottom - plot.top;
  const curve = panel.slice.curve;
  const px = (at: ResponseValue): number => plot.left + placeOn(axis, at) * length;
  const py = (value: number): number => plot.bottom - valuePlace(scale, value) * height;
  const stops = curve.map((place) => s("stop", { class: "rx-band-stop", offset: placeOn(axis, place.at), "stop-opacity": fadeOf(place.nearest).toFixed(3) }));
  const gradient = s("linearGradient", { id, gradientUnits: "userSpaceOnUse", x1: plot.left, x2: plot.right, y1: 0, y2: 0 }, ...stops);
  const upper = curve.map((place): Pixel => [px(place.at), py(place.high)]);
  const lower = curve.map((place): Pixel => [px(place.at), py(place.low)]);
  return [s("defs", {}, gradient), s("path", { class: "rx-band", d: bandPath(upper, lower), fill: `url(#${id})` })];
}

/** This function draws a band and a mark at each level of a level axis. */
function levelMarks(plot: Plot, panel: CurvePanel, scale: ValueScale, axis: AxisSpec): SVGElement[] {
  const length = plot.right - plot.left;
  const height = plot.bottom - plot.top;
  const room = Math.min(44, (length / Math.max(1, axis.levels.length)) * 0.5);
  return panel.slice.curve.flatMap((place) => {
    const x = plot.left + placeOn(axis, place.at) * length;
    const top = plot.bottom - valuePlace(scale, place.high) * height;
    const bottom = plot.bottom - valuePlace(scale, place.low) * height;
    const y = plot.bottom - valuePlace(scale, place.value) * height;
    return [
      s("rect", { class: "rx-whisker", x: x - room / 2, y: top, width: room, height: Math.max(1, bottom - top), rx: 4, "fill-opacity": (0.3 * fadeOf(place.nearest)).toFixed(3) }),
      s("line", { class: "rx-line", x1: x - room / 2, x2: x + room / 2, y1: y, y2: y }),
    ];
  });
}

/** This function draws a chart with a fitted curve, its band and the measured points. */
function curveChart(view: ExplorerView, panel: CurvePanel, width: number, id: string, tell: (text: string) => void): SVGElement {
  const plot = plotOf(width, 270, view);
  const scale: ValueScale = { range: valueRange(view), log: view.log };
  const length = plot.right - plot.left;
  const height = plot.bottom - plot.top;
  const curve = panel.slice.curve;
  const px = (at: ResponseValue): number => plot.left + placeOn(view.x, at) * length;
  const py = (value: number): number => plot.bottom - valuePlace(scale, value) * height;
  const smooth = view.x.kind === "number";
  const marks = smooth
    ? [...fadedBand(plot, panel, scale, view.x, id), s("path", { class: "rx-line", d: linePath(curve.map((place): Pixel => [px(place.at), py(place.value)])) })]
    : levelMarks(plot, panel, scale, view.x);
  const room = smooth ? 0 : Math.min(30, (length / Math.max(1, view.x.levels.length)) * 0.35);
  const dots = panel.slice.points.map((point) => s("circle", { class: "rx-dot", cx: px(point.at) + jitter(point.id, room), cy: py(point.value), r: 3.5 }));
  const ticks = numberTicks(scale.range[0], scale.range[1], scale.log, Math.max(2, Math.floor(height / 50)));
  const rule = s("line", { class: "rx-cursor", x1: 0, x2: 0, y1: plot.top, y2: plot.bottom, visibility: "hidden" });
  const ring = s("circle", { class: "rx-ring", cx: 0, cy: 0, r: 5, visibility: "hidden" });
  const svg = chartFrame(plot, `${panel.title} ${view.measure.label} over ${view.x.label}.`.trim());
  svg.append(valueAxis(plot, ticks), ...marks, ...dots, xAxis(plot, view.x), rule, ring);
  connect(
    svg,
    {
      columns: curve.length,
      rows: 1,
      at: (x) => {
        const distance = (place: (typeof curve)[number]): number => Math.abs(px(place.at) - x);
        const nearest = curve.reduce((best, place) => (distance(place) < distance(best) ? place : best));
        return [curve.indexOf(nearest), 0];
      },
      show: (column) => {
        const place = curve[column] as (typeof curve)[number];
        for (const [name, value] of [["x1", px(place.at)], ["x2", px(place.at)]] as const) rule.setAttribute(name, String(value));
        ring.setAttribute("cx", String(px(place.at)));
        ring.setAttribute("cy", String(py(place.value)));
        rule.setAttribute("visibility", "visible");
        ring.setAttribute("visibility", "visible");
        return curveText(view.x, place);
      },
    },
    tell,
  );
  return svg;
}

/** This function draws a chart of a surface, or the separate cells of a table. */
function surfaceChart(view: ExplorerView, panel: SurfacePanel, width: number, tell: (text: string) => void): SVGElement {
  const axisY = view.y as AxisSpec;
  const plot = plotOf(width, Math.min(380, Math.max(280, width * 0.72)), view);
  const { x, y, cells } = panel.surface;
  const length = plot.right - plot.left;
  const height = plot.bottom - plot.top;
  const xEdges = cellEdges(x.map((value) => placeOn(view.x, value)));
  const yEdges = cellEdges(y.map((value) => placeOn(axisY, value)));
  const range = heatRange(view);
  const gap = panel.cells ? 2 : 0;
  const cellMarks = cells.flatMap((row, j) =>
    row.flatMap((band, i) => {
      const left = plot.left + (xEdges[i] as number) * length;
      const right = plot.left + (xEdges[i + 1] as number) * length;
      const lower = plot.bottom - (yEdges[j] as number) * height;
      const upper = plot.bottom - (yEdges[j + 1] as number) * height;
      const box = { x: left + gap / 2, y: upper + gap / 2, width: Math.max(0.5, right - left - gap + (gap === 0 ? 0.6 : 0)), height: Math.max(0.5, lower - upper - gap + (gap === 0 ? 0.6 : 0)) };
      const step = heatStep(band.value, range, view.log);
      const parts = [s("rect", { ...box, class: `rx-h${step}` })];
      const veil = veilOf(band.nearest);
      if (veil > 0.02) parts.push(s("rect", { ...box, class: "rx-veil", "fill-opacity": veil.toFixed(3) }));
      if (panel.cells && box.width > 34 && box.height > 18) parts.push(s("text", { class: `rx-cell-text ${step > HEAT_STEPS / 2 ? "rx-on-dark" : "rx-on-light"}`, x: box.x + box.width / 2, y: box.y + box.height / 2 + 4, "text-anchor": "middle" }, formatValue(band.value)));
      return parts;
    }),
  );
  const dots = panel.surface.points.map((point) =>
    s("circle", { class: "rx-dot rx-dot-heat", cx: plot.left + placeOn(view.x, point.at[0]) * length + jitter(point.id, 6), cy: plot.bottom - placeOn(axisY, point.at[1]) * height + jitter(`${point.id}y`, 6), r: 2.5 }),
  );
  const outline = s("rect", { class: "rx-cell-cursor", x: 0, y: 0, width: 0, height: 0, visibility: "hidden" });
  const svg = chartFrame(plot, `${panel.title} ${view.measure.label} over ${view.x.label} and ${axisY.label}.`.trim());
  svg.append(...cellMarks, ...dots, surfaceAxis(plot, axisY), xAxis(plot, view.x), outline);
  const find = (edges: readonly number[], share: number): number => {
    const index = edges.findIndex((edge) => edge > share);
    return Math.max(0, (index < 0 ? edges.length : index) - 1);
  };
  connect(
    svg,
    {
      columns: x.length,
      rows: y.length,
      at: (px, py) => [find(xEdges, (px - plot.left) / length), y.length - 1 - find(yEdges, (plot.bottom - py) / height)],
      show: (column, row) => {
        const j = y.length - 1 - row;
        outline.setAttribute("x", String(plot.left + (xEdges[column] as number) * length));
        outline.setAttribute("width", String(((xEdges[column + 1] as number) - (xEdges[column] as number)) * length));
        outline.setAttribute("y", String(plot.bottom - (yEdges[j + 1] as number) * height));
        outline.setAttribute("height", String(((yEdges[j + 1] as number) - (yEdges[j] as number)) * height));
        outline.setAttribute("visibility", "visible");
        return cellText(view.x, axisY, x[column] as ResponseValue, y[j] as ResponseValue, cells[j]?.[column] as (typeof cells)[number][number]);
      },
    },
    tell,
  );
  return svg;
}

/** This function draws the measured points of a measure with no model. */
function pointsChart(view: ExplorerView, panel: PointsPanel, width: number): SVGElement {
  const plot = plotOf(width, 270, view);
  const length = plot.right - plot.left;
  const height = plot.bottom - plot.top;
  const svg = chartFrame(plot, `${panel.title} ${view.measure.label}: ${panel.points.length} measured points.`.trim());
  if (view.y === null) {
    const scale: ValueScale = { range: valueRange(view), log: view.log };
    const room = view.x.kind === "levels" ? Math.min(30, (length / Math.max(1, view.x.levels.length)) * 0.35) : 0;
    const dots = panel.points.map((point) => s("circle", { class: "rx-dot", cx: plot.left + placeOn(view.x, point.at[0] as ResponseValue) * length + jitter(point.id, room), cy: plot.bottom - valuePlace(scale, point.value) * height, r: 3.5 }));
    const ticks = numberTicks(scale.range[0], scale.range[1], scale.log, Math.max(2, Math.floor(height / 50)));
    svg.append(valueAxis(plot, ticks), ...dots, xAxis(plot, view.x));
    return svg;
  }
  const axisY = view.y;
  const range = heatRange(view);
  const dots = panel.points.map((point) =>
    s("circle", { class: `rx-h${heatStep(point.value, range, view.log)} rx-ring-dot`, cx: plot.left + placeOn(view.x, point.at[0] as ResponseValue) * length + jitter(point.id, 8), cy: plot.bottom - placeOn(axisY, point.at[1] as ResponseValue) * height + jitter(`${point.id}y`, 8), r: 5 }),
  );
  svg.append(...dots, surfaceAxis(plot, axisY), xAxis(plot, view.x));
  return svg;
}

/** This function gives the number of measured points of a panel. */
function pointCount(panel: ExplorerPanel): number {
  if (panel.kind === "curve") return panel.slice.points.length;
  return panel.kind === "surface" ? panel.surface.points.length : panel.points.length;
}

/** This function gives the sentence about the measured points of a panel. */
function pointsText(panel: ExplorerPanel): string {
  const count = pointCount(panel);
  if (count === 0) return "No measured point has these held values.";
  return count === 1 ? "1 measured point has these held values." : `${count} measured points have these held values.`;
}

/** This function draws one panel. */
function panelChart(view: ExplorerView, panel: ExplorerPanel, width: number, id: string, tell: (text: string) => void): SVGElement {
  if (panel.kind === "curve") return curveChart(view, panel, width, id, tell);
  return panel.kind === "surface" ? surfaceChart(view, panel, width, tell) : pointsChart(view, panel, width);
}

/** This function makes the legend of a view. */
function legendOf(view: ExplorerView): HTMLElement {
  const item = (mark: HTMLElement, text: string): HTMLElement => h("span", { class: "rx-key" }, mark, text);
  const mark = (name: string): HTMLElement => h("i", { class: `rx-mark ${name}`, "aria-hidden": "true" });
  const parts: Child[] = [];
  const panel = view.panels[0];
  const surface = view.y !== null && panel?.kind !== "curve";
  if (panel?.kind === "curve") parts.push(item(mark("rx-mark-line"), "fitted value"), item(mark("rx-mark-band"), "band: one held-out error each side. It fades away from the data."));
  if (surface) {
    const [low, high] = heatRange(view);
    const ramp = h("i", { class: "rx-ramp", "aria-hidden": "true" }, ...Array.from({ length: HEAT_STEPS }, (_, i) => h("b", { class: `rx-s${i}` })));
    parts.push(h("span", { class: "rx-key" }, formatValue(low), ramp, formatValue(high)));
    if (panel?.kind === "surface") parts.push(item(mark("rx-mark-veil"), "gray veil: far from the data"));
  }
  if (panel !== undefined) parts.push(item(mark("rx-mark-dot"), "measured point"));
  return h("p", { class: "rx-legend" }, ...parts);
}

/** This function makes a table of numbers. */
function tableOf(view: ExplorerView, panel: ExplorerPanel): HTMLElement {
  const { columns, rows } = numberTable(view, panel);
  const head = h("tr", {}, ...columns.map((column) => h("th", { scope: "col" }, column)));
  const body = rows.map((row) => h("tr", {}, ...row.map((cell) => h("td", {}, cell))));
  const table = h("table", { class: "rx-table" }, ...(panel.title === "" ? [] : [h("caption", {}, panel.title)]), h("thead", {}, head), h("tbody", {}, ...body));
  return table;
}

/** This function makes a select of dimensions. The first option is the value `none`, if the control has one. */
function dimensionSelect(label: string, key: string, choices: readonly DimensionChoice[], value: string | null, none: string | null, change: (id: string | null) => void): HTMLElement {
  const options = choices.map((choice) => {
    const text = choice.disabled ? `${choice.label}: ${choice.reason}` : choice.label;
    return h("option", { value: choice.id, disabled: choice.disabled, selected: choice.id === value }, text);
  });
  const select = h("select", { "data-key": key }, ...(none === null ? [] : [h("option", { value: "", selected: value === null }, none)]), ...options);
  select.addEventListener("change", () => change(select.value === "" ? null : select.value));
  return h("label", { class: "rx-field" }, h("span", {}, label), select);
}

/** The fields of a level in a group. */
interface LevelOption {
  readonly text: string;
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly reason: string;
  readonly choose: () => void;
}

/** This function makes a select of levels. A closed select shows the held value and takes one row. */
function levelSelect(label: string, key: string, options: readonly LevelOption[], note: string): HTMLElement {
  const items = options.map((option, i) => {
    const text = option.disabled ? `${option.text}: ${option.reason}` : option.text;
    return h("option", { value: i, disabled: option.disabled, selected: option.checked }, text);
  });
  const select = h("select", { "data-key": key }, ...items);
  select.addEventListener("change", () => options[Number(select.value)]?.choose());
  const field = h("label", { class: "rx-field" }, h("span", {}, label), select);
  return h("div", { class: "rx-hold" }, field, note === "" ? null : h("p", { class: "rx-note" }, note));
}

/** This function makes a group of levels. Level buttons are radio inputs, so the keyboard works with no script. */
function levelGroup(label: string, key: string, name: string, options: readonly LevelOption[], note: string): HTMLElement {
  if (levelForm(options.length) === "select") return levelSelect(label, key, options, note);
  const chips = options.map((option, i) => {
    const input = h("input", { class: "rx-radio", type: "radio", name, checked: option.checked, disabled: option.disabled, "data-key": `${key}:${i}` });
    input.addEventListener("change", option.choose);
    return h("label", { class: "rx-chip", title: option.reason === "" ? undefined : option.reason }, input, h("span", {}, option.text));
  });
  const legend = h("legend", { class: "rx-name" }, label);
  return h("fieldset", { class: "rx-hold" }, legend, h("div", { class: "rx-chips" }, ...chips), note === "" ? null : h("p", { class: "rx-note" }, note));
}

/** This function makes a slider over the values of a held dimension. */
function stopSlider(control: HoldControl, key: string, change: (value: ResponseValue) => void): HTMLElement {
  const values = control.options.map((option) => option.value);
  const index = Math.max(0, values.indexOf(control.value));
  const output = h("output", { class: "rx-value" }, formatValue(control.value));
  const input = h("input", { class: "rx-slider", type: "range", min: 0, max: values.length - 1, step: 1, value: index, disabled: !control.applies, "data-key": key, "aria-label": control.label, "aria-valuetext": formatValue(control.value) });
  input.addEventListener("input", () => {
    const value = values[Number(input.value)] as ResponseValue;
    output.textContent = formatValue(value);
    input.setAttribute("aria-valuetext", formatValue(value));
    change(value);
  });
  const head = h("div", { class: "rx-slider-head" }, h("span", { class: "rx-name" }, control.label), output);
  return h("div", { class: "rx-hold" }, head, input, control.note === "" ? null : h("p", { class: "rx-note" }, control.note));
}

/** This function shows each fault of a bad record, with its path. */
function faultView(faults: readonly { readonly path: string; readonly message: string }[]): HTMLElement {
  const items = faults.slice(0, MAX_FAULTS).map((fault) => h("li", {}, h("code", {}, fault.path === "" ? "(the record)" : fault.path), ` ${fault.message}`));
  const more = faults.length > MAX_FAULTS ? h("p", {}, `The list shows ${MAX_FAULTS} of ${faults.length} faults.`) : null;
  const title = faults.length === 1 ? "This record has 1 fault." : `This record has ${faults.length} faults.`;
  return h("div", { class: "rx-faults", role: "alert" }, h("p", { class: "rx-faults-title" }, title), h("ul", {}, ...items), more);
}

/**
 * This function shows a record of the format `response-records/1` in a host element. It reads the record only with
 * `parseResponseRecord`. A bad record shows its faults with their paths, and the function does not throw.
 *
 * @param host - The element of the explorer. The function replaces its children.
 * @param recordJson - The record as JSON text, or as parsed data.
 * @param options - The first state, the time of a surface and the clock.
 */
export function mountExplorer(host: HTMLElement, recordJson: unknown, options: ExplorerOptions = {}): ExplorerHandle {
  const parsed = openRecord(recordJson);
  if (!parsed.ok) {
    host.replaceChildren(h("div", { class: "response-explorer" }, faultView(parsed.faults)));
    return { state: () => null, destroy: () => host.replaceChildren() };
  }
  return mountRecord(host, parsed.record, options);
}

/** This function connects a good record to the DOM. */
function mountRecord(host: HTMLElement, record: ResponseRecord, options: ExplorerOptions): ExplorerHandle {
  const { budgetMs = SURFACE_BUDGET_MS, now = (): number => performance.now() } = options;
  const mount = ++mounts;
  let state = settle(record, options.initial);
  let cap = MAX_STEPS;
  let frame = 0;
  let drawnWidth = 0;
  let view: ExplorerView | undefined;
  // The fold of the held values that do not apply stays open or closed when the controls draw again.
  let idleOpen = false;

  const controls = h("div", { class: "rx-controls" });
  const panels = h("div", { class: "rx-panels" });
  const error = h("p", { class: "rx-error" });
  const model = h("p", { class: "rx-note" });
  const legend = h("div", { class: "rx-legend-box" });
  const readout = h("p", { class: "rx-readout", "aria-live": "polite" });
  const numbers = h("div", { class: "rx-numbers-body" });
  const details = h("details", { class: "rx-numbers" }, h("summary", {}, "Show the numbers"), numbers);
  const chart = h("div", { class: "rx-chart" }, error, panels, legend, readout, model, details);
  const root = h("div", { class: "response-explorer" }, controls, chart);

  const tell = (text: string): void => {
    readout.textContent = text;
  };

  /** This function fills the table when the visitor opens it, so a closed table costs no time. */
  const drawNumbers = (): void => {
    numbers.replaceChildren(...(details.open && view !== undefined ? view.panels.map((panel) => h("div", { class: "rx-table-box scroll-cue" }, tableOf(view as ExplorerView, panel))) : []));
  };

  /** This function draws the charts of the last view at the width of the host. */
  const drawCharts = (): void => {
    const current = view;
    if (current === undefined) return;
    const single = current.panels.length === 1;
    const available = panels.clientWidth > 0 ? panels.clientWidth : FALLBACK_WIDTH;
    const columns = single ? 1 : Math.min(current.panels.length, Math.max(1, Math.floor((available + 12) / 272)));
    const width = Math.floor((available - (columns - 1) * 12) / columns);
    drawnWidth = available;
    panels.replaceChildren(
      ...current.panels.map((panel, i) => {
        const title = panel.title === "" ? null : h("figcaption", { class: "rx-panel-title" }, panel.title);
        const chartBox = panelChart(current, panel, width, `rx-band-${mount}-${i}`, tell);
        return h("figure", { class: "rx-panel" }, title, chartBox, h("p", { class: "rx-note" }, pointsText(panel)));
      }),
    );
  };

  /** This function asks the core for a view, and it draws the view. */
  const drawView = (): void => {
    const next = viewOf(record, state, { stepsCap: cap, budgetMs, now });
    view = next;
    cap = next.nextCap;
    if (next.problem !== "") {
      error.textContent = `The record refused this view: ${next.problem}`;
    } else {
      const head = next.error === null ? null : h("strong", {}, "Held-out error. ");
      error.replaceChildren(...(head === null ? [] : [head]), next.errorText);
    }
    model.textContent = [next.modelText, next.gridText, next.rangeText].filter((text) => text !== "").join(" ");
    legend.replaceChildren(legendOf(next));
    tell("Move over a chart, or focus it and use the arrow keys.");
    drawCharts();
    drawNumbers();
  };

  /** This function draws at the next frame. A slider gives many events in one frame. */
  const later = (): void => {
    if (frame !== 0) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      drawView();
    });
  };

  /** This function makes the controls of the state again, and it keeps the focus on the same control. */
  const drawControls = (): void => {
    const focused = document.activeElement instanceof HTMLElement ? document.activeElement.dataset["key"] : undefined;
    const update = (next: ExplorerState): void => {
      state = next;
      drawControls();
      drawView();
    };
    const measures = levelGroup(
      "Measure",
      "measure",
      `rx-measure-${mount}`,
      record.measures.map((m) => ({ text: m.label, checked: m.id === state.measure, disabled: false, reason: "", choose: () => update(setMeasure(record, state, m.id)) })),
      "",
    );
    const axes = h(
      "div",
      { class: "rx-axes" },
      dimensionSelect("Across", "x", axisChoices(record, state, "x"), state.x, null, (id) => update(setAxis(record, state, "x", id))),
      dimensionSelect("Up", "y", axisChoices(record, state, "y"), state.y, "None (a curve)", (id) => update(setAxis(record, state, "y", id))),
      dimensionSelect("Panels", "facet", facetChoices(record, state), state.facet, "One panel", (id) => update(setFacet(record, state, id))),
    );
    const holdOf = (control: HoldControl): HTMLElement => {
      if (control.kind === "stops") {
        return stopSlider(control, `hold:${control.id}`, (value) => {
          state = setHold(record, state, control.id, value);
          later();
        });
      }
      const levels = control.options.map((option) => ({ text: option.text, checked: option.value === control.value, disabled: option.disabled, reason: option.reason, choose: () => update(setHold(record, state, control.id, option.value)) }));
      return levelGroup(control.label, `hold:${control.id}`, `rx-${mount}-${control.id}`, levels, control.note);
    };
    // A held value that does not apply at the level of its parent goes in one closed fold, so the visitor sees first the values that change the view.
    const holds = holdControls(record, state);
    const idle = holds.filter((control) => !control.applies);
    const fold = idle.length === 0 ? null : h("details", { class: "rx-idle", open: idleOpen }, h("summary", {}, `Held values that do not apply (${idle.length})`), h("div", { class: "rx-idle-list" }, ...idle.map(holdOf)));
    fold?.addEventListener("toggle", () => {
      idleOpen = fold.open;
    });
    const held = holds.length === 0 ? [] : [h("p", { class: "rx-section" }, "Held values"), ...holds.filter((control) => control.applies).map(holdOf), ...(fold === null ? [] : [fold])];
    controls.replaceChildren(measures, axes, ...held);
    if (focused !== undefined) {
      const keyed = [...controls.querySelectorAll<HTMLElement>("[data-key]")].find((el) => el.dataset["key"] === focused);
      keyed?.focus();
    }
  };

  details.addEventListener("toggle", drawNumbers);
  host.replaceChildren(root);
  drawControls();
  drawView();

  const observer =
    typeof ResizeObserver === "undefined"
      ? undefined
      : new ResizeObserver(() => {
          if (panels.clientWidth > 0 && Math.abs(panels.clientWidth - drawnWidth) > 1) drawCharts();
        });
  observer?.observe(panels);

  return {
    state: () => state,
    destroy: () => {
      observer?.disconnect();
      if (frame !== 0) cancelAnimationFrame(frame);
      host.replaceChildren();
    },
  };
}

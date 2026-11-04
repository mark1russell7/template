/**
 * The entry `./explorer` of the package: the view of a measured response in `response-records/1`. The entry has no
 * Node.js import, so a site can bundle it. The entry `./explorer.css` gives its style.
 */

export {
  axisChoices,
  facetChoices,
  holdControls,
  MAX_PANELS,
  MAX_STEPS,
  MIN_STEPS,
  nextStepsCap,
  numberTable,
  openRecord,
  planSteps,
  READ_BUDGET,
  setAxis,
  setFacet,
  setHold,
  setMeasure,
  settle,
  SURFACE_BUDGET_MS,
  viewOf,
  type AxisSlot,
  type AxisSpec,
  type CurvePanel,
  type DimensionChoice,
  type ExplorerPanel,
  type ExplorerState,
  type ExplorerView,
  type HoldControl,
  type HoldOption,
  type NumberTable,
  type PlainPoint,
  type PointsPanel,
  type SurfacePanel,
  type ViewOptions,
} from "./model.ts";
export { mountExplorer, type ExplorerHandle, type ExplorerOptions } from "./view.ts";

/** The model of the site, with no DOM: the package preview, the workflow reader and the evaluator of conditions. */

export { compareFiles, conditionInputs, contextValue, EVENTS, explore, inputDefault, lineMarks, personalize, treeRows } from "./model.ts";
export type { EventName, FileMark, JobView, RunState, StepView, TreeRow } from "./model.ts";
export { evaluate, stateOf, truthy, UNKNOWN } from "./expr.ts";
export type { Reference, Result, Value } from "./expr.ts";
export { highlight } from "./highlight.ts";
export type * from "./types.ts";

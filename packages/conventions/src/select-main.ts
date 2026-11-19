/**
 * The entry of the bundle of the action `select` (`tsdown.actions.config.ts`). It runs the selector on the git checkout of
 * the current folder.
 */
import { runSelect } from "./select.ts";

process.exitCode = runSelect(process.env, process.cwd(), () => performance.now());

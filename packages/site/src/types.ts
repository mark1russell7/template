/** The data of the site. The build makes it from the CLI and from the workflow files of the repository. */

/** A file of a new package: its path in the package folder, and its text. */
export interface ScaffoldFile {
  readonly path: string;
  readonly text: string;
}

/** The new package of one preset, as the CLI wrote it. */
export interface ScaffoldPreset {
  /** The value of `--preset`. */
  readonly name: string;
  /** The text of the prompt of the CLI for the preset. */
  readonly label: string;
  /** The files of the package, in path order. */
  readonly files: readonly ScaffoldFile[];
  /** The `pnpm add` commands that the CLI starts after it writes the files. */
  readonly install: readonly string[];
}

/** The output of the CLI for each preset. The package name and the scope are marks that the page replaces. */
export interface ScaffoldData {
  readonly cliVersion: string;
  /** The folder of the CLI in the repository. */
  readonly cliSource: string;
  readonly nameMark: string;
  readonly scopeMark: string;
  /** The pattern of a package name that the CLI accepts, as the source of a RegExp. */
  readonly namePattern: string;
  readonly presets: readonly ScaffoldPreset[];
}

/** The shared workflows of the repository, as the reader of `@mark1russell7/conventions` gives them. */
import type { Workflow } from "@mark1russell7/conventions";

export type { Workflow, WorkflowInput, WorkflowJob, WorkflowStep } from "@mark1russell7/conventions";

/** All the data of the site. */
export interface SiteData {
  readonly scaffold: ScaffoldData;
  readonly workflows: readonly Workflow[];
  /** The short commit and the date of the build. */
  readonly build: { readonly sha: string; readonly date: string };
}

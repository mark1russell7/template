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

/** An input of a shared workflow (`on.workflow_call.inputs`). */
export interface WorkflowInput {
  readonly name: string;
  readonly type: string;
  readonly description: string;
  /** The default value, as YAML text. An empty text is no default. */
  readonly default: string;
  readonly required: boolean;
}

/** A step of a job. */
export interface WorkflowStep {
  /** The name of the step, or else its action, its id or its first command. */
  readonly label: string;
  /** The condition of the step (`if`), or an empty text. */
  readonly if: string;
  /** The action of the step (`uses`), with no pin, or an empty text. */
  readonly uses: string;
}

/** A job of a workflow. */
export interface WorkflowJob {
  readonly id: string;
  readonly if: string;
  readonly needs: readonly string[];
  readonly steps: readonly WorkflowStep[];
}

/** A shared workflow of the repository. */
export interface Workflow {
  /** The file name, for example `reusable-pages.yml`. */
  readonly file: string;
  /** The value of `name`. */
  readonly name: string;
  /** The first lines of the comment at the top of the file. */
  readonly summary: string;
  readonly inputs: readonly WorkflowInput[];
  readonly jobs: readonly WorkflowJob[];
}

/** All the data of the site. */
export interface SiteData {
  readonly scaffold: ScaffoldData;
  readonly workflows: readonly Workflow[];
  /** The short commit and the date of the build. */
  readonly build: { readonly sha: string; readonly date: string };
}

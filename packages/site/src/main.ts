/**
 * The page of the template: the package preview and the workflow explorer. The data comes from the build
 * (`virtual:site-data`). This module connects the model (`model.ts`) to the DOM.
 */

import data from "virtual:site-data";
import { highlight } from "./highlight.ts";
import { compareFiles, conditionInputs, EVENTS, explore, inputDefault, lineMarks, personalize, treeRows, type EventName, type FileMark, type RunState } from "./model.ts";
import { UNKNOWN, type Value } from "./expr.ts";
import type { ScaffoldPreset, Workflow } from "./types.ts";

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`The page has no #${id}.`);
  return el as T;
};

/** This function makes an element with some attributes and children. */
function h(tag: string, attrs: Record<string, string | boolean | undefined> = {}, ...children: (Node | string)[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    if (key === "class") el.className = String(value);
    else el.setAttribute(key, value === true ? "" : value);
  }
  el.append(...children);
  return el;
}

// The theme: the choice of the visitor goes in localStorage. Without a choice, the page follows the system.
const root = document.documentElement;
const dark = (): boolean => (root.dataset["theme"] ? root.dataset["theme"] === "dark" : matchMedia("(prefers-color-scheme: dark)").matches);
const themeButton = $("theme");
const showTheme = (): void => themeButton.setAttribute("aria-label", dark() ? "Use the light theme" : "Use the dark theme");
themeButton.addEventListener("click", () => {
  root.dataset["theme"] = dark() ? "light" : "dark";
  try {
    localStorage.setItem("theme", root.dataset["theme"]);
  } catch {
    // A browser can refuse the storage. The theme still changes.
  }
  showTheme();
});
showTheme();

// ---- The package preview ----

const scaffold = data.scaffold;
const NAME = new RegExp(scaffold.namePattern);
const presets = new Map(scaffold.presets.map((preset) => [preset.name, preset]));
const state = {
  preset: presets.has("react") ? "react" : (scaffold.presets[0]?.name ?? ""),
  compare: "node",
  name: "web",
  scope: "acme",
  file: "package.json",
};

const nameInput = $<HTMLInputElement>("pkg-name");
const scopeInput = $<HTMLInputElement>("pkg-scope");
const compareSelect = $<HTMLSelectElement>("compare");
const presetBox = $("presets");
const codeBox = $("code-box");

compareSelect.append(h("option", { value: "" }, "nothing"), ...scaffold.presets.map((preset) => h("option", { value: preset.name }, preset.name)));
compareSelect.value = state.compare;

/** This function gives the files of a preset for the name and the scope of the visitor. */
const filesOf = (preset: ScaffoldPreset | undefined) => (preset === undefined ? undefined : personalize(scaffold, preset, displayName(), displayScope()));
const displayName = (): string => (NAME.test(state.name) ? state.name : "web");
const displayScope = (): string => (NAME.test(state.scope) ? state.scope : "acme");

/** This function gives the number of files of a preset that differ from the preset of the comparison. */
function changes(preset: ScaffoldPreset): number {
  const base = presets.get(state.compare);
  if (base === undefined || base === preset) return 0;
  const { marks, removed } = compareFiles(preset.files, base.files);
  return [...marks.values()].filter((mark) => mark !== "same").length + removed.length;
}

function renderPresets(): void {
  presetBox.replaceChildren(
    ...scaffold.presets.map((preset) => {
      const count = changes(preset);
      const [, about = preset.label] = preset.label.split(/\s+—\s+/);
      const button = h(
        "button",
        { type: "button", role: "radio", class: "preset", "data-preset": preset.name, "aria-checked": String(preset.name === state.preset) },
        h("b", {}, preset.name),
        h("span", { class: "about" }, about),
        h("span", { class: "delta" }, preset.name === state.compare ? "base" : state.compare === "" ? "" : count === 0 ? "same" : `${count} ${count === 1 ? "file" : "files"} differ`),
      );
      button.addEventListener("click", () => {
        state.preset = preset.name;
        render();
      });
      return button;
    }),
  );
}

const MARK_TEXT: Record<FileMark, string> = { same: "", changed: "changed", added: "new" };

function render(): void {
  const preset = presets.get(state.preset);
  if (preset === undefined) return;
  const own = filesOf(preset);
  const base = filesOf(presets.get(state.compare));
  if (own === undefined) return;
  const compared = base !== undefined && state.compare !== state.preset ? base : undefined;
  const { marks, removed } = compareFiles(own.files, compared?.files);
  if (!own.files.some((file) => file.path === state.file)) state.file = own.files[0]?.path ?? "";

  $("cmd-preset").textContent = preset.name;
  $("tree-root").textContent = `packages/${displayName()}/`;
  $("tree-count").textContent = `${own.files.length} files`;
  renderPresets();

  const tree = $("tree");
  const rows = treeRows([...own.files.map((file) => file.path), ...removed]);
  tree.replaceChildren(
    ...rows.map((row) => {
      const pad = `--depth:${row.depth}`;
      if (row.kind === "folder") return h("li", { class: "folder", style: pad }, h("span", { class: "icon", "aria-hidden": "true" }, "▾"), `${row.label}/`);
      const gone = removed.includes(row.path);
      const mark = gone ? undefined : marks.get(row.path);
      const item = h(
        "li",
        {
          class: `file ${mark ?? "removed"}`,
          style: pad,
          role: "option",
          tabindex: gone ? undefined : "0",
          "aria-selected": String(row.path === state.file),
          "aria-disabled": gone ? "true" : undefined,
          "data-path": row.path,
          title: gone ? `Only ${state.compare} has this file.` : undefined,
        },
        h("span", { class: "name" }, row.label),
        h("span", { class: "tag" }, gone ? "not here" : MARK_TEXT[mark ?? "same"]),
      );
      if (!gone) {
        const open = (): void => {
          state.file = row.path;
          render();
        };
        item.addEventListener("click", open);
        item.addEventListener("keydown", (event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            open();
          }
        });
      }
      return item;
    }),
  );

  const file = own.files.find((f) => f.path === state.file);
  const other = compared?.files.find((f) => f.path === state.file);
  const text = file?.text ?? "";
  const lineMark = lineMarks(text, compared === undefined ? undefined : (other?.text ?? ""));
  const count = lineMark.filter(Boolean).length;
  $("file-path").textContent = state.file;
  $("file-note").textContent =
    compared === undefined ? "" : other === undefined ? `not in ${state.compare}` : count === 0 ? `same as ${state.compare}` : `${count} ${count === 1 ? "line differs" : "lines differ"} from ${state.compare}`;
  const code = $("code");
  code.replaceChildren(
    ...highlight(text, state.file).map((html, i) => {
      const line = h("span", { class: lineMark[i] ? "line diff" : "line" }, h("span", { class: "ln", "aria-hidden": "true" }, String(i + 1)));
      const body = h("span", { class: "src" });
      body.innerHTML = html || " ";
      line.append(body);
      return line;
    }),
  );
  codeBox.scrollLeft = 0;

  const install = $("install");
  install.replaceChildren(
    ...(own.install.length > 0
      ? [...own.install.map((command) => h("li", { class: "scroll-cue" }, h("code", {}, command))), h("li", { class: "muted" }, "These commands put the newest versions in package.json, and install the workspace.")]
      : [h("li", { class: "muted" }, "The CLI installs nothing. Start ", h("code", {}, "pnpm install"), " to connect the new package.")]),
  );
}

nameInput.addEventListener("input", () => {
  state.name = nameInput.value.trim();
  const ok = NAME.test(state.name);
  nameInput.setAttribute("aria-invalid", String(!ok));
  const error = $("name-error");
  error.hidden = ok;
  error.textContent = ok ? "" : `The CLI refuses this name. A name has lowercase letters, digits and hyphens, and starts with a letter or a digit (${scaffold.namePattern}).`;
  render();
});
scopeInput.addEventListener("input", () => {
  state.scope = scopeInput.value.trim();
  scopeInput.setAttribute("aria-invalid", String(!NAME.test(state.scope)));
  render();
});
compareSelect.addEventListener("change", () => {
  state.compare = compareSelect.value;
  render();
});
$("copy").addEventListener("click", () => {
  const command = `pnpm package add ${displayName()} --preset=${state.preset}`;
  const button = $("copy");
  void navigator.clipboard?.writeText(command).then(
    () => {
      button.textContent = "Copied";
      setTimeout(() => (button.textContent = "Copy"), 1500);
    },
    () => {
      button.textContent = "Select it";
    },
  );
});

// ---- The workflow explorer ----

const workflows = new Map(data.workflows.map((workflow) => [workflow.file, workflow]));
const wf = {
  file: workflows.has("reusable-pages.yml") ? "reusable-pages.yml" : (data.workflows[0]?.file ?? ""),
  event: "pull_request" as EventName,
  values: new Map<string, Map<string, Value>>(),
};
const fileSelect = $<HTMLSelectElement>("wf-file");
fileSelect.append(...data.workflows.map((workflow) => h("option", { value: workflow.file }, workflow.file)));
fileSelect.value = wf.file;
fileSelect.addEventListener("change", () => {
  wf.file = fileSelect.value;
  renderWorkflow();
});

const EVENT_TEXT: Record<EventName, string> = {
  push: "push to main",
  pull_request: "pull request",
  schedule: "schedule",
  workflow_dispatch: "by hand",
  workflow_run: "after CI passed",
};
const STATE_TEXT: Record<RunState, string> = { runs: "runs", skipped: "does not run", unknown: "run decides" };
const STATE_ICON: Record<RunState, string> = { runs: "✓", skipped: "–", unknown: "?" };

function valuesOf(workflow: Workflow): Map<string, Value> {
  let values = wf.values.get(workflow.file);
  if (values === undefined) {
    values = new Map();
    wf.values.set(workflow.file, values);
  }
  return values;
}

const shown = (value: Value): string => (value === UNKNOWN ? "known at run time" : value === null ? "empty" : typeof value === "string" ? `'${value}'` : String(value));

function renderWorkflow(): void {
  const workflow = workflows.get(wf.file);
  if (workflow === undefined) return;
  const values = valuesOf(workflow);
  $("wf-summary").textContent = workflow.summary;

  $("wf-events").replaceChildren(
    ...EVENTS.map((event) => {
      const button = h("button", { type: "button", role: "radio", class: "chip", "data-event": event, "aria-checked": String(event === wf.event), title: event }, EVENT_TEXT[event]);
      button.addEventListener("click", () => {
        wf.event = event;
        renderWorkflow();
      });
      return button;
    }),
  );

  const inputs = conditionInputs(workflow);
  $("wf-inputs").replaceChildren(
    ...(inputs.length === 0
      ? [h("p", { class: "muted" }, "No condition of this workflow reads an input.")]
      : inputs.map((input) => {
          const value = values.has(input.name) ? values.get(input.name) : inputDefault(input);
          if (input.type === "boolean") {
            const box = h("input", { type: "checkbox", "data-input": input.name, checked: value === true }) as HTMLInputElement;
            box.addEventListener("change", () => {
              values.set(input.name, box.checked);
              renderWorkflow();
            });
            return h("label", { class: "switch", title: input.description }, box, h("span", { class: "track", "aria-hidden": "true" }), h("code", {}, input.name));
          }
          const field = h("input", { type: "text", "data-input": input.name, value: value === UNKNOWN || value === null ? "" : String(value), spellcheck: "false", "aria-label": input.name }) as HTMLInputElement;
          field.addEventListener("change", () => {
            values.set(input.name, input.type === "number" ? Number(field.value) : field.value);
            renderWorkflow();
          });
          return h("label", { class: "field", title: input.description }, h("code", {}, input.name), field);
        })),
  );

  const jobs = explore(workflow, wf.event, new Map([...values]));
  const steps = jobs.flatMap((job) => job.steps);
  const tally = (s: RunState): number => steps.filter((step) => step.state === s).length;
  $("wf-count").replaceChildren(
    h("b", {}, String(tally("runs"))),
    ` of ${steps.length} steps run. `,
    h("b", {}, String(tally("skipped"))),
    " do not run. ",
    h("b", {}, String(tally("unknown"))),
    " the run decides.",
  );

  const refsText = (refs: readonly { path: string; value: Value }[]): string => refs.map((ref) => `${ref.path} is ${shown(ref.value)}`).join(", ");
  $("wf-jobs").replaceChildren(
    ...jobs.map((job) =>
      h(
        "article",
        { class: `job ${job.state}`, "data-job": job.id },
        h(
          "header",
          {},
          h("b", {}, job.id),
          h("span", { class: `pill ${job.state}` }, STATE_TEXT[job.state]),
          job.needs.length > 0 ? h("span", { class: "needs" }, `needs ${job.needs.join(", ")}`) : "",
        ),
        job.if ? h("div", { class: "scroll-cue cond-box" }, h("code", { class: "cond" }, `if: ${job.if}`)) : "",
        job.blockedBy ? h("p", { class: "why" }, job.blockedBy) : job.refs.some((ref) => ref.value !== null) ? h("p", { class: "why" }, refsText(job.refs.filter((ref) => ref.value !== null))) : "",
        h(
          "ol",
          { class: "steps" },
          ...job.steps.map((step) =>
            h(
              "li",
              { class: `step ${step.state}`, "data-step": step.label, title: step.if ? `if: ${step.if}` : "" },
              h("span", { class: "icon", "aria-label": STATE_TEXT[step.state] }, STATE_ICON[step.state]),
              h("span", { class: "label" }, h("span", { class: "text" }, step.label), step.if ? h("small", {}, step.refs.length > 0 ? refsText(step.refs) : `if: ${step.if}`) : ""),
            ),
          ),
        ),
      ),
    ),
  );
}

$("wf-list").replaceChildren(
  ...data.workflows.map((workflow) =>
    h(
      "li",
      {},
      h("a", { href: `https://github.com/mark1russell7/template/blob/main/.github/workflows/${workflow.file}` }, h("code", {}, workflow.file)),
      h("span", {}, `${workflow.inputs.length} inputs, ${workflow.jobs.length} ${workflow.jobs.length === 1 ? "job" : "jobs"}`),
    ),
  ),
);

$("build-info").textContent = `Built from ${data.build.sha} on ${data.build.date}, with template-cli ${scaffold.cliVersion} of ${scaffold.cliSource}.`;

render();
renderWorkflow();

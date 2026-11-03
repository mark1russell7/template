/**
 * The probe of the home page. The site check of the Pages workflow starts it in a browser at each width, before the
 * deploy. A failed check stops the deploy.
 *
 * The site check reads this TypeScript file directly. It removes the types and the `export` line, and it starts the
 * result as the body of an async function.
 */

// The site check gives these helpers to the probe.
declare const check: (name: string, ok: unknown, detail?: unknown) => boolean;
declare const until: <T>(fn: () => T | Promise<T>, ms?: number) => Promise<T>;
declare const $: (selector: string) => Element | null;
declare const $$: (selector: string) => Element[];
declare const type: (target: string | Element, text: string) => void;
declare const click: (target: string | Element) => void;

const files = (): string[] => $$("#tree .file").map((li) => li.getAttribute("data-path") ?? "");
const code = (): string => $("#code")?.textContent ?? "";
const field = (selector: string): Element => {
  const el = $(selector);
  if (el === null) throw new Error(`The page has no ${selector}.`);
  return el;
};

check("the page shows the six presets of the CLI", await until(() => $$("#presets [data-preset]").length >= 6), $$("#presets [data-preset]").map((b) => b.getAttribute("data-preset")).join(", "));

click('[data-preset="react"]');
type(field("#pkg-name"), "probe-web");
check("the preset react writes package.json, tsconfig.json and src/index.ts", await until(() => ["package.json", "tsconfig.json", "src/index.ts"].every((path) => files().includes(path))), files().join(", "));
const typed = ($("#pkg-name") as HTMLInputElement | null)?.value;
check("the command names the package and the preset", typed === "probe-web" && $("#cmd-preset")?.textContent === "react", `${typed} --preset=${$("#cmd-preset")?.textContent}`);

click('#tree [data-path="package.json"]');
check("package.json names the typed package name", await until(() => code().includes('"name": "@acme/probe-web"')), code().slice(0, 200));
check("the tree root is the folder of the package", $("#tree-root")?.textContent === "packages/probe-web/", $("#tree-root")?.textContent);

click('#tree [data-path="tsconfig.json"]');
check("tsconfig.json extends the react config of cue", await until(() => code().includes("cue/ts/config/react.json")), code().slice(0, 200));
check("the lines that differ from node have a mark", $$("#code .line.diff").length > 0, `${$$("#code .line.diff").length} marked lines`);
check("react installs react and react-dom after it writes the files", ($("#install")?.textContent ?? "").includes("react react-dom"), $("#install")?.textContent);

click('[data-preset="service"]');
check("the preset service adds src/main.ts as a new file", await until(() => $('#tree [data-path="src/main.ts"]')?.classList.contains("added") === true), files().join(", "));

type(field("#pkg-name"), "Not A Name");
check("the page tells when the CLI refuses a name", await until(() => $("#name-error")?.hasAttribute("hidden") === false), $("#name-error")?.textContent);
type(field("#pkg-name"), "web");

// The workflow explorer: the shared Pages workflow on a pull request.
const job = (id: string): string => $(`#wf-jobs [data-job="${id}"]`)?.className ?? "";
const step = (label: string): string => $$("#wf-jobs .step").find((li) => li.getAttribute("data-step") === label)?.className ?? "";
const pick = (name: string): HTMLInputElement | null => $(`#wf-inputs [data-input="${name}"]`) as HTMLInputElement | null;
const select = field("#wf-file") as HTMLSelectElement;
select.value = "reusable-pages.yml";
select.dispatchEvent(new Event("change", { bubbles: true }));
click('[data-event="pull_request"]');
check("the explorer shows the jobs build and deploy of the Pages workflow", await until(() => job("build") !== "" && job("deploy") !== ""), $$("#wf-jobs [data-job]").map((j) => j.getAttribute("data-job")).join(", "));

const deploy = pick("deploy");
if (deploy?.checked) click(deploy);
check("deploy off: the job deploy does not run", await until(() => job("deploy").includes("skipped")), job("deploy"));
const siteCheck = pick("site-check");
if (siteCheck && !siteCheck.checked) click(siteCheck);
check("site-check on: the step Site check runs", await until(() => step("Site check").includes("runs")), step("Site check"));
const siteCheckOn = pick("site-check");
if (siteCheckOn?.checked) click(siteCheckOn);
check("site-check off: the step Site check does not run", await until(() => step("Site check").includes("skipped")), step("Site check"));

click('[data-event="schedule"]');
check("a scheduled build runs the step of green-main", await until(() => step("Shared actions (green-main)").includes("runs")), step("Shared actions (green-main)"));

const before = document.documentElement.dataset["theme"] ?? "";
click("#theme");
check("the theme button changes the theme", (document.documentElement.dataset["theme"] ?? "") !== before, document.documentElement.dataset["theme"]);
click("#theme");
// The choice of the probe must not stay for the next page of the check, which can have the other theme.
localStorage.removeItem("theme");
delete document.documentElement.dataset["theme"];

export {};

/**
 * The list of the rules, in the order of the output.
 */
import type { Rule } from "../rule.ts";
import { changelogVersion } from "./changelog-version.ts";
import { cuePreset } from "./cue-preset.ts";
import { gateAfterCancel } from "./gate-after-cancel.ts";
import { gateTrigger } from "./gate-trigger.ts";
import { securityOneJob } from "./security-one-job.ts";
import { summaryJobRule } from "./summary-job.ts";
import { setupCue } from "./setup-cue.ts";
import { sharedCi } from "./shared-ci.ts";
import { serviceRunMain } from "./service-run-main.ts";
import { homePackage } from "./home-package.ts";
import { licenseFile } from "./license-file.ts";
import { mainCheck } from "./main-check.ts";
import { mainRunsFinish } from "./main-runs-finish.ts";
import { noBuildOutput } from "./no-build-output.ts";
import { noLocalPaths } from "./no-local-paths.ts";
import { apiReportScript } from "./api-report-script.ts";
import { pagesAfterRelease } from "./pages-after-release.ts";
import { pagesSite } from "./pages-site.ts";
import { pinnedGitDeps } from "./pinned-git-deps.ts";
import { pipeFails } from "./pipe-fails.ts";
import { pushMainOnly } from "./push-main-only.ts";
import { publishedMinor } from "./published-minor.ts";
import { releaseFiles } from "./release-files.ts";
import { requiredScripts } from "./required-scripts.ts";
import { roadmapParses } from "./roadmap-parses.ts";
import { runnerBudget } from "./runner-budget.ts";
import { sharedDocs } from "./shared-docs.ts";
import { sourceMain } from "./source-main.ts";
import { testsRequired } from "./tests-required.ts";
import { tsconfigTest } from "./tsconfig-test.ts";
import { typedFiles } from "./typed-files.ts";
import { typedScripts } from "./typed-scripts.ts";
import { trustPolicy } from "./trust-policy.ts";
import { unreleasedChange } from "./unreleased-change.ts";
import { versionTitle } from "./version-title.ts";
import { workflowParses } from "./workflow-parses.ts";
import { workspaceProtocol } from "./workspace-protocol.ts";

/** Each rule of the check. */
export const RULES: readonly Rule[] = [
  pinnedGitDeps,
  workspaceProtocol,
  trustPolicy,
  sourceMain,
  serviceRunMain,
  tsconfigTest,
  cuePreset,
  requiredScripts,
  noBuildOutput,
  noLocalPaths,
  apiReportScript,
  releaseFiles,
  unreleasedChange,
  versionTitle,
  publishedMinor,
  changelogVersion,
  typedScripts,
  typedFiles,
  mainCheck,
  testsRequired,
  roadmapParses,
  workflowParses,
  runnerBudget,
  mainRunsFinish,
  pushMainOnly,
  pipeFails,
  gateAfterCancel,
  gateTrigger,
  securityOneJob,
  summaryJobRule,
  sharedCi,
  setupCue,
  homePackage,
  licenseFile,
  pagesSite,
  pagesAfterRelease,
  sharedDocs,
];

export { publishedMinor };
export { apiReportScript, changelogVersion, cuePreset, gateAfterCancel, gateTrigger, securityOneJob, serviceRunMain, setupCue, sharedCi, summaryJobRule, homePackage, licenseFile, mainCheck, mainRunsFinish, noBuildOutput, noLocalPaths, pagesAfterRelease, pagesSite, pinnedGitDeps, pipeFails, pushMainOnly, releaseFiles, requiredScripts, roadmapParses, runnerBudget, sharedDocs, sourceMain, testsRequired, trustPolicy, tsconfigTest, typedFiles, typedScripts, unreleasedChange, versionTitle, workflowParses, workspaceProtocol };

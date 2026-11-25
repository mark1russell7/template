/**
 * The list of the rules, in the order of the output.
 */
import type { Rule } from "../rule.ts";
import { changelogVersion } from "./changelog-version.ts";
import { cuePreset } from "./cue-preset.ts";
import { gateAfterCancel } from "./gate-after-cancel.ts";
import { gateTrigger } from "./gate-trigger.ts";
import { securityGate } from "./security-gate.ts";
import { securityOneJob } from "./security-one-job.ts";
import { summaryJobRule } from "./summary-job.ts";
import { setupCue } from "./setup-cue.ts";
import { sharedCi } from "./shared-ci.ts";
import { serviceRunMain } from "./service-run-main.ts";
import { homeModule } from "./home-module.ts";
import { homePackage } from "./home-package.ts";
import { licenseFile } from "./license-file.ts";
import { coverageProvider } from "./coverage-provider.ts";
import { mainCheck } from "./main-check.ts";
import { mainRunsFinish } from "./main-runs-finish.ts";
import { movedRepoCalls } from "./moved-repo-calls.ts";
import { movedRepoNames } from "./moved-repo-names.ts";
import { noBuildOutput } from "./no-build-output.ts";
import { noConsole } from "./no-console.ts";
import { noLocalPaths } from "./no-local-paths.ts";
import { packNoBuildinfo } from "./pack-no-buildinfo.ts";
import { publishTextSafe } from "./publish-text-safe.ts";
import { exportsRequire } from "./exports-require.ts";
import { apiReportScript } from "./api-report-script.ts";
import { pagesAfterRelease } from "./pages-after-release.ts";
import { pagesSite } from "./pages-site.ts";
import { siteCheckInCi } from "./site-check-in-ci.ts";
import { pinnedGitDeps } from "./pinned-git-deps.ts";
import { pipeFails } from "./pipe-fails.ts";
import { jobFails } from "./job-fails.ts";
import { playwrightInstall } from "./playwright-install.ts";
import { pushMainOnly } from "./push-main-only.ts";
import { publishedMinor } from "./published-minor.ts";
import { releaseFiles } from "./release-files.ts";
import { requiredScripts } from "./required-scripts.ts";
import { roadmapParses } from "./roadmap-parses.ts";
import { runnerBudget } from "./runner-budget.ts";
import { runnerPeak } from "./runner-peak.ts";
import { scheduleLiterals } from "./schedule-literals.ts";
import { sharedDocs } from "./shared-docs.ts";
import { sourceMain } from "./source-main.ts";
import { testsRequired } from "./tests-required.ts";
import { tsconfigTest } from "./tsconfig-test.ts";
import { typedFiles } from "./typed-files.ts";
import { typedScripts } from "./typed-scripts.ts";
import { trustPolicy } from "./trust-policy.ts";
import { securityOverrides } from "./security-overrides.ts";
import { unreleasedChange } from "./unreleased-change.ts";
import { versionTitle } from "./version-title.ts";
import { workflowParses } from "./workflow-parses.ts";
import { workspaceProtocol } from "./workspace-protocol.ts";

/** Each rule of the check. */
export const RULES: readonly Rule[] = [
  pinnedGitDeps,
  workspaceProtocol,
  trustPolicy,
  securityOverrides,
  sourceMain,
  serviceRunMain,
  tsconfigTest,
  cuePreset,
  requiredScripts,
  noBuildOutput,
  noLocalPaths,
  noConsole,
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
  runnerPeak,
  mainRunsFinish,
  pushMainOnly,
  pipeFails,
  jobFails,
  gateAfterCancel,
  gateTrigger,
  securityOneJob,
  securityGate,
  summaryJobRule,
  sharedCi,
  setupCue,
  playwrightInstall,
  movedRepoCalls,
  movedRepoNames,
  scheduleLiterals,
  homePackage,
  homeModule,
  licenseFile,
  coverageProvider,
  packNoBuildinfo,
  publishTextSafe,
  exportsRequire,
  pagesSite,
  siteCheckInCi,
  pagesAfterRelease,
  sharedDocs,
];

export { publishedMinor };
export { apiReportScript, changelogVersion, coverageProvider, cuePreset, exportsRequire, gateAfterCancel, gateTrigger, securityGate, securityOneJob, securityOverrides, serviceRunMain, setupCue, sharedCi, summaryJobRule, homeModule, homePackage, jobFails, licenseFile, mainCheck, mainRunsFinish, movedRepoCalls, movedRepoNames, noBuildOutput, noConsole, noLocalPaths, packNoBuildinfo, pagesAfterRelease, pagesSite, pinnedGitDeps, pipeFails, playwrightInstall, pushMainOnly, releaseFiles, requiredScripts, roadmapParses, runnerBudget, runnerPeak, scheduleLiterals, sharedDocs, siteCheckInCi, sourceMain, testsRequired, trustPolicy, tsconfigTest, typedFiles, typedScripts, unreleasedChange, versionTitle, workflowParses, workspaceProtocol, publishTextSafe };

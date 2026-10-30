# Roadmap

This file is the plan of the template. The Status page of the site reads it, and the tracker of the strategist mirrors it.

| ID | Item | Status | Summary |
| --- | --- | --- | --- |
| T1 | Gates fail closed | done, 2026-10-30 | The OK steps of the shared CI fail on a skip that `ALLOW_SKIP` does not name and on an empty `needs` (#85). conventions 0.5.0 adds `typed-files` and `tests-required` (#86). conventions 0.6.0 adds `roadmap-parses` (#87). |
| T2 | A site with no roadmap fails | done, 2026-10-30 | conventions 0.7.0 (#88): `roadmap-parses` fails on a call of `reusable-pages.yml` with no `roadmap`. Before, the rule skipped it, and the Status page of the site showed no item of the plan. |
| T3 | Each repository on the newest conventions | in progress | Each repository of the fleet takes the newest `@mark1russell7/conventions` and passes `check:conventions` on `main`. The strategist checks each one on `main`. |
| T4 | The runner budget as a rule | not started | A conventions rule examines the heavy workflows: `max-parallel` 3 or less, a concurrency group, and a scheduled minute that comes from the name of the repository and the workflow, so that no two repositories share it. One repository can examine this alone. Today each repository copies the weekly scan of `security.yml` at `23 5 * * 1`, so all scans start at the same minute. |
| T5 | The site of the template | not started | The template has a Pages workflow and a site, with the Releases page and the Status page, as each public repository has. |
| T6 | The required check CI OK on main | waiting on Mark | The ruleset of `main` needs the check CI OK. Mark starts `scripts/workflows/ruleset-ci-ok.ts --apply`, because a ruleset is a setting of the repository. |
| T7 | A docs commit moves no pin | done, 2026-10-30 | The release train moves the pins of a repository only when the surface of a pin changed (release-train #42). The surface is the file of a shared workflow, its `sparse-checkout` paths, or the folder of an action. Before, a docs commit of the template pushed a sync pull request to about 20 repositories. Their CI filled 39 of the 40 runners. |

# What our automated checks prove

| Check | Question | Trigger |
| --- | --- | --- |
| Build and core checks | Does the app build, and do foundational behaviors work? | Pull requests and pushes to dev |
| Critical user journeys | Can users start the app, set up a team, apply permissions, and recover a server switch? | Eligible Warden-cleared PRs, or manual critical selection |
| Full regression | Do all supported automatic journeys work together? | 06:00 and 18:00 UTC, or manual full selection |
| Full regression — component checks | Do broader Linux/macOS component, PR, and engine checks pass? | Nightly at 07:37 UTC |
| Test reliability | Are repeated PR-suite results consistent? | Nightly at 04:17 UTC |

GitHub Actions coordinates the checks. Daytona provides isolated environments
for most journeys; local jobs run on the isolated CI computer itself, not a
teammate's laptop. Both environments contribute to one Product journeys verdict.
The existing workflow filenames and build-check job IDs stay stable for API
consumers and branch rules; visible workflow names describe their purpose.

## Selection and coverage

`evals/scripts/journey-catalog.mjs` owns readable names, critical membership,
model requirements, and execution placement. New `evals/specs/*.e2e.test.ts`
files automatically enter full regression. Existing raw-desktop specs remain
manual-only unless explicitly supported in the catalog. Every plan lists those
coverage gaps; “full regression passed” means all selected automatic coverage,
not every possible scenario or every manual test.

The four critical specs cover startup, the two-person team lifecycle (including
real model/skill use), default/team permissions, and atomic enrollment recovery.
PR selection runs this whole set plus any additional changed journey files.
It no longer relies on the author changing a test file to exercise critical
behavior. Existing Warden authorization, same-repository restrictions, head-SHA
checks, protected review-machinery guards, and GitHub environment approvals remain.
Changes to the CI scripts themselves also require scheduled/manual validation.
A withheld plan does not silently receive a passing coverage report.

A manual run chooses `suite=full` or `suite=critical`, with an optional filename
substring `only`. An unmatched filter fails instead of reporting a green empty
run. Both the test checkout and remote product are pinned to the selected SHA.

The initial critical group is an explicit starting set, not a claim of a measured
PR latency budget. Inspect run durations before enlarging it. No branch rules
are changed by this PR: making the critical verdict a required merge gate needs
an intentional branch-rule update after observing this workflow in use.

## Read the result

The summary counts **spec files**, each of which may contain multiple tests.

- **Passed:** actual tests passed with no skips and the evidence judging step
  completed successfully.
- **Failed:** the runner recorded a failing test or evidence judgment failed.
  This still requires investigation: the product, test, or fixture can be at fault.
- **Not tested:** setup failed, tests skipped, the result is missing, or execution
  or evidence validation was incomplete. It never counts as passed.

The plan, small machine-readable results, final report, raw logs, and test
artifacts are attached to the run. A failure in one job doesn't cancel the rest.
Results describe the tested revision; a new commit requires new verification.

## Slack configuration

1. Create a Slack app with bot scope `chat:write`, install it in the workspace,
   and invite the bot to the team's test-alert channel.
2. In GitHub repository Settings → Secrets and variables → Actions, create secret
   `SLACK_BOT_TOKEN` with that bot token.
3. Create variable `SLACK_TEST_ALERT_CHANNEL_ID` with the channel's ID.
4. Optionally set `SLACK_TEST_ALERT_TEAM_ID` to the Slack user-group ID (for example,
   `S0123456`). New failures mention that group; recurring failures don't.

Use Slack's [chat.postMessage setup](https://docs.slack.dev/reference/methods/chat.postMessage/).
Keep tokens in Actions secrets, not repository files or PR comments.
No live Slack delivery is verified until these credentials are configured.

Only completed **scheduled** runs notify. Healthy runs are quiet. An incident
starts one channel message; following failures reply in its thread, with critical
journey status and a run link. New failures mention the configured team. One
recovery reply closes the incident; the next healthy run stays quiet.
Component and reliability runs each have their own incident thread because they
exercise different checks; they use job-level results rather than claiming
journey assertion counts. Their reports are linked from the same Slack channel.

The notifier retains incident state in Actions artifacts for up to 90 days,
refreshed on successful notifier runs. Older/out-of-order results don't overwrite
newer state. If state expires or is deleted, a subsequent failure starts a fresh
thread. Slack delivery and artifact persistence are separate operations: a crash
between them can duplicate a message on retry. This is not exactly-once delivery.
Missing credentials or a Slack error fail the notification job visibly; they do
not mark an alert delivered or generate fallback issue-comment spam.

The former automatic failure-issue comments and repeated assignee changes are
removed. Existing issues remain available; this workflow doesn't close them.
Vercel's deployment comments are independent: disable them in that project's Git
settings or remove Slack comment subscriptions if the channel still receives them.

## Verify this plumbing

Run `node --test evals/scripts/journey-ci.test.mjs` for selection, result handling,
threading, recovery, escaping, and failed-delivery checks. These are infrastructure
checks, not substitutes for the actual product journeys. Dispatch Product journeys
on the pushed branch with `suite=critical` to exercise all four existing specs and
inspect both the uploaded report and their real assertions. No Slack messages are
sent by manual validation runs.

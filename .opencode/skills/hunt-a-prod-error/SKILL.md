---
name: hunt-a-prod-error
description: A user saw internal_error, "Unexpected server error", a 500, or an opaque failure in a shipped OpenWork build. Find the cause from local logs and Sentry, name the regressing PR, file the issue, and reply where it was reported.
---

# Skill: Hunt a Prod Error

An opaque error has two halves. Local logs say **where** (route, status,
timing, burst shape). Sentry says **what** (the exception and stack). You need
both before naming a cause; either alone produces a guess.

## 1. Local logs: where and how often

Desktop server log (OTLP JSON, one record per request):

```
~/Library/Application Support/com.differentai.openwork/logs/openwork-server.log{,.1}
```

Engine log: `~/.local/share/opencode/log/opencode.log`.

Tally 5xx by route, then compare against the same route family that did
**not** fail. A failure rate on one route and zero on its siblings isolates the
code path; a burst of failures in the same millisecond points at a shared
event (GC, rollover, socket), not per-request data.

```bash
rg '"status":5' ~/Library/Application\ Support/com.differentai.openwork/logs/openwork-server.log* \
  | python3 -c 'import sys,json,re,collections; c=collections.Counter()
for l in sys.stdin:
  a=json.loads(l)["attributes"]; c[(a["method"], re.sub(r"(ses|ws|msg)_[A-Za-z0-9]+", r"\1_*", a["path"]), a.get("error.code"))]+=1
[print(v,k) for k,v in c.most_common()]'
```

Know the blind spot: the OpenCode proxy catch blocks in
`apps/server/src/server.ts` forward the real exception to Sentry only; the
local record carries the synthetic `Unexpected server error` and no cause.

## 2. Sentry: what threw

Sentry is connected through OpenWork Connect (`search_capabilities` →
`search_issues`, `get_sentry_resource`). Org `different-ai-inc`, project
`desktop-app`, region `https://us.sentry.io`.

Filter by the tags the server sets: `surface:server` and the templated
`route` (for example `route:"/workspace/:id/opencode/*"`), plus `release`.
Read the top issue's stack, `firstSeen`, users, and event count. The exact
exception message is the string a regression spec must reproduce.

## 3. Name the regression

Correlate Sentry `firstSeen` with `git log --since=<firstSeen - 2d>` on the
files in the stack. Confirm the shipped code matches source before reasoning
about it:

```bash
npx --yes @electron/asar extract-file /Applications/OpenWork.app/Contents/Resources/app.asar server/dist/server.js
```

## 4. Reproduce on the shipping runtime

Reduce the mechanism to a script and run it on the runtime the error occurred
in (`run-tests` → Match the runtime). A repro that passes on Bun for a
Node/undici bug has proven nothing.

## 5. File and reply

- Linear (team Engineering): symptom with the exact user-facing string,
  route tally, Sentry issue ids with users and counts, mechanism, repro,
  regressing PR, proposed fix. Link the Sentry issues as attachments.
- Reply in the thread where the error was reported with the issue link and a
  five-line summary: what fails, how often, who is affected, why, what fixes it.
- The fix PR carries a spec that reproduces the exact string on `dev` and
  passes on the head (`write-a-spec`). CI publishes the evidence.

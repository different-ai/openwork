---
name: daytona-recording-artifacts
description: screenshots, recording, presentation artifacts, validate visually. Supplementary Daytona screenshots and optional videos after testkit validation.
---

# Daytona Recording Artifacts

Use this skill to collect supplementary presentation artifacts for a Daytona UI
journey. Pass/fail evidence comes from an `@openwork/testkit` spec and its
ambient test evidence; use `daytona-flow-validator` and `run-tests` before declaring a
verdict. Custom screenshots or recordings never replace the test run.

Follow `prove-a-pr` for the repository-wide agent-first and human-verification contract.

## Default supplementary format: screenshot index

For presentation, use a browseable HTML page with named PNG screenshots for
each step. This is easy to review and works on any device, but is not the
verdict artifact.

Use video (MP4) only when the proof requires motion: streaming text, loading
spinners, animations, drag-and-drop, or real-time interactions that a static
frame cannot capture. When video is used, embed it inside the frame-by-frame
HTML page alongside the static frames.

First run the relevant `evals/specs/**/*.test.ts` through `run-tests`. The spec
imports `test` from `@openwork/testkit`; screenshots and validation claims are
recorded ambiently in its test evidence. Use `publish-evidence` for that existing test run,
then create the custom index here only if useful.

### How to produce the screenshot index

1. Serve a directory from the sandbox on port 8090:

```bash
daytona exec "$SANDBOX" -- 'bash -lc "mkdir -p /workspace/proof-frames; nohup python3 -m http.server 8090 --directory /workspace/proof-frames >/dev/null 2>&1 &"'
```

2. At each important state, capture a `browser_screenshot` locally and upload
   it to the sandbox with a numbered name like `01-auth-landing.png`,
   `02-org-filled.png`, etc.

3. Generate a browseable `index.html` with all frames as labeled images in a
   responsive grid. Include the branch, commit, and sandbox name.

4. Get the public URL:

```bash
FRAMES_URL=$(daytona preview-url "$SANDBOX" -p 8090 2>/dev/null | grep -v "^time=")
echo "${FRAMES_URL}/index.html"
```

5. Post the index URL in the PR body. Individual frame PNGs are also directly
   linkable: `${FRAMES_URL}/01-auth-landing.png`.

### Fallback when `/daytona-artifacts` is unavailable

The preferred path is `test-on-daytona.sh --artifacts-volume`, which mounts and
serves `/daytona-artifacts`. If that path is unavailable or not writable, do not
stop at local screenshots. Use `/workspace/proof-frames` as a fallback:

```bash
daytona exec "$SANDBOX" -- 'bash -lc "mkdir -p /workspace/proof-frames; nohup python3 -m http.server 8090 --bind 0.0.0.0 --directory /workspace/proof-frames >/tmp/proof-frames-http.log 2>&1 &"'
```

Upload the generated `index.html` and PNG frames there, then verify every file is
non-zero before sharing:

```bash
daytona exec "$SANDBOX" -- 'bash -lc "ls -lh /workspace/proof-frames && curl -s -I http://127.0.0.1:8090/index.html | sed -n \"1,8p\""'
daytona preview-url "$SANDBOX" -p 8090
```

If you use this fallback, say so in the PR/eval report because the files are not
on the persistent artifacts volume.

### When to include video clips

Embed short MP4 clips in the same proof directory when the step involves:

- Streaming text appearing in real-time (chat responses).
- Loading/progress indicators that resolve.
- Animations or transitions between states.
- Drag-and-drop or multi-step interactions.

Reference them from the HTML index alongside the static frames.

## Recording Standard (video, when needed)

A useful Daytona recording should look like a person using the product, even
though CDP is driving the browser or Electron window.

- Record the entire relevant journey, not only the final state.
- Start before the first visible click and stop after the final visible success state.
- Drive Chrome/Electron through visible controls with `browser_snapshot`, `browser_click`, and `browser_fill` wherever possible.
- Keep API calls, localStorage writes, direct navigation, and filesystem checks out of the recorded path unless they are unavoidable setup.
- If invisible setup is unavoidable, label it in the PR/eval and resume the recording at the next visible user step.
- Prefer slower, understandable click-by-click recordings over faster scripts that jump between states.
- The recording should be understandable without terminal output; logs and API checks are supporting evidence only.

## The Volume

The reusable Daytona volume is:

```text
openwork-eval-artifacts:/daytona-artifacts
```

The helper serves it on port `8090` when `--artifacts-volume` or
`--record-video` is used.

Expected layout:

```text
/daytona-artifacts/recordings
/daytona-artifacts/screenshots
/daytona-artifacts/validation
```

## Start With Artifacts

For screenshots and validation notes without video:

```bash
bash .devcontainer/test-on-daytona.sh [branch-or-commit] --artifacts-volume
```

For full human-review evidence:

```bash
bash .devcontainer/test-on-daytona.sh [branch-or-commit] --record-video --recording-name <name>
```

`--record-video` implies `--artifacts-volume`.

## Capture Screenshot Checkpoints

Capture a persistent screenshot from the Daytona display:

```bash
daytona exec "$SANDBOX" -- 'bash .devcontainer/capture-daytona-screenshot.sh'
```

Use this after important states: welcome screen, workspace created, settings
connected, task response visible, error state reproduced, or final success.

Before sharing any screenshot URL, follow `daytona-flow-validator` and inspect
the saved PNG itself. Confirm the visible image shows the claimed state and is
not covered by a native picker, modal, toast, desktop window, or unrelated
overlay. If the screenshot does not match, recapture and inspect a replacement.

## Stop Recording

Always stop with the helper so ffmpeg finalizes the MP4 cleanly:

```bash
daytona exec "$SANDBOX" -- 'bash .devcontainer/stop-daytona-recording.sh'
```

Do not use `kill -9`; it can corrupt the file.

After stopping, verify the recording exists and has duration:

```bash
daytona exec "$SANDBOX" -- 'ls -lh /daytona-artifacts/recordings'
daytona exec "$SANDBOX" -- 'ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 /daytona-artifacts/recordings/<name>.mp4'
```

If the duration is near zero, missing, or the file is absent, the recording is
not usable evidence.

## Get Artifact URLs

Get the artifacts base URL:

```bash
ARTIFACTS_URL=$(daytona preview-url "$SANDBOX" -p 8090 2>/dev/null | grep -v "^time=")
```

Then append paths:

```bash
echo "${ARTIFACTS_URL}/recordings/<name>.mp4"
echo "${ARTIFACTS_URL}/screenshots/<name>.png"
```

Artifact proxy URLs are not permanent. If the sandbox stops, the old
`daytonaproxy` URL will fail even when files still exist in
`/daytona-artifacts`. Restart the sandbox and artifact server, then generate a
fresh URL:

```bash
daytona sandbox start "$SANDBOX"
daytona exec "$SANDBOX" -- 'bash -lc '\''cd /daytona-artifacts && nohup python3 -m http.server 8090 --bind 0.0.0.0 > /tmp/daytona-artifacts-http.log 2>&1 &'\'''
daytona exec "$SANDBOX" -- 'curl -s -I http://127.0.0.1:8090/recordings/<name>.mp4 | sed -n "1,8p"'
daytona preview-url "$SANDBOX" -p 8090
```

Only share the refreshed URL after the local `curl -I` returns `200 OK` with a
non-zero `Content-Length`.

## Before And After Flow

Use before/after recordings for UI regressions or design changes:

```bash
bash .devcontainer/test-on-daytona.sh dev --record-video --recording-name my-feature-before
daytona exec "$SANDBOX" -- 'bash .devcontainer/stop-daytona-recording.sh'
daytona exec "$SANDBOX" -- "bash -lc 'cd /workspace && git fetch origin feat/my-branch:feat/my-branch && git checkout feat/my-branch'"
daytona exec "$SANDBOX" -- "bash -lc 'cd /workspace && DISPLAY=:99 .devcontainer/start-daytona-recording.sh --detach --output /daytona-artifacts/recordings/my-feature-after.mp4'"
daytona exec "$SANDBOX" -- 'bash .devcontainer/stop-daytona-recording.sh'
```

## Validation Standard

Use these layers in order of priority:

1. **Test evidence**: ambient validated screenshots and observable assertions
   are the verdict source.
2. **Custom screenshot index** (optional): named PNGs for presentation after
   the evidence-backed test is complete.
3. **Video clips** (optional): short MP4s for motion such as streaming,
   animations, or loading states.

Do not report success from a recording or custom screenshot alone. The testkit
test evidence must contain the assertions and validated screenshots for the claimed behavior.

Do not use a video as the primary demo if most of the flow happened through
hidden automation. In that case, mark the artifact as supplementary and rely on
the evidence-backed test for the verdict.

If you discover invalid evidence after the fact, do not reuse the same URL as
if it were valid. Produce new frames with new names and explain in the
PR/comment that the earlier artifact was superseded.

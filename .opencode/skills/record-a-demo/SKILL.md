---
name: record-a-demo
description: Screenshots, recordings, and presentation artifacts - attach a screenshot, image or video to a PR, issue or GitHub comment, or capture a Daytona UI journey (screenshot index, MP4 clips, before/after videos, artifact URLs). Use after the spec has passed, to show reviewers the flow.
---

# Record a Demo

Artifacts here are presentation only. The verdict comes from the spec (**Prove It on the Real Thing**, see `run-tests`). Build them only if they show something the spec's ambient evidence does not. Use the `.devcontainer` helpers, not hand-rolled setup (**Use the Maintained Lever**).

## Attach to a PR, issue, or comment

Needs `gh` 2.99 or newer (`gh --version`, `brew upgrade gh`). Alt text goes after `#`:

```sh
gh pr comment <n> --attach './shot.png#Alt text'          # also gh issue comment|create|edit, gh pr create|edit (max 50 files)
printf '![Alt text](./shot.png)\n' | gh pr comment <n> --body-file - --attach './shot.png#Alt text'   # inline in the body
```

GitHub rewrites the Markdown reference to the uploaded asset and appends unreferenced attachments. There is no "get a URL" command; read it back with `gh api repos/{owner}/{repo}/issues/comments/<id> --jq .body`.

## Start the sandbox with artifacts

```bash
bash .devcontainer/test-on-daytona.sh [branch-or-commit] --artifacts-volume
bash .devcontainer/test-on-daytona.sh [branch-or-commit] --record-video --recording-name <name>
```

`--record-video` implies `--artifacts-volume`. Both mount `openwork-eval-artifacts:/daytona-artifacts` and serve it on port `8090`, with `recordings/`, `screenshots/`, `validation/` inside.

## Screenshots (default format)

Capture a persistent screenshot from the Daytona display after each important state (welcome, workspace created, settings connected, response visible, error reproduced, final success):

```bash
daytona exec "$SANDBOX" -- 'bash .devcontainer/capture-daytona-screenshot.sh'
```

Open every PNG yourself before sharing. It must show the claimed state, not a native picker, modal, toast, desktop window, or other overlay. If not, recapture and inspect again.

Screenshot index: name frames by step (`01-auth-landing.png`, `02-org-filled.png`). Write an `index.html` with labeled frames in a responsive grid, plus branch, commit, and sandbox name. Post the index URL in the PR body. Single frames link directly: `${ARTIFACTS_URL}/01-auth-landing.png`.

Fallback when `/daytona-artifacts` is missing or not writable: do not stop at local screenshots. Upload `browser_screenshot` captures and the index to `/workspace/proof-frames`:

```bash
daytona exec "$SANDBOX" -- 'bash -lc "mkdir -p /workspace/proof-frames; nohup python3 -m http.server 8090 --bind 0.0.0.0 --directory /workspace/proof-frames >/tmp/proof-frames-http.log 2>&1 &"'
daytona exec "$SANDBOX" -- 'bash -lc "ls -lh /workspace/proof-frames && curl -s -I http://127.0.0.1:8090/index.html | sed -n \"1,8p\""'
```
Check every file is non-zero. Say in the PR or eval report that you used the fallback; it is not on the persistent volume.

## Video (only when motion matters)

Use MP4 only for streaming text, loading indicators that resolve, animations or transitions, and drag-and-drop or multi-step interactions. Embed clips in the HTML index beside the static frames.

Recording standard:
- Record the whole journey. Start before the first visible click; stop after the final visible success.
- Drive visible controls with `browser_snapshot`, `browser_click`, `browser_fill`.
- Keep API calls, localStorage writes, direct navigation, and filesystem checks off camera.
- Label unavoidable invisible setup in the PR and resume at the next visible step.
- Prefer slow click-by-click over scripts that jump between states.
- It must make sense without terminal output.
- If most of the flow ran through hidden automation, mark the video supplementary, not the primary demo.

Stop with the helper so ffmpeg finalizes the file. Never `kill -9`; it corrupts the MP4.

```bash
daytona exec "$SANDBOX" -- 'bash .devcontainer/stop-daytona-recording.sh'
daytona exec "$SANDBOX" -- 'ls -lh /daytona-artifacts/recordings'
daytona exec "$SANDBOX" -- 'ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 /daytona-artifacts/recordings/<name>.mp4'
```
Missing file or near-zero duration means the recording is unusable.

## Before and after

```bash
bash .devcontainer/test-on-daytona.sh dev --record-video --recording-name my-feature-before
daytona exec "$SANDBOX" -- 'bash .devcontainer/stop-daytona-recording.sh'
daytona exec "$SANDBOX" -- "bash -lc 'cd /workspace && git fetch origin feat/my-branch:feat/my-branch && git checkout feat/my-branch'"
daytona exec "$SANDBOX" -- "bash -lc 'cd /workspace && DISPLAY=:99 .devcontainer/start-daytona-recording.sh --detach --output /daytona-artifacts/recordings/my-feature-after.mp4'"
daytona exec "$SANDBOX" -- 'bash .devcontainer/stop-daytona-recording.sh'
```

## Share URLs

```bash
ARTIFACTS_URL=$(daytona preview-url "$SANDBOX" -p 8090 2>/dev/null | grep -v "^time=")
echo "${ARTIFACTS_URL}/recordings/<name>.mp4"
echo "${ARTIFACTS_URL}/screenshots/<name>.png"
```

Proxy URLs die when the sandbox stops, even if files remain. Refresh:

```bash
daytona sandbox start "$SANDBOX"
daytona exec "$SANDBOX" -- 'bash -lc '\''cd /daytona-artifacts && nohup python3 -m http.server 8090 --bind 0.0.0.0 > /tmp/daytona-artifacts-http.log 2>&1 &'\'''
daytona exec "$SANDBOX" -- 'curl -s -I http://127.0.0.1:8090/recordings/<name>.mp4 | sed -n "1,8p"'
daytona preview-url "$SANDBOX" -p 8090
```
Share only after `curl -I` returns `200 OK` with non-zero `Content-Length`.

Found bad evidence after sharing? Produce new files under new names and note the old one is superseded (**Honest Verdict**).

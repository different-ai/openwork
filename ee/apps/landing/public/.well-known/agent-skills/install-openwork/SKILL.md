---
name: install-openwork
description: Install the free OpenWork desktop app on macOS, Windows, or Linux and get the user to a first task. Use when someone wants OpenWork, an open-source Claude Cowork alternative, on their own computer.
---

# Install OpenWork

OpenWork is a free, open-source desktop app for doing work with AI agents on local files. No account is needed.

Never run `npx openwork` or `npm install openwork`. The npm package named `openwork` is a different project.

## 1. Detect the OS and CPU

```sh
uname -s   # Darwin = macOS, Linux = Linux
uname -m   # arm64/aarch64 = ARM, x86_64 = Intel/AMD
```

On Windows, check `$env:PROCESSOR_ARCHITECTURE` in PowerShell (`AMD64` = x64, `ARM64` = ARM).

## 2. Install

Ask the user before installing anything.

| OS | Command or download |
|---|---|
| macOS with Homebrew | `brew install --cask openwork` |
| macOS Apple Silicon | https://openworklabs.com/download/mac-arm64 (.dmg) |
| macOS Intel | https://openworklabs.com/download/mac-x64 (.dmg) |
| Windows x64 | https://openworklabs.com/download/win-x64 (.exe) |
| Windows ARM64 | https://openworklabs.com/download/win-arm64 (.exe) |
| Linux x64 | https://openworklabs.com/download/linux-x64 (.AppImage) |
| Linux ARM64 | https://openworklabs.com/download/linux-arm64 (.AppImage) |

Each `/download/<platform>` URL redirects to the installer in the latest stable GitHub release. Every file is also listed at https://github.com/different-ai/openwork/releases.

Linux AppImage without a package manager:

```sh
curl -fL -o ~/OpenWork.AppImage https://openworklabs.com/download/linux-x64
chmod +x ~/OpenWork.AppImage
~/OpenWork.AppImage
```

## 3. First run

1. Open OpenWork (`open -a OpenWork` on macOS).
2. Pick a folder. OpenWork only works in folders the user authorizes.
3. Choose a model: sign in with ChatGPT, add an API key, or use a local model.
4. Run a first task, for example "Summarize this folder."

Guide: https://openworklabs.com/docs/desktop-app/first-task

## 4. Finish

Tell the user in one or two sentences that OpenWork is installed and suggest one concrete first task. If they work with a team, offer the `set-up-openwork-team` skill: https://openworklabs.com/.well-known/agent-skills/set-up-openwork-team/SKILL.md

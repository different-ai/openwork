# Sandbox tools

Feature `sandboxTools` (cloud and self-hosted, off by default). Author: `benjaminshafii`.

**Status: the flag and the local microVM adapter exist; the tools are not wired into the app yet.** Turning the flag
on changes nothing today. [design.md](design.md) is the plan, the reasons and the evidence behind it.

## What changes

With the feature on and a sandbox chosen for the workspace, the agent gets extra tools next to its usual ones:

| Tool | For |
| --- | --- |
| `sandbox_bash` | run a command inside the sandbox |
| `sandbox_job` | check on, or stop, a command started in the background |
| `sandbox_read`, `sandbox_write` | read and write files inside the sandbox |
| `sandbox_preview` | get a link to a web app running inside the sandbox |
| `sandbox_status` | what the sandbox is, which folders it can see and what it can reach on the network |

The agent's usual shell and file tools keep working on this computer. The sandbox is an extra, isolated place to run
things: it sees only the folders it was given, and it has no network unless hosts are listed for it.

Three sandboxes can back the tools:

- **This computer** (`microsandbox`): a local microVM. Apple Silicon Macs and Linux with KVM. No account or key.
- **Freestyle**: a cloud VM.
- **Daytona**: a cloud sandbox. A container by default; a Linux VM where the organization configured that class.

When the sandbox cannot start or cannot be reached, the tool says why and whether the command started. Nothing runs
on this computer in its place, and no other sandbox is tried.

## Who gets it

People on the OpenCode v2 engine whose organization has `sandboxTools` on, or, signed out, whose deployment has it
on for everyone. Which sandbox is used comes from the organization's setting, narrowed by the person's choice for the
workspace (design.md, "Provider choice and credentials").

## Turning it on and off

Turn `sandboxTools` on for an organization in `/admin` (Features, or the organization's row). Off, or with the kill
switch used, the tools are no longer offered from the next message on and are refused within a minute. A command
already running finishes inside the sandbox. Sandboxes are stopped and keep their files until the workspace is removed
or the person resets the sandbox; nothing is moved to this computer.

What to watch: `sandbox_unavailable` tool results by reason (runtime missing, no hypervisor access, image pull,
credentials, settings could not be verified), sandbox start time, and local microVMs left running.

Code: `packages/sandbox-microsandbox` (adapter, `pnpm --filter @openwork/sandbox-microsandbox test`, and
`MICROSANDBOX_LIVE=1 pnpm --filter @openwork/sandbox-microsandbox test:live` for real microVMs),
`packages/sandbox` (the contract every sandbox implements).

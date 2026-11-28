# Computers

`computers` is off by default on cloud and self-hosted deployments. Owner: `benjaminshafii`.

Den lists personal computers, registered cloud computers, and Workbot computers. A desktop chat can use its file and shell tools on the owner's own registered cloud computer after the owner allows access to the entire computer. Personal computers can't take work from another computer yet.

## Two doors, one core

Both use `packages/computers`. In a desktop prompt, name your registered cloud computer. The agent calls `runs_on` to send that chat's file and shell tools there. In Workbot, `computers:list` shows computers and whether they can take work from the chat. `computers:shell` can check a queued command's result, but no shipping desktop can pick up commands, and Workbot can't send commands to a registered cloud computer.

## Three checks

The narrowest permission wins:

1. **Organization:** The existing "tasks from other devices" setting must allow it.
2. **Computer:** The owner opts in. For a registered VM, use its edit dialog under **Settings > Devices**.
3. **Source:** For a registered VM, only the owner's signed-in OpenWork apps can use the whole-computer grant. It has one working folder, which is a starting point, not an access limit. Old folder grants never count as whole-computer consent.

A refusal says which check stopped it and who can change it, if anyone.

## Shared folders on personal computers

A runner advertising `computer_shell_v1` must run each assignment inside its sandbox and mount only the host folders in the assignment's `scope.folders`. Den checks an explicit working directory or file path to refuse requests early. It can't tell which files a command will use, so this check isn't a security boundary. No shipping desktop reports these access choices or runs these assignments yet.

## Native routing today

Den decides on each routed `shell`, `read`, `write`, `edit`, `glob`, and `grep` call (`POST /v1/computers/:id/authorize`). Before contacting the member's own registered Daytona computer, the local OpenWork server requires an explicit whole-computer authorization. Agents can run commands and access files outside the working folder, within the permissions granted by the provider. It uses `DAYTONA_API_KEY` from its environment and starts the computer if stopped. Den stores no provider credentials. Bound chats refuse local-only tools. Remote MCP tools are unaffected, and no connector secrets are copied to the computer. Failed calls never fall back locally.

OpenCode 2.2.6 has a per-session file and process seam only in its embedded host, not the `opencode2 serve` sidecar OpenWork runs. OpenWork uses its own sandbox seam: the plugin re-registers tools and the sandbox tool host runs them. That host supplies tool output, background commands cannot run remotely, and attachments and the file browser stay local.

Cloud computers show **Ready**, **Starts when needed**, or **Has a problem**, never **Offline**. Personal machines keep **Online** and **Offline**. Names are unique per person; rename reports taken names. If two computers match, the agent asks which one.

## Command retention in Den

For queued commands, Den keeps the command text, assignment details and status, and the result, including up to 32,000 bytes of output. The result is available for 15 minutes after completion, or the command can be followed for 15 minutes after its deadline if it hasn't completed. Every 15 minutes, Den deletes up to 100 rows past that window across all organizations. A new command also triggers cleanup for its organization, a runner listing its queue triggers cleanup for that computer, and a caller checking a command triggers cleanup for their own commands in that organization. Each request deletes up to 100 eligible rows. A runner that picked up a command can report a late result while its row still exists. Commands sent directly to a registered cloud computer by a desktop chat don't use this queue.

## What is not built yet

- A composer picker. Name the computer instead.
- Running desktop chat tools on cloud computers from providers other than Daytona.
- A desktop runner that reports folder access and picks up work from another computer. Den tests the queue with a simulated runner.
- MCP read, write, or search on another computer.
- Combining sign-ins across reinstalls into one row per physical machine, or combining Workbot conversations into one row per person.
- Remote background commands.

## Try it

Enable the flag for a test organization in `/admin`. Set `DAYTONA_API_KEY` for the local server and register your Daytona computer. In its edit dialog, turn on **Allow my OpenWork apps to access this entire computer**, set the **Working folder**, and select **Save access**. Ask "List `/workspace` on my Build box" using your working folder and computer name. To revoke access, turn the switch off and select **Save access**. **Save name** never changes access.

## Turning it off

Member routes return 404. Within about half a minute, `runs_on` and routing disappear on the next prompt, and bound chats run locally again. Stored choices stay. Keep the flag off if rolling Den and the desktop server back to versions that predate whole-computer consent.

Watch for authorize refusals and provider errors in the local server log.

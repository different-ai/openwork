# Computers

`computers` is off by default on cloud and self-hosted deployments. Owner: `benjaminshafii`.

The MCP gateway adds two capabilities: `computers:list` and `computers:shell`. Workbot can list a member's own computers and those shared with them. A computer is any place that can run work: Workbot's cloud computer, a registered virtual computer, or a member's own machine. Workbot can reach a member's machine only through its sandbox, with access limited to the folders its owner shared. Remote sessions are unchanged.

Work from another computer must pass all three checks. The narrowest permission wins:

1. **Organization:** The existing "tasks from other devices" setting applies. Off refuses all requests to run work from another computer.
2. **Computer:** Its owner must allow work from other computers on that machine. It stays off until the owner opts in.
3. **Source:** The computer sending work can use only the folders the receiving computer's owner shared with that source. Nothing is shared by default.

A refusal says which check stopped the request and who can change it.

## What is not built yet

OpenWork Desktop does not yet let owners allow commands or share folders, does not report that it can accept these commands, and does not run them. Until it does, `computers:shell` says the computer needs a newer OpenWork and queues nothing. The Den side is complete: it stores choices and shares, checks permissions, queues commands for a computer to claim, and lets the caller check results by ID. `ee/apps/den-api/test/api/computers.api.test.ts` covers this with a simulated computer.

## How to try it

Turn it on for a test organization in `/admin`, then ask Workbot to list computers in a chat.

## Turning it off

The two capabilities disappear and the computer-facing routes return 404. Choices, shares, and queued commands stay in the database. Queued commands expire on their own. Nothing else changes.

Watch for 409 responses on `/v1/computer-commands/*` and commands that expire unclaimed.

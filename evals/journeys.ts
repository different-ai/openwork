// The only committed e2e tests: one file per journey in evals/core.
// If one of these breaks, customers notice the same day. Adding a tenth is a
// review decision, not something a PR does to prove itself; prove a change
// with a one-off evals/proofs/<name>.proof.test.ts instead.
export const journeys = {
  "org-invite-join": "An owner invites someone to the organization and they join with the right role.",
  "core-chat": "A signed-in person sends a message and reads the reply.",
  "thread-continues-after-restart": "A conversation, its queued follow-up and its draft survive restarting the app.",
  "agent-connection-journey": "A person asks for something from a connected service and sees what was called and what came back.",
  "agent-permissions": "A member's agent asks before commands, runs the allowed ones, and cannot run blocked ones.",
  "app-smoke": "The packaged desktop app installs and opens to a working screen.",
  "packaged-update-install": "An installed desktop app downloads a newer build and installs it on quit.",
  "agent-signup-via-mcp": "An MCP client connects to OpenWork, searches capabilities and runs one.",
  "secure-keys-in-chat": "Keys entered in chat stay private: not in the transcript, the model, logs, or another member's calls.",
} satisfies Record<string, string>;

export type JourneyName = keyof typeof journeys;

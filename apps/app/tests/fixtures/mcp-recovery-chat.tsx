/** @jsxImportSource react */
// Synthetic conversation using the production chat/tool layout, not a status gallery.
import type { UIMessage } from "ai";
import type { OpenworkServerClient } from "../../src/app/lib/openwork-server";
import { MessageList } from "../../src/components/chat/message-list";
import { MessageListProvider } from "../../src/components/chat/message-list-provider";
import { PlatformProvider, createDefaultPlatform } from "../../src/react-app/kernel/platform";

const platform = createDefaultPlatform();
export const recoveryMessages: UIMessage[] = [
  { id: "fixture-user", role: "user", parts: [{ type: "text", text: "Find the release blockers in our project tracker and show a summary." }] },
  { id: "fixture-answer", role: "assistant", parts: [
    { type: "dynamic-tool", toolCallId: "fixture-search", toolName: "tracker_search_issues", state: "output-available",
      input: { query: "release blockers" }, output: "2 release blockers: sign-in checks and export validation.",
      callProviderMetadata: { openwork: { mcpResult: { content: [{ type: "text", text: "2 release blockers: sign-in checks and export validation." }] } } } },
    { type: "text", text: "I found two release blockers in the project tracker:\n\n- **Sign-in checks** — verify that signed-out members can reconnect.\n- **Export validation** — confirm the exported report includes every selected row.\n\nBoth need verification before the release." },
  ] },
];

export const connectionMessages: UIMessage[] = [
  { id: "fixture-user", role: "user", parts: [{ type: "text", text: "Connect Notes so I can summarize the release checklist." }] },
  { id: "fixture-connection", role: "assistant", parts: [
    { type: "dynamic-tool", toolCallId: "fixture-status", toolName: "openwork-cloud_execute_capability", state: "output-available",
      input: { name: "mcp:emc_notes:check_Notes_connection" },
      output: { schemaVersion: "1", connectionId: "emc_notes", connectionName: "Notes", state: "needs_connection",
        actor: "member", message: "Connect Notes to continue.",
        action: { type: "connect", label: "Connect Notes", surface: "openwork_your_connections" } } },
    { type: "text", text: "The release checklist has not been read yet." },
  ] },
];

export function RecoveryChatFixture({ client, messages = recoveryMessages }: { client: OpenworkServerClient; messages?: UIMessage[] }) {
  return <PlatformProvider value={platform}>
    <MessageListProvider client={client} workspaceId="fixture-workspace" sessionId="fixture-session"
      showThinking={false} developerMode={false} displaySuggestions={false} providerConnectedCount={1}
      dispatchAction={() => {}} setPrompt={() => {}} onRevertToUserMessage={() => {}} onForkAtMessage={() => {}}
      onEditUserMessage={() => {}} onMcpReconnect={async () => { throw new Error("No connection action in this fixture"); }}
      onMcpReopenAuthorization={async () => {}} onMcpRetry={() => { throw new Error("Must not rerun the task"); }}>
      <MessageList messages={messages} status="ready" activityStatus="idle" />
    </MessageListProvider>
  </PlatformProvider>;
}

import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { organizationModelBeforeFirstWorkspace } from "../worlds/providers-before-workspace.ts";

const test = spec.world(organizationModelBeforeFirstWorkspace, {
  timeout: 600_000,
  resources: {
    surfaces: ["desktop"],
    services: ["den", "mock"],
    nativeReason: "The Electron runtime owns the local server and its managed engine; only the desktop creates the 'OpenWork Chat' workspace from the first message and runs the organization provider sync in that engine.",
  },
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function listField(value: unknown, field: string): unknown[] {
  return isRecord(value) && Array.isArray(value[field]) ? value[field] : [];
}

function listOf(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  return listField(value, "items");
}

type Conversation = { workspacePath: string; sessionIds: string[]; userTurns: number; replies: number; errors: string[] };

async function readConversation(desktopApi: (path: string) => Promise<{ status: number; body: unknown }>, reply: string): Promise<Conversation> {
  const empty: Conversation = { workspacePath: "", sessionIds: [], userTurns: 0, replies: 0, errors: [] };
  const workspace = listField((await desktopApi("/workspaces")).body, "items").find(isRecord);
  if (!workspace || typeof workspace.id !== "string") return empty;
  const workspacePath = typeof workspace.path === "string" ? workspace.path : "";
  const base = `/workspace/${workspace.id}/opencode`;
  const directory = workspacePath ? `?directory=${encodeURIComponent(workspacePath)}` : "";
  const sessionIds = listOf((await desktopApi(`${base}/session${directory}`)).body)
    .flatMap((session) => (isRecord(session) && typeof session.id === "string" ? [session.id] : []));
  let userTurns = 0;
  let replies = 0;
  const errors: string[] = [];
  for (const sessionId of sessionIds) {
    for (const message of listOf((await desktopApi(`${base}/session/${sessionId}/message${directory}`)).body)) {
      const info = isRecord(message) && isRecord(message.info) ? message.info : null;
      if (info?.role === "user") userTurns += 1;
      if (info?.role !== "assistant") continue;
      if (isRecord(info.error)) errors.push(JSON.stringify(info.error).slice(0, 300));
      const text = listField(message, "parts").map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : "")).join("");
      if (text.includes(reply)) replies += 1;
    }
  }
  return { workspacePath, sessionIds, userTurns, replies, errors };
}

const cases = [
  { label: "right away", waitMs: 0, when: "the member types \"hello\" and presses Enter as soon as the composer appears" },
  { label: "after 10 seconds", waitMs: 10_000, when: "the member waits 10 seconds, then types \"hello\" and presses Enter" },
] as const;

for (const sendCase of cases) {
  test(`a member with only an organization model gets an answer to the first message they send before any workspace exists (${sendCase.label})`, async ({ world, user, probe, step, evidence }) => {
    await step("before: the member is signed in to the organization, has no workspace, and the composer is ready", async () => {
      await user.see("composer", { editable: true, timeoutMs: 180_000 });
      const workspaces = await probe.desktopApi("/workspaces");
      const count = listField(workspaces.body, "items").length;
      evidence.recordAssertionEvidence(
        "The member has no workspace when the composer appears",
        `GET /workspaces → HTTP ${workspaces.status}, ${count} workspaces`,
        workspaces.status === 200 && count === 0,
      );
      expect(workspaces.status).toBe(200);
      expect(count).toBe(0);
      await user.screenshot();
    });

    await step(sendCase.when, async () => {
      const started = Date.now();
      if (sendCase.waitMs > 0) await new Promise((resolve) => setTimeout(resolve, sendCase.waitMs));
      await user.type("composer", "hello");
      await user.press("Enter");
      const elapsed = Date.now() - started;
      evidence.recordAssertionEvidence(
        "The first message was sent from the composer, with no workspace chosen",
        `"hello" + Enter ${elapsed} ms after the composer appeared (target ${sendCase.waitMs === 0 ? "≤ 1000" : `≥ ${sendCase.waitMs}`} ms)`,
        sendCase.waitMs === 0 ? elapsed <= 1_500 : elapsed >= sendCase.waitMs,
      );
    });

    const answered = await step("after: the organization model answers that first message", async () => {
      const conversation = await probe.eventually(async () => {
        const state = await readConversation((path) => probe.desktopApi(path), world.reply);
        const shown = await probe.text();
        const visibleError = /ProviderModelNotFoundError|Model not found: \S+/.exec(shown)?.[0];
        return visibleError ? { ...state, errors: [...state.errors, `shown: ${visibleError}`] } : state;
      }, {
        within: 90_000,
        label: "the first message is answered by the organization model",
        until: (state) => state.replies > 0 || state.errors.length > 0,
      }).catch(async (error: unknown) => {
        await user.screenshot();
        throw error;
      });
      if (conversation.errors.length === 0) await user.see({ text: world.reply }, { timeoutMs: 30_000 });
      evidence.recordAssertionEvidence(
        "The first message is answered by the organization model",
        `workspace ${conversation.workspacePath || "missing"}; ${conversation.sessionIds.length} conversation(s); ${conversation.replies} answer(s) containing ${world.reply}; engine errors: ${conversation.errors.join(" | ") || "none"}`,
        conversation.replies > 0 && conversation.errors.length === 0,
      );
      await user.screenshot();
      expect(conversation.errors).toEqual([]);
      expect(conversation.replies).toBeGreaterThan(0);
      return conversation;
    });

    await step("after: no model-not-found error or unconfirmed send is shown, and the message was sent once", async () => {
      await user.notSee({ text: /ProviderModelNotFoundError|Model not found/ });
      await user.notSee({ testId: "admission-outcome-unknown" });
      evidence.recordAssertionEvidence(
        "The first send succeeded without a resend",
        `${answered.sessionIds.length} conversation(s), ${answered.userTurns} user message(s), no "Model not found" text and no "Couldn’t confirm whether this finished" card`,
        answered.sessionIds.length === 1 && answered.userTurns === 1,
      );
      expect(answered.sessionIds).toHaveLength(1);
      expect(answered.userTurns).toBe(1);
    });
  });
}

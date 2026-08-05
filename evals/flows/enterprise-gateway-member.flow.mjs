/**
 * Enterprise incident gateway demo — member machine.
 *
 * Required env:
 * - MICX_EVAL_DEN_API_URL: Den API base URL for the enterprise sandbox.
 * - MICX_EVAL_DEN_WEB_URL: Den web origin used by the desktop handoff deep link.
 *
 * Optional env:
 * - MICX_EVAL_CDP_URL or --cdp-url: CDP endpoint for the member desktop app.
 *   This should be the SECOND app instance when run after the admin flow.
 * - MICX_EVAL_ENTERPRISE_MEMBER_EMAIL: member email (default member@example.com).
 * - MICX_EVAL_ENTERPRISE_MEMBER_WORKSPACE: workspace folder (default /workspace/enterprise-member).
 * - MICX_EVAL_ENTERPRISE_GATEWAY_URL: gateway base URL used only if the transcript asks for JIT login without a full link.
 * - MICX_EVAL_ENTERPRISE_MEMBER_GATEWAY_USER: gateway login user override (default member email).
 * - MICX_EVAL_ENTERPRISE_PASSWORD: account password override (default TutorialDemo123!).
 * - MICX_EVAL_ENTERPRISE_TASK_TIMEOUT_MS: chat turn timeout in milliseconds.
 *
 * Runner note: evals/runner/run.mjs has one selected CDP endpoint per process.
 * Run this flow separately from the admin flow and point MICX_EVAL_CDP_URL
 * (or --cdp-url) at the member app instance.
 */

import {
  assertEvidence,
  clickThroughLingeringOnboarding,
  desktopHandoffSignIn,
  ensureLocalWorkspace,
  ensureLocalWorkspaceBeforeConnectPollIfNeeded,
  envText,
  readTranscriptSnapshot,
  retryAfterGatewayLoginIfNeeded,
  sendPromptAndWait,
  timeoutMs,
  waitForMicxConnectReady,
  workspaceFolder,
} from "./enterprise-gateway-common.mjs";

const DEFAULT_MEMBER_EMAIL = "member@example.com";
const WORKSPACE_ENV = "MICX_EVAL_ENTERPRISE_MEMBER_WORKSPACE";
const DEFAULT_WORKSPACE = "/workspace/enterprise-member";
const PROMPT = "How many incidents do I have?";
const PROMPT_RETRY = "I completed the enterprise incident gateway sign-in. Retry my question using the my-incidents skill.";

const state = {
  workspaceId: "",
  latestTranscript: "",
  finalAnswer: "",
};

export default {
  id: "enterprise-gateway-member",
  title: "Enterprise gateway demo: member receives and uses the my-incidents skill",
  kind: "user-facing",
  requiredEnv: ["MICX_EVAL_DEN_API_URL", "MICX_EVAL_DEN_WEB_URL"],
  steps: [
    {
      name: "Desktop handoff signs in member to the organization",
      run: async (ctx) => {
        await desktopHandoffSignIn(ctx, memberEmail(ctx));
      },
    },
    {
      name: "Create member's fresh workspace with Micx Connect ready",
      run: async (ctx) => {
        await clickThroughLingeringOnboarding(ctx);
        const folder = workspaceFolder(ctx, WORKSPACE_ENV, DEFAULT_WORKSPACE);
        state.workspaceId = await ensureLocalWorkspaceBeforeConnectPollIfNeeded(ctx, folder);
        await waitForMicxConnectReady(ctx);
        if (!state.workspaceId) state.workspaceId = await ensureLocalWorkspace(ctx, folder);
      },
    },
    {
      name: "Member asks for incidents and the shared skill scopes the answer",
      run: async (ctx) => {
        await ctx.prove("Member's agent discovers my-incidents from cloud capabilities and answers with the member's own incident", {
          action: async () => {
            const timeout = timeoutMs(ctx, "MICX_EVAL_ENTERPRISE_MEMBER_TIMEOUT_MS", 300_000);
            const first = await sendPromptAndWait(ctx, PROMPT, { timeout });
            state.latestTranscript = await retryAfterGatewayLoginIfNeeded(
              ctx,
              memberEmail(ctx),
              first,
              "INC0012338",
              PROMPT_RETRY,
              { timeout, gatewayUserEnvName: "MICX_EVAL_ENTERPRISE_MEMBER_GATEWAY_USER" },
            );
            const snapshot = await readTranscriptSnapshot(ctx);
            state.finalAnswer = snapshot.latestAssistantText || "";
          },
          assert: async () => {
            assertEvidence(ctx, state.latestTranscript.includes("my-incidents"), "Transcript shows the my-incidents skill was discovered or used", state.latestTranscript);
            assertEvidence(ctx, state.latestTranscript.includes("INC0012338"), "Transcript includes the member's own incident INC0012338", state.latestTranscript);
            assertEvidence(ctx, state.finalAnswer.trim().length > 0, "Final assistant answer is present", state.finalAnswer);
            assertEvidence(ctx, !state.finalAnswer.includes("INC0012341"), "Final answer does not include the admin incident INC0012341", state.finalAnswer);
          },
          screenshot: {
            name: "member-my-incidents-answer",
            claim: "Member's chat uses the cloud-delivered my-incidents skill and answers with the member's own incident, not the admin's.",
            requireText: ["INC0012338"],
            rejectText: ["INC0012341", "Something went wrong"],
          },
        });
      },
    },
  ],
};

function memberEmail(ctx) {
  return envText(ctx, "MICX_EVAL_ENTERPRISE_MEMBER_EMAIL") || DEFAULT_MEMBER_EMAIL;
}

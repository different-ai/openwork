/**
 * Blue Yonder / Agent Blue demo — Rashmi's machine.
 *
 * Required env:
 * - OPENWORK_EVAL_DEN_API_URL: Den API base URL for the Blue Yonder sandbox.
 * - OPENWORK_EVAL_DEN_WEB_URL: Den web origin used by the desktop handoff deep link.
 *
 * Optional env:
 * - OPENWORK_EVAL_CDP_URL or --cdp-url: CDP endpoint for Rashmi's desktop app.
 *   This should be the SECOND app instance when run after Jahnavi's flow.
 * - OPENWORK_EVAL_BLUE_YONDER_RASHMI_WORKSPACE: workspace folder (default /workspace/rashmi-workspace).
 * - OPENWORK_EVAL_BLUE_YONDER_GATEWAY_URL: gateway base URL used only if the transcript asks for JIT login without a full link.
 * - OPENWORK_EVAL_BLUE_YONDER_RASHMI_GATEWAY_USER: gateway login user override (default rashmi@blueyonder.dev).
 * - OPENWORK_EVAL_BLUE_YONDER_PASSWORD: account password override (default TutorialDemo123!).
 * - OPENWORK_EVAL_BLUE_YONDER_TASK_TIMEOUT_MS: chat turn timeout in milliseconds.
 *
 * Runner note: evals/runner/run.mjs has one selected CDP endpoint per process.
 * Run this flow separately from Jahnavi's and point OPENWORK_EVAL_CDP_URL (or
 * --cdp-url) at Rashmi's app instance.
 */

import {
  assertEvidence,
  desktopHandoffSignIn,
  ensureLocalWorkspace,
  readTranscriptSnapshot,
  retryAfterGatewayLoginIfNeeded,
  sendPromptAndWait,
  timeoutMs,
  waitForOpenWorkConnectReady,
  workspaceFolder,
} from "./blue-yonder-gateway-common.mjs";

const RASHMI_EMAIL = "rashmi@blueyonder.dev";
const WORKSPACE_ENV = "OPENWORK_EVAL_BLUE_YONDER_RASHMI_WORKSPACE";
const DEFAULT_WORKSPACE = "/workspace/rashmi-workspace";
const PROMPT = "How many incidents do I have?";
const PROMPT_RETRY = "I completed the Blue Yonder Gateway sign-in. Retry my question using the my-incidents skill.";

const state = {
  workspaceId: "",
  latestTranscript: "",
  finalAnswer: "",
};

export default {
  id: "blue-yonder-gateway-rashmi",
  title: "Blue Yonder gateway demo: Rashmi receives and uses the my-incidents skill",
  kind: "user-facing",
  requiredEnv: ["OPENWORK_EVAL_DEN_API_URL", "OPENWORK_EVAL_DEN_WEB_URL"],
  steps: [
    {
      name: "Desktop handoff signs in Rashmi to Blue Yonder",
      run: async (ctx) => {
        await desktopHandoffSignIn(ctx, RASHMI_EMAIL);
      },
    },
    {
      name: "Create Rashmi's fresh workspace with OpenWork Connect ready",
      run: async (ctx) => {
        await waitForOpenWorkConnectReady(ctx);
        const folder = workspaceFolder(ctx, WORKSPACE_ENV, DEFAULT_WORKSPACE);
        state.workspaceId = await ensureLocalWorkspace(ctx, folder);
      },
    },
    {
      name: "Rashmi asks for her incidents and the shared skill scopes the answer to her",
      run: async (ctx) => {
        await ctx.prove("Rashmi's agent discovers my-incidents from cloud capabilities and answers with her own incident", {
          action: async () => {
            const timeout = timeoutMs(ctx, "OPENWORK_EVAL_BLUE_YONDER_RASHMI_TIMEOUT_MS", 300_000);
            const first = await sendPromptAndWait(ctx, PROMPT, { timeout });
            state.latestTranscript = await retryAfterGatewayLoginIfNeeded(
              ctx,
              RASHMI_EMAIL,
              first,
              "INC0012338",
              PROMPT_RETRY,
              { timeout, gatewayUserEnvName: "OPENWORK_EVAL_BLUE_YONDER_RASHMI_GATEWAY_USER" },
            );
            const snapshot = await readTranscriptSnapshot(ctx);
            state.finalAnswer = snapshot.latestAssistantText || "";
          },
          assert: async () => {
            assertEvidence(ctx, state.latestTranscript.includes("my-incidents"), "Transcript shows the my-incidents skill was discovered or used", state.latestTranscript);
            assertEvidence(ctx, state.latestTranscript.includes("INC0012338"), "Transcript includes Rashmi's own incident INC0012338", state.latestTranscript);
            assertEvidence(ctx, state.finalAnswer.trim().length > 0, "Final assistant answer is present", state.finalAnswer);
            assertEvidence(ctx, !state.finalAnswer.includes("INC0012341"), "Final answer does not include Jahnavi's INC0012341", state.finalAnswer);
          },
          screenshot: {
            name: "rashmi-my-incidents-answer",
            claim: "Rashmi's chat uses the cloud-delivered my-incidents skill and answers with her own incident, not Jahnavi's.",
            requireText: ["INC0012338"],
            rejectText: ["INC0012341", "Something went wrong"],
          },
        });
      },
    },
  ],
};

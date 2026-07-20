/**
 * Blue Yonder / Agent Blue demo — Jahnavi's machine.
 *
 * Required env:
 * - OPENWORK_EVAL_DEN_API_URL: Den API base URL for the Blue Yonder sandbox.
 *
 * Optional env:
 * - OPENWORK_EVAL_DEN_WEB_URL: Den web origin used as the handoff Origin.
 * - OPENWORK_EVAL_CDP_URL or --cdp-url: CDP endpoint for Jahnavi's desktop app.
 * - OPENWORK_EVAL_BLUE_YONDER_JAHNAVI_WORKSPACE: workspace folder (default /workspace/janvi-workspace).
 * - OPENWORK_EVAL_BLUE_YONDER_GATEWAY_URL: gateway base URL used only if the transcript asks for JIT login without a full link.
 * - OPENWORK_EVAL_BLUE_YONDER_JAHNAVI_GATEWAY_USER: gateway login user override (default janvi@blueyonder.dev).
 * - OPENWORK_EVAL_BLUE_YONDER_PASSWORD: account password override (default TutorialDemo123!).
 * - OPENWORK_EVAL_BLUE_YONDER_TASK_TIMEOUT_MS: chat turn timeout in milliseconds.
 * - OPENWORK_EVAL_BLUE_YONDER_SHARE_TIMEOUT_MS: marketplace/share chat timeout in milliseconds.
 *
 * Runner note: evals/runner/run.mjs currently chooses one CDP endpoint for a run.
 * To run Rashmi on a second desktop, run her flow in a separate command with
 * OPENWORK_EVAL_CDP_URL (or --cdp-url) pointed at that second app instance.
 */

import {
  assertEvidence,
  desktopHandoffSignIn,
  ensureLocalWorkspace,
  ensureOpenWorkCloudControlReady,
  listSkillsFor,
  retryAfterGatewayLoginIfNeeded,
  sendPromptAndWait,
  signInByEmail,
  timeoutMs,
  workspaceFolder,
} from "./blue-yonder-gateway-common.mjs";

const JAHNAVI_EMAIL = "janvi@blueyonder.dev";
const RASHMI_EMAIL = "rashmi@blueyonder.dev";
const WORKSPACE_ENV = "OPENWORK_EVAL_BLUE_YONDER_JAHNAVI_WORKSPACE";
const DEFAULT_WORKSPACE = "/workspace/janvi-workspace";

const PROMPT_INCIDENTS = "Use OpenWork Connect capabilities to find the Blue Yonder incident gateway. Search for the right capability, then ask the gateway for my open incidents assigned to me using its enterprise graph query capability. Do not use lookup_incident_records. I need the incident numbers, priorities, and short descriptions.";
const PROMPT_INCIDENTS_RETRY = "I completed the Blue Yonder Gateway sign-in. Retry the same enterprise graph query for my open incidents assigned to me, still without using lookup_incident_records.";
const PROMPT_CREATE_SKILL = "Create a skill from what we just learned and save it to our org: whenever I ask about my incidents, always use enterprise_graph_query scoped to assigned_to=me (never lookup_incident_records), default to open status, and present a table with number, priority, and short description. Name it my-incidents.";
const PROMPT_SHARE_SKILL = "Add the my-incidents skill to our Blue Yonder marketplace and assign it to Rashmi so she gets it too.";

const state = {
  workspaceId: "",
  latestTranscript: "",
};

export default {
  id: "blue-yonder-gateway-jahnavi",
  title: "Blue Yonder gateway demo: Jahnavi creates and shares the my-incidents skill",
  kind: "user-facing",
  requiredEnv: ["OPENWORK_EVAL_DEN_API_URL"],
  steps: [
    {
      name: "Desktop handoff signs in Jahnavi to Blue Yonder",
      run: async (ctx) => {
        await desktopHandoffSignIn(ctx, JAHNAVI_EMAIL);
      },
    },
    {
      name: "Create Jahnavi's fresh workspace and attach OpenWork Cloud Control",
      run: async (ctx) => {
        const folder = workspaceFolder(ctx, WORKSPACE_ENV, DEFAULT_WORKSPACE);
        state.workspaceId = await ensureLocalWorkspace(ctx, folder, "blue-yonder-jahnavi");
        await ensureOpenWorkCloudControlReady(ctx, state.workspaceId);
      },
    },
    {
      name: "Prompt 1: Jahnavi asks the gateway for her open incidents with JIT auth",
      run: async (ctx) => {
        await ctx.prove("Jahnavi's agent uses the Blue Yonder gateway and resolves the JIT sign-in path", {
          action: async () => {
            const timeout = timeoutMs(ctx, "OPENWORK_EVAL_BLUE_YONDER_INCIDENT_TIMEOUT_MS", 300_000);
            const first = await sendPromptAndWait(ctx, PROMPT_INCIDENTS, { timeout });
            state.latestTranscript = await retryAfterGatewayLoginIfNeeded(
              ctx,
              JAHNAVI_EMAIL,
              first,
              "INC0012341",
              PROMPT_INCIDENTS_RETRY,
              { timeout, gatewayUserEnvName: "OPENWORK_EVAL_BLUE_YONDER_JAHNAVI_GATEWAY_USER" },
            );
          },
          assert: async () => {
            const text = state.latestTranscript;
            assertEvidence(ctx, text.includes("enterprise_graph_query"), "Transcript shows the enterprise_graph_query capability/tool name", text);
            assertEvidence(ctx, text.includes("Authorization required") || /\blogin\b/i.test(text), "Transcript shows JIT authorization required or a login link", text);
            assertEvidence(ctx, text.includes("INC0012341"), "Transcript includes Jahnavi's incident INC0012341", text);
          },
          screenshot: {
            name: "jahnavi-gateway-incidents",
            claim: "Jahnavi's chat shows the gateway-backed incident result after the JIT auth path.",
            requireText: ["INC0012341"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Prompt 2: Jahnavi saves the my-incidents skill to the org",
      run: async (ctx) => {
        await ctx.prove("Jahnavi turns the learned gateway pattern into an org skill", {
          action: async () => {
            state.latestTranscript = await sendPromptAndWait(ctx, PROMPT_CREATE_SKILL, {
              timeout: timeoutMs(ctx, "OPENWORK_EVAL_BLUE_YONDER_SKILL_TIMEOUT_MS", 300_000),
            });
          },
          assert: async () => {
            assertEvidence(ctx, /skl_|created.*skill|saved.*org/i.test(state.latestTranscript), "Transcript confirms a cloud skill was created or saved to the org", state.latestTranscript);
          },
          screenshot: {
            name: "jahnavi-created-my-incidents-skill",
            claim: "The chat confirms my-incidents was saved as an organization skill.",
            requireText: ["my-incidents"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Prompt 3: Jahnavi shares my-incidents to Rashmi through the marketplace",
      run: async (ctx) => {
        await ctx.prove("Jahnavi assigns the org skill to Rashmi through the Blue Yonder marketplace", {
          action: async () => {
            state.latestTranscript = await sendPromptAndWait(ctx, PROMPT_SHARE_SKILL, {
              timeout: timeoutMs(ctx, "OPENWORK_EVAL_BLUE_YONDER_SHARE_TIMEOUT_MS", 420_000),
            });
          },
          assert: async () => {
            assertEvidence(ctx, /granted|access/i.test(state.latestTranscript), "Transcript confirms Rashmi was granted access", state.latestTranscript);
            assertEvidence(ctx, /marketplace|hub/i.test(state.latestTranscript), "Transcript mentions marketplace or hub sharing", state.latestTranscript);
          },
          screenshot: {
            name: "jahnavi-shared-my-incidents",
            claim: "The chat confirms my-incidents was shared through the marketplace/hub to Rashmi.",
            requireText: ["my-incidents"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Server-side assert: Rashmi can list my-incidents",
      run: async (ctx) => {
        const rashmiToken = await signInByEmail(ctx, RASHMI_EMAIL);
        const skills = await listSkillsFor(ctx, rashmiToken);
        const found = skills.some((skill) => String(skill.title ?? "").trim().toLowerCase() === "my-incidents");
        assertEvidence(ctx, found, "GET /v1/skills as Rashmi includes a skill titled my-incidents", skills.map((skill) => ({ id: skill.id, title: skill.title })));
      },
    },
  ],
};

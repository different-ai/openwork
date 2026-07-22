/**
 * Enterprise incident gateway demo — Admin machine.
 *
 * Required env:
 * - OPENWORK_EVAL_DEN_API_URL: Den API base URL for the enterprise sandbox.
 * - OPENWORK_EVAL_DEN_WEB_URL: Den web origin used by the desktop handoff deep link.
 *
 * Optional env:
 * - OPENWORK_EVAL_CDP_URL or --cdp-url: CDP endpoint for the admin desktop app.
 * - OPENWORK_EVAL_ENTERPRISE_ADMIN_EMAIL: admin email (default admin@example.com).
 * - OPENWORK_EVAL_ENTERPRISE_MEMBER_EMAIL: member email used to verify sharing (default member@example.com).
 * - OPENWORK_EVAL_ENTERPRISE_ADMIN_WORKSPACE: workspace folder (default /workspace/enterprise-admin).
 * - OPENWORK_EVAL_ENTERPRISE_GATEWAY_URL: gateway base URL used only if the transcript asks for JIT login without a full link.
 * - OPENWORK_EVAL_ENTERPRISE_ADMIN_GATEWAY_USER: gateway login user override (default admin email).
 * - OPENWORK_EVAL_ENTERPRISE_PASSWORD: account password override (default TutorialDemo123!).
 * - OPENWORK_EVAL_ENTERPRISE_TASK_TIMEOUT_MS: chat turn timeout in milliseconds.
 * - OPENWORK_EVAL_ENTERPRISE_SHARE_TIMEOUT_MS: marketplace/share chat timeout in milliseconds.
 *
 * Runner note: evals/runner/run.mjs currently chooses one CDP endpoint for a run.
 * To run the member flow on a second desktop, run it in a separate command with
 * OPENWORK_EVAL_CDP_URL (or --cdp-url) pointed at that second app instance.
 */

import {
  assertEvidence,
  clickThroughLingeringOnboarding,
  desktopHandoffSignIn,
  ensureLocalWorkspace,
  ensureLocalWorkspaceBeforeConnectPollIfNeeded,
  envText,
  listSkillsFor,
  retryAfterGatewayLoginIfNeeded,
  sendPromptAndWait,
  signInByEmail,
  timeoutMs,
  waitForOpenWorkConnectReady,
  workspaceFolder,
} from "./enterprise-gateway-common.mjs";

const DEFAULT_ADMIN_EMAIL = "admin@example.com";
const DEFAULT_MEMBER_EMAIL = "member@example.com";
const WORKSPACE_ENV = "OPENWORK_EVAL_ENTERPRISE_ADMIN_WORKSPACE";
const DEFAULT_WORKSPACE = "/workspace/enterprise-admin";

const PROMPT_INCIDENTS = "Use OpenWork Connect capabilities to find the enterprise incident gateway. Search for the right capability, then ask the gateway for my open incidents assigned to me using its enterprise graph query capability. Do not use lookup_incident_records. I need the incident numbers, priorities, and short descriptions.";
const PROMPT_INCIDENTS_RETRY = "I completed the enterprise incident gateway sign-in. Retry the same enterprise graph query for my open incidents assigned to me, still without using lookup_incident_records.";
const PROMPT_CREATE_SKILL = "Create a skill from what we just learned and save it to our org: whenever I ask about my incidents, always use enterprise_graph_query scoped to assigned_to=me (never lookup_incident_records), default to open status, and present a table with number, priority, and short description. Name it my-incidents.";

const state = {
  workspaceId: "",
  latestTranscript: "",
};

export default {
  id: "enterprise-gateway-admin",
  title: "Enterprise gateway demo: Admin creates and shares the my-incidents skill",
  kind: "user-facing",
  requiredEnv: ["OPENWORK_EVAL_DEN_API_URL", "OPENWORK_EVAL_DEN_WEB_URL"],
  steps: [
    {
      name: "Desktop handoff signs in Admin to the organization",
      run: async (ctx) => {
        await desktopHandoffSignIn(ctx, adminEmail(ctx));
      },
    },
    {
      name: "Create Admin's fresh workspace with OpenWork Connect ready",
      run: async (ctx) => {
        await clickThroughLingeringOnboarding(ctx);
        const folder = workspaceFolder(ctx, WORKSPACE_ENV, DEFAULT_WORKSPACE);
        state.workspaceId = await ensureLocalWorkspaceBeforeConnectPollIfNeeded(ctx, folder);
        await waitForOpenWorkConnectReady(ctx);
        if (!state.workspaceId) state.workspaceId = await ensureLocalWorkspace(ctx, folder);
      },
    },
    {
      name: "Prompt 1: Admin asks the gateway for open incidents with JIT auth",
      run: async (ctx) => {
        await ctx.prove("Admin's agent uses the enterprise incident gateway and resolves the JIT sign-in path", {
          action: async () => {
            const timeout = timeoutMs(ctx, "OPENWORK_EVAL_ENTERPRISE_INCIDENT_TIMEOUT_MS", 300_000);
            const first = await sendPromptAndWait(ctx, PROMPT_INCIDENTS, { timeout });
            state.latestTranscript = await retryAfterGatewayLoginIfNeeded(
              ctx,
              adminEmail(ctx),
              first,
              "INC0012341",
              PROMPT_INCIDENTS_RETRY,
              { timeout, gatewayUserEnvName: "OPENWORK_EVAL_ENTERPRISE_ADMIN_GATEWAY_USER" },
            );
          },
          assert: async () => {
            const text = state.latestTranscript;
            assertEvidence(ctx, text.includes("enterprise_graph_query"), "Transcript shows the enterprise_graph_query capability/tool name", text);
            assertEvidence(ctx, text.includes("Authorization required") || /\blogin\b/i.test(text), "Transcript shows JIT authorization required or a login link", text);
            assertEvidence(ctx, text.includes("INC0012341"), "Transcript includes Admin's incident INC0012341", text);
          },
          screenshot: {
            name: "admin-gateway-incidents",
            claim: "Admin's chat shows the gateway-backed incident result after the JIT auth path.",
            requireText: ["INC0012341"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Prompt 2: Admin saves the my-incidents skill to the org",
      run: async (ctx) => {
        await ctx.prove("Admin turns the learned gateway pattern into an org skill", {
          action: async () => {
            state.latestTranscript = await sendPromptAndWait(ctx, PROMPT_CREATE_SKILL, {
              timeout: timeoutMs(ctx, "OPENWORK_EVAL_ENTERPRISE_SKILL_TIMEOUT_MS", 300_000),
            });
          },
          assert: async () => {
            assertEvidence(ctx, /skl_|created.*skill|saved.*org/i.test(state.latestTranscript), "Transcript confirms a cloud skill was created or saved to the org", state.latestTranscript);
          },
          screenshot: {
            name: "admin-created-my-incidents-skill",
            claim: "The chat confirms my-incidents was saved as an organization skill.",
            requireText: ["my-incidents"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Prompt 3: Admin shares my-incidents to the member through the marketplace",
      run: async (ctx) => {
        await ctx.prove("Admin assigns the org skill to the member through the organization marketplace", {
          action: async () => {
            state.latestTranscript = await sendPromptAndWait(ctx, shareSkillPrompt(ctx), {
              timeout: timeoutMs(ctx, "OPENWORK_EVAL_ENTERPRISE_SHARE_TIMEOUT_MS", 420_000),
            });
          },
          assert: async () => {
            assertEvidence(ctx, /granted|access/i.test(state.latestTranscript), "Transcript confirms the member was granted access", state.latestTranscript);
            assertEvidence(ctx, /marketplace|hub/i.test(state.latestTranscript), "Transcript mentions marketplace or hub sharing", state.latestTranscript);
          },
          screenshot: {
            name: "admin-shared-my-incidents",
            claim: "The chat confirms my-incidents was shared through the marketplace/hub to the member.",
            requireText: ["my-incidents"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Server-side assert: member can list my-incidents",
      run: async (ctx) => {
        const memberToken = await signInByEmail(ctx, memberEmail(ctx));
        const skills = await listSkillsFor(ctx, memberToken);
        const found = skills.some((skill) => String(skill.title ?? "").trim().toLowerCase() === "my-incidents");
        assertEvidence(ctx, found, "GET /v1/skills as member includes a skill titled my-incidents", skills.map((skill) => ({ id: skill.id, title: skill.title })));
      },
    },
  ],
};

function adminEmail(ctx) {
  return envText(ctx, "OPENWORK_EVAL_ENTERPRISE_ADMIN_EMAIL") || DEFAULT_ADMIN_EMAIL;
}

function memberEmail(ctx) {
  return envText(ctx, "OPENWORK_EVAL_ENTERPRISE_MEMBER_EMAIL") || DEFAULT_MEMBER_EMAIL;
}

function shareSkillPrompt(ctx) {
  return `Add the my-incidents skill to our organization marketplace and assign it to ${memberEmail(ctx)} so the member gets it too.`;
}

import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { claimableWorkspace } from "../worlds/claimable-workspace.ts";

const test = spec.world(claimableWorkspace, {
  timeout: 600_000,
  needs: { commands: ["bun", "pnpm"], placement: "local" },
  resources: { surfaces: ["web"], services: ["den"] },
});

test("an agent builds a workspace before anyone signs up, and a person claims it with a code", async ({ world, user, step, evidence }) => {
  const person = user.on(world.web);
  const workspace = await world.provision();
  let accessToken = "";

  await step("given an agent with no account that provisions a workspace and trades its assertion for a token", async () => {
    const granted = await world.exchange(workspace.assertion);
    accessToken = granted.accessToken;
    const search = await world.callTool(accessToken, "search_capabilities", { query: "skills" });
    const ok = granted.status === 200 && granted.scope === "mcp:read mcp:write" && search.status === 200;
    evidence.recordAssertionEvidence(
      "The agent reaches the MCP gateway with only the pre-claim token",
      `bootstrap 200 with claim links=${workspace.hasClaimLinks}; JWT-bearer exchange → ${granted.status} scope "${granted.scope}"; search_capabilities → HTTP ${search.status}`,
      ok,
    );
    expect(ok).toBe(true);
  });

  await step("when the agent creates a skill in that workspace before anyone signed up", async () => {
    const created = await world.callTool(accessToken, "create_skill", {
      pluginName: "Weekly report",
      skillMarkdown: "---\nname: weekly-report\ndescription: Summarize the week's work for the team.\n---\n\n# Weekly report\n\nSummarize this week's work in five bullet points.\n",
    });
    const text = JSON.stringify(created.json);
    evidence.recordAssertionEvidence("The skill is created with pre-claim access", `create_skill → HTTP ${created.status}; ${text.slice(0, 160)}`, created.status === 200 && text.includes("weekly-report"));
    expect(created.status).toBe(200);
    expect(text).toContain("weekly-report");
  });

  const code = await world.requestClaimCode(workspace.bootstrapId, workspace.assertion);

  await step("before: the person opens the claim link and has no account yet", async () => {
    const state = await world.claimState(workspace.bootstrapId, workspace.assertion);
    expect(state.state).toBe("pending");
    await person.navigate(code.verificationUrl);
    await person.see({ text: "Claim the workspace your agent set up" }, { timeoutMs: 90_000 });
    await person.see({ testId: "claim-user-code", text: code.userCode });
    evidence.recordAssertionEvidence("The claim page shows the agent's code", `code ${code.userCode}; agent poll → ${state.state}`, true);
    await person.screenshot();
  });

  await step("the person creates an account and keeps the workspace as a new organization", async () => {
    await person.type({ role: "textbox", label: /^email$/i }, world.person.email);
    await person.type({ role: "textbox", label: /^password$/i }, world.person.password);
    // The mode tab and the submit button are both named "Create account"; the second is the submit.
    await person.click({ role: "button", label: "Create account", nth: 1 });
    await person.see({ text: `Claim ${world.workspaceName}?` }, { timeoutMs: 60_000 });
    await person.see({ testId: "claim-consent-line" });
    await person.screenshot();
    await person.click({ role: "button", label: "Claim workspace" });
    await person.see({ text: `${world.workspaceName} is yours` }, { timeoutMs: 30_000 });
    await person.screenshot();
  });

  await step("after: the agent's poll reaches reconciled and its old token and assertion stop working", async () => {
    const state = await world.claimState(workspace.bootstrapId, workspace.assertion);
    const oldToken = await world.callTool(accessToken, "search_capabilities", { query: "skills" });
    const reexchange = await world.exchange(workspace.assertion);
    const revoked = state.reconciled && oldToken.status === 401 && reexchange.status === 400 && reexchange.error === "invalid_grant";
    evidence.recordAssertionEvidence(
      "Claiming ends the agent's temporary access",
      `poll → ${state.state}; old MCP token → HTTP ${oldToken.status}; assertion exchange → ${reexchange.status} ${reexchange.error}`,
      revoked,
    );
    expect(state).toMatchObject({ state: "reconciled", reconciled: true });
    expect(oldToken.status).toBe(401);
    expect(reexchange.error).toBe("invalid_grant");
  });
});

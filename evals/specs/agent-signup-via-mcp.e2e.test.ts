import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { agentMcpSignup } from "../worlds/agent-mcp-signup.ts";

const test = spec.world(agentMcpSignup, {
  timeout: 600_000,
  needs: { commands: ["bun", "pnpm"], placement: "local" },
  resources: { surfaces: ["web"], services: ["den", "mock"] },
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function matchNames(json: unknown): string[] {
  const matches = isRecord(json) && Array.isArray(json.matches) ? json.matches : [];
  return matches.flatMap((match) => isRecord(match) && typeof match.name === "string" ? [match.name] : []);
}

test("a brand-new person signs up through their agent, names a workspace inline, and the agent finishes setup", async ({ world, user, probe, step, evidence }) => {
  const person = user.on(world.web);
  const browser = probe.on(world.web);
  let organizationId = "";
  let signInLink = "";
  let installPageUrl = "";

  await step("before: the agent's sign-in link opens OpenWork for someone with no account and names the app asking", async () => {
    await person.navigate(world.authorizeUrl);
    await person.see({ role: "textbox", label: /email/i }, { timeoutMs: 90_000 });
    await person.see({ text: "Signing in for" });
    await person.see({ text: "Connect Claude Code." });
    await person.see({ role: "button", label: "Continue with Google" });
    await person.notSee({ text: /MCP/ });
    await person.screenshot();
  });

  await step("they sign up with email and confirm the emailed code", async () => {
    await person.type({ role: "textbox", label: /email/i }, world.person.email);
    await person.click({ role: "button", text: /^next$/i });
    await person.type({ role: "textbox", label: "Name" }, world.person.name);
    await person.type({ role: "textbox", label: "Password" }, world.person.password, { sensitive: true });
    await person.click({ role: "button", label: "Sign up" });
    await person.see({ role: "textbox", label: "Verification code" }, { timeoutMs: 30_000 });
    const code = await browser.eventually(() => world.otp(), { within: 15_000, label: "emailed verification code", until: (value) => /^\d{6}$/.test(value) });
    await person.type({ role: "textbox", label: "Verification code" }, code);
    await person.click({ role: "button", label: "Verify email" });
    await person.see({ role: "textbox", label: "Workspace name" }, { timeoutMs: 60_000 });
    await person.notSee({ text: /run the MCP authorization again/i });
    expect(world.exchanges()).toHaveLength(0);
    await person.screenshot();
  });

  await step("after: they name their workspace on the same page and authorize without restarting", async () => {
    await person.type({ role: "textbox", label: "Workspace name" }, world.workspaceName);
    await person.see({ text: "Claude Code can" });
    await person.see({ text: "Find and read what is in this workspace" });
    await person.notSee({ text: /MCP authorization|Requested access/ });
    await person.screenshot();
    await person.click({ role: "button", label: "Create workspace and authorize" });
    await person.see({ text: "Your agent is connected to OpenWork" }, { timeoutMs: 60_000 });
    const [exchange] = world.exchanges();
    expect(world.exchanges()).toHaveLength(1);
    expect(exchange.status).toBe(200);
    expect(exchange.accessToken.split(".")).toHaveLength(3);
    expect(exchange.organizationId).toMatch(/^org_/);
    organizationId = exchange.organizationId;
    evidence.recordAssertionEvidence(
      "The agent's original authorization finished after sign-up and workspace creation",
      `One consent click returned one code to the agent's callback; PKCE exchange → HTTP ${exchange.status}, scopes "${exchange.scope}", token bound to the new workspace ${organizationId}.`,
      exchange.status === 200,
    );
  });

  await step("the agent searches capabilities with its new token", async () => {
    await person.see({ text: "Your agent is connected to OpenWork" });
    const found = await world.callTool("search_capabilities", { query: "register MCP server connection", limit: 20 });
    const names = matchNames(found.json);
    expect(names).toContain("postMcpConnections");
    evidence.recordAssertionEvidence("search_capabilities answers for the new workspace", `matches include ${names.slice(0, 6).join(", ")}`, names.includes("postMcpConnections"));
  });

  await step("the agent adds a no-sign-in MCP server and hands the person a browser link for it", async () => {
    const created = await world.callTool("execute_capability", {
      name: "postMcpConnections",
      body: { name: "Team tools", url: world.toolsMcpUrl, authType: "none", credentialMode: "shared", access: { orgWide: true } },
    });
    const body = created.json;
    const links = isRecord(body) && isRecord(body.links) ? body.links : {};
    signInLink = typeof links.signIn === "string" ? links.signIn : "";
    expect(isRecord(body) ? body.name : null).toBe("Team tools");
    expect(typeof links.yourConnections).toBe("string");
    expect(new URL(signInLink).pathname).toBe("/connect/mcp");
    expect(new URL(signInLink).searchParams.get("org")).toBe(organizationId);
    await person.navigate(signInLink);
    await person.see({ text: "Connect Team tools" }, { timeoutMs: 30_000 });
    await person.see({ role: "button", label: "Sign in to Team tools" });
    await person.see({ text: world.workspaceName });
    await person.screenshot();
    evidence.recordAssertionEvidence("postMcpConnections returns a sign-in link a terminal agent can hand over", signInLink.replace(/org_[a-z0-9]+/i, "org_…"), true);
  });

  await step("the agent gets an install page and a desktop connect link for the workspace in one call", async () => {
    const found = await world.callTool("search_capabilities", { query: "download desktop app install OpenWork", limit: 20 });
    const installLinks = matchNames(found.json).find((name) => /InstallLinks$/i.test(name));
    expect(installLinks, `matches: ${matchNames(found.json).join(", ")}`).toBeTruthy();
    const minted = await world.callTool("execute_capability", { name: installLinks, path: { organizationId }, body: {} });
    const body = isRecord(minted.json) ? minted.json : {};
    installPageUrl = typeof body.installPageUrl === "string" ? body.installPageUrl : "";
    const connectUrl = typeof body.connectUrl === "string" ? body.connectUrl : "";
    expect(new URL(installPageUrl).pathname).toBe("/install");
    expect(connectUrl).toMatch(/^openwork:\/\/connect\?/);
    await person.navigate(installPageUrl);
    await person.see({ text: "Download OpenWork" }, { timeoutMs: 60_000 });
    await person.screenshot();
    evidence.recordAssertionEvidence("postOrgsInstallLinks returns installPageUrl + connectUrl", `installPageUrl ${new URL(installPageUrl).pathname}…; connectUrl ${connectUrl.slice(0, 26)}…`, true);
  });

  await step("a connection link that was removed says so plainly, and a broken link asks for a new one", async () => {
    const removed = new URL(signInLink);
    const realId = removed.searchParams.get("connectionId") ?? "";
    // Same shape as a real id, but no connection has it (as if it was removed).
    removed.searchParams.set("connectionId", `${realId.slice(0, -1)}${realId.endsWith("0") ? "1" : "0"}`);
    await person.navigate(removed.toString());
    await person.see({ role: "button", label: "Sign in to Team tools" }, { timeoutMs: 30_000 });
    await person.click({ role: "button", label: "Sign in to Team tools" });
    await person.see({ text: "Team tools can’t be connected" }, { timeoutMs: 30_000 });
    await person.see({ text: "This connection was removed or is not shared with you. Ask your agent for a new link." });
    await person.screenshot();
    await person.navigate(`${world.den.ref.webUrl}/connect/mcp?name=Team%20tools`);
    await person.see({ text: "This sign-in link is incomplete" }, { timeoutMs: 30_000 });
    await person.screenshot();
  });

  await step("an expired sign-in link tells the person to restart from their agent instead of failing silently", async () => {
    const expired = new URL(world.authorizeUrl);
    const query = new URLSearchParams(expired.search);
    query.set("exp", "1");
    query.set("sig", "stale");
    await person.navigate(`${world.den.ref.webUrl}/mcp/select-organization?${query}`);
    await person.see({ text: "This sign-in link expired" }, { timeoutMs: 30_000 });
    await person.see({ text: "Start sign-in again from your agent." });
    await person.see({ text: "Nothing was authorized." });
    await person.notSee({ role: "button", label: "Create workspace and authorize" });
    await person.notSee({ role: "button", label: /^Authorize/ });
    expect(world.exchanges()).toHaveLength(1);
    await person.screenshot();
  });
});

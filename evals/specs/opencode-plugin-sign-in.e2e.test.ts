import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { opencodePluginSignIn } from "../worlds/opencode-plugin-sign-in.ts";

const test = spec.world(opencodePluginSignIn, {
  timeout: 900_000,
  needs: { commands: ["bun", "pnpm", "node", "tar"], placement: "local" },
  resources: { surfaces: ["web"], services: ["den"] },
});

test("a person signs OpenCode in to OpenWork from the browser and lands back on OpenCode", async ({ world, user, step, evidence }) => {
  const person = user.on(world.web);

  await step("before: with the plugin sign-in switched off, OpenCode still signs in as the OpenWork CLI", async () => {
    await world.setPluginSignIn(false);
    const login = await world.startLogin();
    await person.navigate(login.verificationUrl);
    await person.see({ text: "Sign in OpenWork CLI?" }, { timeoutMs: 90_000 });
    await person.see({ testId: "device-user-code", text: login.userCode });
    await person.screenshot();
    await person.click({ role: "button", label: "Deny" });
    await person.see({ text: /Sign-in denied/ });
    const result = await login.finished;
    const refused = result.status !== 0;
    evidence.recordAssertionEvidence(
      "Den falls back to the CLI client and a denied code gives OpenCode nothing",
      `page: "Sign in OpenWork CLI?"; opencode auth login exit ${result.status}`,
      refused,
    );
    expect(refused).toBe(true);
  });

  const login = await (async () => {
    await world.setPluginSignIn(true);
    return world.startLogin();
  })();

  await step("the browser names OpenCode and shows the code from the terminal", async () => {
    const url = new URL(login.verificationUrl);
    expect(url.pathname).toBe("/device");
    expect(url.searchParams.get("return_to")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/openwork\/callback$/);
    await person.navigate(login.verificationUrl);
    await person.see({ text: "Sign in OpenWork - OpenCode Plugin?" }, { timeoutMs: 90_000 });
    await person.see({ testId: "device-user-code", text: login.userCode });
    await person.see({ text: "$ opencode auth login openwork" });
    await person.see({ text: world.den.admin.email });
    evidence.recordAssertionEvidence(
      "The page names the OpenCode plugin and the code matches the terminal",
      `terminal: ${login.userCode}; page: /device on Den web as ${world.den.admin.email}; return page on a loopback port`,
      true,
    );
    await person.screenshot();
  });

  await step("after: approving sends the browser back to OpenCode, which is now signed in", async () => {
    await person.click({ role: "button", label: "Sign in OpenWork - OpenCode Plugin" });
    await person.see({ text: "OpenCode is connected to OpenWork" }, { timeoutMs: 30_000 });
    await person.see({ text: "You can close this tab and go back to OpenCode." });
    await person.screenshot();
    const result = await login.finished;
    expect(result.status, result.stdout).toBe(0);
    expect(result.stdout).toContain("Connected to OpenWork Cloud");
    const accounts = await world.run(["auth", "list"]);
    const listed = accounts.stdout.includes(world.den.admin.email);
    evidence.recordAssertionEvidence(
      "OpenCode stores the OpenWork account the person approved",
      `opencode auth login exit 0 ("Connected to OpenWork Cloud"); opencode auth list shows ${world.den.admin.email}: ${listed}`,
      listed,
    );
    expect(listed).toBe(true);
  });

  await step("after: OpenCode loads OpenWork's MCP gateway with that sign-in", async () => {
    let servers = "";
    for (let attempt = 0; attempt < 30; attempt++) {
      servers = (await world.run(["mcp", "list"])).stdout;
      if (/openwork-cloud[\s\S]*connected/i.test(servers)) break;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    const connected = /openwork-cloud[\s\S]*connected/i.test(servers);
    evidence.recordAssertionEvidence(
      "The openwork-cloud MCP server connects through Den's MCP gateway",
      servers.split("\n").filter((line) => line.includes("openwork")).join(" | ") || servers.slice(0, 300),
      connected,
    );
    expect(connected).toBe(true);
  });

  await step("a return address that is not on this machine is ignored", async () => {
    const tampered = await world.startLogin();
    const url = new URL(tampered.verificationUrl);
    url.searchParams.set("return_to", "https://example.com/openwork/callback");
    await person.navigate(url.toString());
    await person.see({ testId: "device-user-code", text: tampered.userCode }, { timeoutMs: 60_000 });
    await person.click({ role: "button", label: "Sign in OpenWork - OpenCode Plugin" });
    await person.see({ text: "OpenWork - OpenCode Plugin is signed in" }, { timeoutMs: 30_000 });
    await person.see({ text: "Return to OpenCode." });
    await person.screenshot();
    const result = await tampered.finished;
    evidence.recordAssertionEvidence(
      "Den keeps the person on its own page instead of following an outside address",
      `return_to=https://example.com/… → stayed on Den ("Return to OpenCode."); opencode auth login exit ${result.status}`,
      result.status === 0,
    );
    expect(result.status).toBe(0);
  });
});

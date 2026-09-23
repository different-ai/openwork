import { expect } from "vitest";
import { spec, type Probe } from "@openwork/testkit";
import { denMcpByAddress } from "../worlds/den-mcp-by-address.ts";

// A member adds a vendor's MCP server by its address. Den checks the address
// for real, and each check ticks off on the page before anyone relies on it.
const test = spec.world(denMcpByAddress, {
  timeout: 600_000,
  needs: { placement: "local" },
  resources: { surfaces: ["web"], services: ["den", "mock"] },
});

type Row = "find" | "sign-in-method" | "sign-in" | "tools";
const rows: Row[] = ["find", "sign-in-method", "sign-in", "tools"];

/** Each row's state on the page, read from the checklist the person sees. */
async function checklist(probe: Probe): Promise<Record<Row, string>> {
  const states = ["waiting", "running", "current", "done", "failed"];
  const found: Record<Row, string> = { find: "missing", "sign-in-method": "missing", "sign-in": "missing", tools: "missing" };
  for (const row of rows) {
    for (const state of states) {
      if ((await probe.dom(`[data-testid="setup-check-${row}"][data-status="${state}"]`)).elements.length === 1) found[row] = state;
    }
  }
  return found;
}

const summary = (found: Record<Row, string>) => rows.map((row) => `${row} ${found[row]}`).join(", ");

test("a member: I want to add our vendor's MCP by its address so I know it works before my AI uses it", async ({ world, user, probe, step, evidence }) => {
  const catalog = `${world.den.ref.webUrl}/dashboard/library/connectors/new`;

  const settle = async (expected: Partial<Record<Row, string>>) => {
    const found = await probe.eventually(() => checklist(probe), {
      within: 90_000,
      label: "the checklist",
      until: (current) => rows.every((row) => expected[row] === undefined || current[row] === expected[row]),
    });
    evidence.recordAssertionEvidence("checks on the page", summary(found), true);
  };

  await step("1. Acme Desk is not in the list, so I paste its address, with the port mistyped", async () => {
    await user.see({ role: "heading", label: "Add a connector" }, { timeoutMs: 120_000 });
    await user.type({ label: "Filter by name" }, "Acme Desk");
    await user.see({ testId: "connector-picker-no-match" }, { text: /No app called “Acme Desk”/ });
    await user.click({ testId: "connector-picker-no-match-add" });
    await user.see({ label: "Name" }, { value: "Acme Desk" });
    await user.type({ label: "Address" }, world.nothingThere);
    await user.screenshot();
  });

  await step("2. I continue and the first check stops: nothing answers at that address", async () => {
    await user.click({ role: "button", label: "Continue" });
    await user.see({ role: "heading", label: "Connect Acme Desk" }, { timeoutMs: 60_000 });
    await settle({ find: "failed", "sign-in-method": "waiting" });
    await user.see({ testId: "setup-check-find" }, { text: /OpenWork could not reach Acme Desk\. Check the address and try again\./ });
    await user.see({ testId: "step-footer-note" }, { text: "Step 1 of 4" });
    await user.notSee({ role: "button", label: "Sign in with Acme Desk" });
    await user.screenshot();
  });

  await step("3. I choose Change address: what I typed is still there, and I fix the port", async () => {
    await user.click({ role: "link", label: "Change address" });
    await user.see({ testId: "connector-picker-custom" }, { timeoutMs: 60_000 });
    await user.see({ label: "Address" }, { value: world.nothingThere });
    await user.see({ label: "Name" }, { value: "Acme Desk" });
    await user.type({ label: "Address" }, world.acmeDesk.mcpUrl, { replace: true });
    await user.screenshot();
  });

  await step("4. the checks fill in: Acme Desk answers and lets OpenWork register itself, so I can sign in", async () => {
    await user.click({ role: "button", label: "Continue" });
    await user.see({ role: "heading", label: "Connect Acme Desk" }, { timeoutMs: 60_000 });
    await settle({ find: "done", "sign-in-method": "done", "sign-in": "current", tools: "waiting" });
    await user.see({ testId: "setup-check-find" }, { text: /Acme Desk answered\./ });
    await user.see({ testId: "setup-check-sign-in-method" }, { text: /You sign in with your own Acme Desk account\./ });
    await user.see({ role: "button", label: "Sign in with Acme Desk" });
    await user.see({ testId: "step-footer-note" }, { text: "Step 3 of 4" });
    const served = await world.served(world.acmeDesk);
    const discovered = served.some((line) => line.startsWith("GET /.well-known/oauth-authorization-server"));
    evidence.recordAssertionEvidence("Den asked Acme Desk how to sign in", served.slice(0, 6).join("; "), discovered);
    expect(discovered, "Den read Acme Desk's sign-in details itself").toBe(true);
    expect(await world.checkedForReal(), "the checks came from Den, not a pinned answer").toBe(true);
    await user.screenshot();
  });

  await step("5. I sign in with my Acme Desk account, and the last two checks pass", async () => {
    await user.click({ role: "button", label: "Sign in with Acme Desk" });
    await user.see({ role: "heading", label: "Acme Desk is ready" }, { timeoutMs: 120_000 });
    await settle({ find: "done", "sign-in-method": "done", "sign-in": "done", tools: "done" });
    await user.see({ testId: "setup-check-tools" }, { text: /3 things, like search tickets and read ticket\./ });
    await user.see({ testId: "step-footer-note" }, { text: "All 4 steps done" });
    const registered = (await world.served(world.acmeDesk)).filter((line) => /^POST \/register 20\d$/.test(line));
    evidence.recordAssertionEvidence("OpenWork registered itself with Acme Desk", registered.join("; ") || "no registration", registered.length > 0);
    expect(registered.length, "OpenWork registered itself instead of needing an admin").toBeGreaterThan(0);
    const tab = await world.signInTab({ timeoutMs: 1_000 });
    if (tab?.client.targetId) await world.web.client.send("Target.closeTarget", { targetId: tab.client.targetId });
    await user.screenshot();
  });

  await step("6. I'm done: Acme Desk is in My Library, and Maya does not have it", async () => {
    await user.click({ role: "link", label: "Done" });
    await user.see({ testId: "library-section-mine" }, { text: /Acme Desk/, timeoutMs: 60_000 });
    expect(await world.library(world.den.members.sam), "Acme Desk is in Sam's Library").toContain("Acme Desk");
    expect(await world.library(world.den.members.maya), "Sam added it for himself only").not.toContain("Acme Desk");
    await user.screenshot();
  });

  await step("7. a vendor server that only takes a client an admin registers stops at the second check, before I try to sign in", async () => {
    await user.navigate(catalog);
    await user.click({ role: "button", label: "Add another MCP" });
    await user.type({ label: "Address" }, world.oldDesk.mcpUrl);
    await user.type({ label: "Name" }, "Old Desk");
    await user.click({ role: "button", label: "Continue" });
    await user.see({ role: "heading", label: "Connect Old Desk" }, { timeoutMs: 60_000 });
    await settle({ find: "done", "sign-in-method": "failed", "sign-in": "waiting" });
    await user.see({ testId: "setup-check-sign-in-method" }, { text: /An admin has to register OpenWork with Old Desk first\./ });
    await user.see({ testId: "step-footer-note" }, { text: "Step 2 of 4" });
    await user.notSee({ role: "button", label: "Sign in with Old Desk" });
    const served = await world.served(world.oldDesk);
    const asked = served.some((line) => line.startsWith("GET /.well-known/oauth-authorization-server"));
    const registered = served.some((line) => line.startsWith("POST /register"));
    evidence.recordAssertionEvidence("Den asked Old Desk how to sign in, and nothing tried to register", served.slice(0, 6).join("; "), asked && !registered);
    expect(asked && !registered, "Old Desk was checked but never asked to register OpenWork").toBe(true);
    expect(await world.library(world.den.members.sam), "nothing half-added to Sam's Library").not.toContain("Old Desk");
    await user.screenshot();
  });
});

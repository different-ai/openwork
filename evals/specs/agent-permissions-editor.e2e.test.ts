import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import {
  agentPermissionsAdminView,
  agentPermissionsEditor,
  agentPermissionsFeatureOff,
  agentPermissionsTwoTeams,
} from "../worlds/agent-permissions.ts";

const editorTest = spec.world(agentPermissionsEditor, { timeout: 600_000, resources: { surfaces: ["web"], services: ["den"] } });
const twoTeamsTest = spec.world(agentPermissionsTwoTeams, { timeout: 600_000, resources: { surfaces: ["web"], services: ["den"] } });
const adminViewTest = spec.world(agentPermissionsAdminView, { timeout: 600_000, resources: { surfaces: ["web"], services: ["den"] } });
const featureOffTest = spec.world(agentPermissionsFeatureOff, { timeout: 600_000, resources: { surfaces: ["web"], services: ["den"] } });

type Rule = { action: string; resource: string; effect: string; source: string };
const rule = (action: string, resource: string, effect: string, source: string): Rule => ({ action, resource, effect, source });

function describeRules(rules: Record<string, unknown>[] | null): string {
  if (rules === null) return "no agent permissions";
  return rules.map((entry) => `${String(entry.action)} ${String(entry.resource)} → ${String(entry.effect)} (${String(entry.source)})`).join("; ") || "none";
}

editorTest("an owner blocks commands for the Contractors team in Den, and only that team's members receive the rule", async ({ world, user, probe, step, evidence }) => {
  const owner = user.on(world.web);

  await step("before: the Contractors team uses Everyone's permissions and Riley's app receives no rules", async () => {
    await owner.see({ text: "Agent permissions" }, { timeoutMs: 90_000 });
    await owner.click({ testId: `agent-permissions-scope-${world.teamId}` });
    await owner.see({ testId: "agent-permissions-scope-state" }, { text: /1 member, same as Everyone/ });
    const received = await world.receivedRules("riley");
    evidence.recordAssertionEvidence("Riley's desktop config", describeRules(received), received?.length === 0);
    expect(received).toEqual([]);
    await owner.screenshot();
  });

  await step("the owner blocks commands except echo for Contractors, and trying rm -rf build shows it would be blocked", async () => {
    const tryResult = async () => (await probe.dom('[data-testid="agent-permission-try-result"]')).elements.map((element) => element.text).join(" ").trim();
    await owner.click({ role: "button", label: "Run commands" });
    await owner.click({ role: "option", label: "Block" });
    await owner.click({ testId: "agent-permission-commands-allow-add" });
    await owner.type({ testId: "agent-permission-commands-allow-input" }, "echo *");
    await owner.press("Enter");
    await owner.type({ testId: "agent-permission-try-input" }, "rm -rf build");
    await owner.see({ testId: "agent-permission-try-result" }, { text: /^Blocked/ });
    const blocked = await tryResult();
    await owner.type({ testId: "agent-permission-try-input" }, "echo done", { replace: true });
    await owner.see({ testId: "agent-permission-try-result" }, { text: /^Allowed/ });
    const allowed = await tryResult();
    evidence.recordAssertionEvidence("trying requests before saving", `rm -rf build → ${blocked}; echo done → ${allowed}`, blocked.startsWith("Blocked") && allowed.startsWith("Allowed"));
    expect(blocked).toContain("Run commands is set to Block for Contractors");
    expect(allowed).toContain('Matches "echo *" for Contractors');
    await owner.screenshot();
  });

  await step("after: the owner saves and Riley's app receives the Contractors rules in order", async () => {
    await owner.click({ role: "button", label: "Save changes" });
    await owner.see({ text: "Agent permissions saved" }, { timeoutMs: 30_000 });
    const received = await world.receivedRules("riley");
    const expected = [rule("shell", "*", "deny", "Contractors"), rule("shell", "echo *", "allow", "Contractors")];
    evidence.recordAssertionEvidence("Riley's rules", describeRules(received), JSON.stringify(received) === JSON.stringify(expected));
    expect(received).toEqual(expected);
    await owner.screenshot();
  });

  await step("a member outside the team receives no rules, and a member cannot change the permissions", async () => {
    await owner.see({ testId: "agent-permissions-scope-state" }, { text: /1 member, 1 override/ });
    const outside = await world.receivedRules("morgan");
    const status = await world.memberSaveStatus();
    evidence.recordAssertionEvidence("boundaries", `Morgan: ${describeRules(outside)}; Riley saving everyone's permissions → HTTP ${status}`, outside?.length === 0 && status === 403);
    expect(outside).toEqual([]);
    expect(status).toBe(403);
  });
});

editorTest("Everyone's permissions reach every member, and a team's own choice replaces Everyone's while the blocked lists still apply", async ({ world, user, step, evidence }) => {
  const owner = user.on(world.web);
  const everyoneRules = [
    rule("shell", "*", "ask", "Everyone"),
    rule("shell", "rm *", "deny", "Everyone"),
    rule("webfetch", "*", "deny", "Everyone"),
    rule("webfetch", "docs.example.com", "allow", "Everyone"),
    rule("websearch", "*", "deny", "Everyone"),
  ];

  await step("before: nobody has agent permissions yet", async () => {
    await owner.see({ text: "Agent permissions" }, { timeoutMs: 90_000 });
    await owner.see({ testId: "agent-permissions-scope-state" }, { text: /^All 3 members/ });
    const [riley, morgan] = [await world.receivedRules("riley"), await world.receivedRules("morgan")];
    evidence.recordAssertionEvidence("rules before", `Riley: ${describeRules(riley)}; Morgan: ${describeRules(morgan)}`, riley?.length === 0 && morgan?.length === 0);
    expect([riley, morgan]).toEqual([[], []]);
    await owner.screenshot();
  });

  await step("the owner asks first before any command and blocks rm, blocks websites except the docs site, and turns web search off for everyone", async () => {
    await owner.click({ role: "button", label: "Run commands" });
    await owner.click({ role: "option", label: "Ask first" });
    await owner.click({ testId: "agent-permission-commands-block-add" });
    await owner.type({ testId: "agent-permission-commands-block-input" }, "rm *");
    await owner.press("Enter");
    await owner.click({ role: "button", label: "Open websites" });
    await owner.click({ role: "option", label: "Block" });
    await owner.click({ testId: "agent-permission-websites-allow-add" });
    await owner.type({ testId: "agent-permission-websites-allow-input" }, "docs.example.com");
    await owner.press("Enter");
    await owner.click({ role: "checkbox", label: "Search the web" });
    await owner.see({ testId: "agent-permission-webSearch" }, { text: /Blocked/ });
    await owner.screenshot();
  });

  await step("on the Contractors team, Everyone's blocked command shows as locked and the team blocks commands except echo", async () => {
    await owner.click({ testId: `agent-permissions-scope-${world.teamId}` });
    await owner.see({ testId: "agent-permission-commands-block" }, { text: /rm \*/ });
    await owner.see({ label: "rm *, set for Everyone" });
    await owner.click({ role: "button", label: "Run commands" });
    await owner.click({ role: "option", label: "Block" });
    await owner.click({ testId: "agent-permission-commands-allow-add" });
    await owner.type({ testId: "agent-permission-commands-allow-input" }, "echo *");
    await owner.press("Enter");
    await owner.see({ testId: "agent-permissions-save-bar" }, { text: /Unsaved changes for Everyone, Contractors/ });
    await owner.screenshot();
  });

  await step("after: one save stores both, Morgan receives Everyone's rules and Riley the team's choice with Everyone's blocked list last", async () => {
    await owner.click({ role: "button", label: "Save changes" });
    await owner.see({ text: "Agent permissions saved" }, { timeoutMs: 30_000 });
    const morgan = await world.receivedRules("morgan");
    const riley = await world.receivedRules("riley");
    const rileyRules = [
      rule("shell", "*", "deny", "Contractors"),
      rule("shell", "echo *", "allow", "Contractors"),
      rule("shell", "rm *", "deny", "Everyone"),
      ...everyoneRules.slice(2),
    ];
    evidence.recordAssertionEvidence("Morgan's rules (no team)", describeRules(morgan), JSON.stringify(morgan) === JSON.stringify(everyoneRules));
    evidence.recordAssertionEvidence("Riley's rules (Contractors)", describeRules(riley), JSON.stringify(riley) === JSON.stringify(rileyRules));
    expect(morgan).toEqual(everyoneRules);
    expect(riley).toEqual(rileyRules);
    await owner.see({ testId: "agent-permissions-scope-state" }, { text: /1 member, 1 override/ });
    await owner.screenshot();
  });
});

twoTeamsTest("a member in two teams gets the strictest decision of the two, and both teams' lists", async ({ world, user, step, evidence }) => {
  const owner = user.on(world.web);
  const engineering = world.teamIds.Engineering ?? "";
  await world.saveContractors({ commands: { decision: "deny", allow: ["echo *"] } });

  await step("before: Contractors blocks commands except echo, and Riley, also in Engineering, receives that", async () => {
    await owner.see({ text: "Agent permissions" }, { timeoutMs: 90_000 });
    await owner.click({ testId: `agent-permissions-scope-${engineering}` });
    await owner.see({ testId: "agent-permissions-scope-state" }, { text: /1 member, same as Everyone/ });
    const received = await world.receivedRules("riley");
    const expected = [rule("shell", "*", "deny", "Contractors"), rule("shell", "echo *", "allow", "Contractors")];
    evidence.recordAssertionEvidence("Riley's rules", describeRules(received), JSON.stringify(received) === JSON.stringify(expected));
    expect(received).toEqual(expected);
    await owner.screenshot();
  });

  await step("the owner allows commands for Engineering but always blocks git push", async () => {
    await owner.click({ role: "button", label: "Run commands" });
    await owner.click({ role: "option", label: "Allow" });
    await owner.click({ testId: "agent-permission-commands-block-add" });
    await owner.type({ testId: "agent-permission-commands-block-input" }, "git push *");
    await owner.press("Enter");
    await owner.click({ role: "button", label: "Save changes" });
    await owner.see({ text: "Agent permissions saved" }, { timeoutMs: 30_000 });
    await owner.screenshot();
  });

  await step("after: Riley still cannot run other commands, Contractors' Block being stricter, and git push is blocked too", async () => {
    const received = await world.receivedRules("riley");
    const expected = [
      rule("shell", "*", "deny", "Contractors"),
      rule("shell", "echo *", "allow", "Contractors"),
      rule("shell", "git push *", "deny", "Engineering"),
    ];
    evidence.recordAssertionEvidence("Riley's rules (Contractors and Engineering)", describeRules(received), JSON.stringify(received) === JSON.stringify(expected));
    expect(received).toEqual(expected);
  });
});

editorTest("an owner undoes a save, then puts a team back on Everyone's permissions", async ({ world, user, step, evidence }) => {
  const owner = user.on(world.web);
  const contractorRules = [rule("shell", "*", "deny", "Contractors"), rule("shell", "echo *", "allow", "Contractors")];
  await world.saveContractors({ commands: { decision: "deny", allow: ["echo *"] } });

  await step("before: Contractors blocks commands except echo", async () => {
    await owner.see({ text: "Agent permissions" }, { timeoutMs: 90_000 });
    await owner.click({ testId: `agent-permissions-scope-${world.teamId}` });
    await owner.see({ testId: "agent-permissions-scope-state" }, { text: /1 member, 1 override/ });
    const received = await world.receivedRules("riley");
    evidence.recordAssertionEvidence("Riley's rules", describeRules(received), JSON.stringify(received) === JSON.stringify(contractorRules));
    expect(received).toEqual(contractorRules);
    await owner.screenshot();
  });

  await step("the owner turns web search off for Contractors, saves, and undoes it from the confirmation", async () => {
    await owner.click({ role: "checkbox", label: "Search the web" });
    await owner.click({ role: "button", label: "Save changes" });
    await owner.see({ text: "Agent permissions saved" }, { timeoutMs: 30_000 });
    const saved = await world.receivedRules("riley");
    await owner.click({ role: "button", label: "Undo" });
    await owner.see({ text: "Agent permissions restored" }, { timeoutMs: 30_000 });
    const restored = await world.receivedRules("riley");
    evidence.recordAssertionEvidence("Riley's rules after save, then undo", `${describeRules(saved)} → ${describeRules(restored)}`,
      saved?.some((entry) => entry.action === "websearch") === true && JSON.stringify(restored) === JSON.stringify(contractorRules));
    expect(saved).toContainEqual(rule("websearch", "*", "deny", "Contractors"));
    expect(restored).toEqual(contractorRules);
    await owner.screenshot();
  });

  await step("after: the owner puts Contractors back on Everyone's permissions, and Riley receives no rules", async () => {
    await owner.reload();
    await owner.click({ testId: `agent-permissions-scope-${world.teamId}` });
    await owner.click({ role: "button", label: "Use Everyone's permissions" });
    await owner.click({ role: "button", label: "Save changes" });
    await owner.see({ text: "Agent permissions saved" }, { timeoutMs: 30_000 });
    await owner.see({ testId: "agent-permissions-scope-state" }, { text: /1 member, same as Everyone/ });
    const received = await world.receivedRules("riley");
    evidence.recordAssertionEvidence("Riley's rules", describeRules(received), received?.length === 0);
    expect(received).toEqual([]);
    await owner.screenshot();
  });
});

editorTest("the editor refuses a website it cannot match, and discarding keeps what was saved", async ({ world, user, probe, step, evidence }) => {
  const owner = user.on(world.web);
  const tryResult = async () => (await probe.dom('[data-testid="agent-permission-try-result"]')).elements.map((element) => element.text).join(" ").trim();

  await step("before: websites are allowed for everyone", async () => {
    await owner.see({ text: "Agent permissions" }, { timeoutMs: 90_000 });
    await owner.see({ testId: "agent-permission-websites" }, { text: /Allow/ });
    await owner.screenshot();
  });

  await step("the owner blocks websites, and an address with a query is refused with what to enter instead", async () => {
    await owner.click({ role: "button", label: "Open websites" });
    await owner.click({ role: "option", label: "Block" });
    await owner.click({ testId: "agent-permission-websites-allow-add" });
    await owner.type({ testId: "agent-permission-websites-allow-input" }, "https://docs.example.com/guides?page=2");
    await owner.press("Enter");
    await owner.see({ text: "Enter a site like docs.example.com, *.example.com or example.com/docs." });
    await owner.screenshot();
  });

  await step("a site with its subdomains and a path is accepted, and trying addresses shows which open", async () => {
    await owner.type({ testId: "agent-permission-websites-allow-input" }, "*.example.com/guides", { replace: true });
    await owner.press("Enter");
    await owner.see({ testId: "agent-permission-websites-allow" }, { text: /\*\.example\.com\/guides/ });
    await owner.click({ role: "button", label: "Request type" });
    await owner.click({ role: "option", label: "Website" });
    await owner.type({ testId: "agent-permission-try-input" }, "https://api.example.com/guides/setup");
    await owner.see({ testId: "agent-permission-try-result" }, { text: /^Allowed/ });
    const allowed = await tryResult();
    await owner.type({ testId: "agent-permission-try-input" }, "https://example.org/", { replace: true });
    await owner.see({ testId: "agent-permission-try-result" }, { text: /^Blocked/ });
    const blocked = await tryResult();
    evidence.recordAssertionEvidence("trying websites", `api.example.com/guides/setup → ${allowed}; example.org → ${blocked}`, allowed.startsWith("Allowed") && blocked.startsWith("Blocked"));
    expect(allowed).toContain('Matches "*.example.com/guides" for Everyone');
    expect(blocked).toContain("Open websites is set to Block for Everyone");
    await owner.screenshot();
  });

  await step("after: discarding returns websites to Allow, and members' apps still receive no rules", async () => {
    await owner.click({ role: "button", label: "Discard" });
    await owner.notSee({ testId: "agent-permissions-save-bar" });
    await owner.see({ testId: "agent-permission-websites" }, { text: /Allow/ });
    const received = await world.receivedRules("morgan");
    evidence.recordAssertionEvidence("Morgan's rules", describeRules(received), received?.length === 0);
    expect(received).toEqual([]);
    await owner.screenshot();
  });
});

adminViewTest("an admin who is not an owner can read the permissions but not change them, and a member cannot open them", async ({ world, user, step, evidence }) => {
  const admin = user.on(world.web);

  await step("Morgan, an admin, sees Contractors' permissions with every control locked", async () => {
    await admin.see({ text: "Read only. Needs the “Manage desktop policies” permission. Ask the organization owner." }, { timeoutMs: 90_000 });
    await admin.click({ testId: `agent-permissions-scope-${world.teamId}` });
    await admin.see({ testId: "agent-permissions-scope-state" }, { text: /1 member, 1 override/ });
    const controls = await world.permissionControls();
    evidence.recordAssertionEvidence("the permission controls for an admin", `${controls.disabled} of ${controls.count} disabled`, controls.count === 6 && controls.disabled === 6);
    expect(controls).toEqual({ count: 6, disabled: 6 });
    await admin.screenshot();
  });

  await step("the API refuses Morgan's change, and refuses Riley, a member, even reading the permissions", async () => {
    const adminSave = await world.saveStatus("morgan");
    const memberRead = await world.readStatus("riley");
    const ownerRead = await world.readStatus("owner");
    evidence.recordAssertionEvidence("who may do what", `Morgan saving → HTTP ${adminSave}; Riley reading → HTTP ${memberRead}; Avery reading → HTTP ${ownerRead}`,
      adminSave === 403 && memberRead === 403 && ownerRead === 200);
    expect([adminSave, memberRead, ownerRead]).toEqual([403, 403, 200]);
  });
});

featureOffTest("agent permissions stay off until a platform admin turns them on for the organization", async ({ world, user, step, evidence }) => {
  const owner = user.on(world.web);

  await step("before: the page says agent permissions are off, the menu has no entry, and the API and members' apps have none", async () => {
    await owner.see({ text: "Agent permissions aren't turned on for this organization." }, { timeoutMs: 90_000 });
    await owner.notSee({ testId: "dashboard-nav-agent-permissions" });
    const read = await world.readStatus("owner");
    const received = await world.receivedRules("riley");
    evidence.recordAssertionEvidence("while off", `GET /v1/agent-permissions → HTTP ${read}; Riley: ${describeRules(received)}`, read === 404 && received === null);
    expect(read).toBe(404);
    expect(received).toBeNull();
    await owner.screenshot();
  });

  await step("after: once it is on, the owner sees the editor and the menu entry, and members' apps receive empty rules", async () => {
    await world.enableFeature();
    await owner.reload();
    await owner.see({ testId: "agent-permissions-scope-everyone" }, { timeoutMs: 60_000 });
    await owner.see({ testId: "dashboard-nav-agent-permissions" });
    const read = await world.readStatus("owner");
    const received = await world.receivedRules("riley");
    evidence.recordAssertionEvidence("once on", `GET /v1/agent-permissions → HTTP ${read}; Riley: ${describeRules(received)}`, read === 200 && received?.length === 0);
    expect(read).toBe(200);
    expect(received).toEqual([]);
    await owner.screenshot();
  });
});

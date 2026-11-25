import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import type { Target } from "@openwork/testkit";
import { browserSecretHandlesWorld } from "../worlds/browser-secret-handles.ts";

const test = spec.world(browserSecretHandlesWorld, {
  timeout: 600_000,
  resources: {
    surfaces: ["desktop"],
    services: ["den", "mock"],
    nativeReason: "A saved secret lives in the desktop's main process and is swapped into the requests of Electron's native page view; a browser tab has neither.",
  },
});

const secretsButton: Target = { testId: "browser-secrets-open" };
const secretsDialog: Target = { testId: "browser-secrets-dialog" };
const approvalCard: Target = { testId: "session-computer-request" };
const SECRET_NAME = "Billing sign-in";

function tabHandle(value: unknown): string {
  if (!value || typeof value !== "object" || !("tab_id" in value) || typeof value.tab_id !== "string") throw new Error("The browser returned no tab handle.");
  return value.tab_id;
}

function offeredSecrets(value: unknown): Array<{ secretRef: string; label: string; kind: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item: unknown) => {
    if (!item || typeof item !== "object") return [];
    const secretRef: unknown = Reflect.get(item, "secretRef"), label: unknown = Reflect.get(item, "label"), kind: unknown = Reflect.get(item, "kind");
    return typeof secretRef === "string" && typeof label === "string" && typeof kind === "string" ? [{ secretRef, label, kind }] : [];
  });
}

function secretStatuses(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item: unknown) => {
    const state: unknown = item && typeof item === "object" ? Reflect.get(item, "state") : null;
    return typeof state === "string" ? [state] : [];
  });
}

test("a person saves a password for one site and the agent signs in with it without ever receiving it", async ({ world, user, agent, probe, step, evidence }) => {
  const sessionId = world.session.sessionId;
  let tabId = "";
  let secretRef = "";
  /** Everything the agent was sent by the browser tools in this run, for the leak check at the end. */
  const agentSaw: string[] = [];
  const browser = async (operation: "observe" | "act" | "open", args: NonNullable<Parameters<typeof agent.browserTask>[0]["args"]>, session = sessionId) => {
    const reply = await agent.browserTask({ sessionId: session, operation, args });
    agentSaw.push(JSON.stringify(reply));
    return reply;
  };
  const control = (reply: Awaited<ReturnType<typeof browser>>, match: (element: { name: string; type?: string; tag?: string }) => boolean) => {
    const found = reply.elements?.find(match);
    if (!found || !reply.observationId) throw new Error(`The page control was not observed: ${reply.code ?? "no elements"}`);
    return { ref: found.ref, observationId: reply.observationId };
  };
  const cardText = async () => (await probe.dom('[data-testid="session-computer-request"]')).elements.map((element) => element.text.replace(/\s+/g, " ")).join(" ");
  const screenText = async () => (await probe.dom("body")).elements.map((element) => element.text).join(" ");

  await step("before: with secret handles off, the browser has no Secrets control and the agent cannot fill a saved secret", async () => {
    await agent.run("session.open", { sessionId });
    if (await probe.has("Not now")) await user.click({ role: "button", label: "Not now" });
    await user.see({ testId: "session-browser-toggle" }, { timeoutMs: 60_000 });
    tabId = tabHandle(await agent.run("browser.open_url", { url: world.signInUrl, provider: "builtin" }));
    const observed = await probe.eventually(() => browser("observe", { tabId }), {
      within: 30_000, label: "the https sign-in page is readable", until: (reply) => reply.ok && String(reply.url).startsWith(world.site),
    });
    const password = control(observed, (element) => element.type === "password");
    const heading = control(observed, (element) => element.tag === "h1");
    // Recorded for the run log only: whether an agent click reaches this page in this environment, before any secret exists.
    const baseline = await browser("act", { tabId, observationId: heading.observationId, action: { type: "click", ref: heading.ref } });
    const afterBaseline = await browser("observe", { tabId });
    console.log(`[secret-handles] agent click before any secret: outcome=${baseline.outcome}; page says: ${JSON.stringify(String(afterBaseline.text).split("\n").at(-1))}`);
    await user.notSee(secretsButton, { timeoutMs: 5_000 });
    const refused = await browser("act", { tabId, observationId: password.observationId, action: { type: "fill_secret", ref: password.ref, secretRef: "not-saved" } });
    evidence.recordAssertionEvidence(
      "With the feature off there is nowhere to save a secret and fill_secret is refused",
      `page: ${observed.url}; Secrets control in the toolbar: no; fill_secret answered ok=${refused.ok} code=${refused.code}; saved secrets offered: ${offeredSecrets(observed.availableSecrets).length}`,
      refused.ok === false && refused.code === "secrets_unavailable",
    );
    await user.screenshot();
    expect(refused).toMatchObject({ ok: false, code: "secrets_unavailable" });
    expect(observed.availableSecrets).toBeUndefined();
  });

  await step("after: once an admin turns secret handles on, a Secrets key appears in the browser toolbar without a restart", async () => {
    await world.turnOnSecretHandles();
    if ((await probe.dom('[data-testid="session-browser-toggle"][data-browser-mode="hidden"]')).elements.length) await user.click({ testId: "session-browser-toggle" });
    await user.see(secretsButton, { timeoutMs: 150_000 });
    const keys = (await probe.dom('[data-testid="browser-secrets-open"]')).elements.length;
    evidence.recordAssertionEvidence("The Secrets control follows the organization's switch",
      `Secrets keys in the browser toolbar after the switch was turned on: ${keys}; the app was not restarted or reloaded.`, keys === 1);
    await user.screenshot();
    expect(keys).toBe(1);
  });

  await step("after: the person saves a password in OpenWork's own dialog, masked as they type, for the sign-in site only", async () => {
    await user.click(secretsButton);
    await user.see(secretsDialog);
    await user.type({ testId: "browser-secret-name" }, SECRET_NAME);
    await user.type({ testId: "browser-secret-value" }, world.password, { sensitive: true });
    await user.screenshot();
    await user.click({ testId: "browser-secret-save" });
    await user.see({ testId: "browser-secret" }, { timeoutMs: 15_000 });
    const dialog = (await probe.dom('[data-testid="browser-secrets-dialog"]')).elements.map((element) => element.text).join(" ");
    const listed = dialog.includes(SECRET_NAME) && dialog.includes(`Password for ${world.siteName}`);
    const leaked = (await screenText()).includes(world.password);
    evidence.recordAssertionEvidence(
      "The saved secret is listed by name, type and site, never by value",
      `listed as "${SECRET_NAME}", Password for ${world.siteName}: ${listed}; the value appears anywhere on screen: ${leaked}`,
      listed && !leaked,
    );
    await user.screenshot();
    expect(listed).toBe(true);
    expect(leaked).toBe(false);
    await user.press("Escape");
    await user.notSee(secretsDialog);
  });

  let passwordField = { ref: "", observationId: "" };
  await step("after: the agent is offered the secret as a handle, a name and a type", async () => {
    const observed = await browser("observe", { tabId });
    const offered = offeredSecrets(observed.availableSecrets);
    secretRef = offered[0]?.secretRef ?? "";
    passwordField = control(observed, (element) => element.type === "password");
    const keys = Array.isArray(observed.availableSecrets) && observed.availableSecrets[0] && typeof observed.availableSecrets[0] === "object"
      ? Object.keys(observed.availableSecrets[0]).sort().join(", ") : "none";
    evidence.recordAssertionEvidence(
      "The observation lists the secret without its value",
      `secrets offered: ${offered.length}; fields of each: ${keys}; name "${offered[0]?.label}", type ${offered[0]?.kind}; the value is in the observation: ${JSON.stringify(observed).includes(world.password)}`,
      offered.length === 1 && offered[0]?.label === SECRET_NAME && !JSON.stringify(observed).includes(world.password),
    );
    expect(offered).toEqual([{ secretRef: expect.any(String), label: SECRET_NAME, kind: "password" }]);
  });

  await step("after: OpenWork asks the person before filling, naming the secret, the site and the field, and fills only on Fill", async () => {
    const filling = browser("act", { tabId, observationId: passwordField.observationId, action: { type: "fill_secret", ref: passwordField.ref, secretRef } });
    await user.see(approvalCard, { timeoutMs: 30_000 });
    const card = await cardText();
    const asked = card.includes(`Fill “${SECRET_NAME}” on ${world.site}?`) && card.includes("Password, into a password field.");
    await user.screenshot();
    await user.click({ testId: "session-computer-credential-allow" });
    const filled = await filling;
    evidence.recordAssertionEvidence(
      "The fill waits for the person's answer and reports an outcome, not a value",
      `card: "${card.slice(0, 160)}"; after Fill the agent got ok=${filled.ok} outcome=${filled.outcome}; text in the reply: ${Object.hasOwn(filled, "text") || Object.hasOwn(filled, "value") ? "yes" : "none"}`,
      asked && filled.ok === true && filled.outcome === "verified",
    );
    expect(asked, `approval card read: ${card}`).toBe(true);
    expect(card).not.toContain(world.password);
    expect(filled).toMatchObject({ ok: true, outcome: "verified", secretRef });
    await user.notSee(approvalCard, { timeoutMs: 3_000 });
  });

  await step("after: the site signs the person in with the real password, while the page's own script and another site only ever get a placeholder", async () => {
    // The fixture site sends its form as soon as the password field is filled, so no further agent input is needed.
    const received = await probe.eventually(async () => world.received(), {
      within: 20_000, label: "the sign-in reaches the site", until: (state) => state.signIns.length === 1,
    });
    const after = await probe.eventually(() => browser("observe", { tabId }), {
      within: 15_000, label: "the agent reads the signed-in page", until: (reply) => secretStatuses(reply.secrets).includes("sent") && String(reply.text).includes("Signed in to billing"),
    });
    const signedIn = received.signIns[0]?.carriedSecret === true;
    const scriptSawSecret = received.scriptReads.some((read) => read.sawSecret);
    const trackerGotSecret = received.tracker.some((request) => request.carriedSecret);
    evidence.recordAssertionEvidence(
      "Only the request to the allowed site carries the password",
      `sign-in request carried the real password: ${signedIn}; the page's script read the real password: ${scriptSawSecret} (it read ${received.scriptReads[0]?.length} characters of placeholder); `
        + `requests to the other site: ${received.tracker.length}, carrying the real password: ${trackerGotSecret}; the agent's report for the secret: ${secretStatuses(after.secrets).join(", ")}`,
      signedIn && !scriptSawSecret && received.tracker.length === 1 && !trackerGotSecret,
    );
    await user.screenshot();
    expect(received.signIns).toEqual([{ carriedSecret: true }]);
    expect(received.scriptReads).toHaveLength(1);
    expect(scriptSawSecret).toBe(false);
    // Witness: the other site was really sent the field's text, so "no password" is not "no request".
    expect(received.tracker).toHaveLength(1);
    expect(received.tracker[0]?.length).toBeGreaterThan(0);
    expect(trackerGotSecret).toBe(false);
  });

  await step("another conversation on the same site is not offered the secret and cannot use its handle", async () => {
    const other = world.neighbor.sessionId;
    const opened = await browser("open", { url: world.signInUrl }, other);
    const observed = await browser("observe", { tabId: opened.tabId }, other);
    const field = control(observed, (element) => element.type === "password");
    const refused = await browser("act", { tabId: opened.tabId, observationId: field.observationId, action: { type: "fill_secret", ref: field.ref, secretRef } }, other);
    const everLeaked = agentSaw.some((reply) => reply.includes(world.password));
    const onScreen = (await screenText()).includes(world.password);
    evidence.recordAssertionEvidence(
      "The secret belongs to one conversation, and its value never reached the agent or the screen",
      `other conversation offered ${offeredSecrets(observed.availableSecrets).length} secrets; its fill_secret with the first conversation's handle answered code=${refused.code}; `
        + `browser tool replies checked: ${agentSaw.length}, containing the value: ${everLeaked}; value on the app's screen: ${onScreen}; sign-ins the site received in total: ${world.received().signIns.length}`,
      refused.ok === false && refused.code === "unknown_secret" && !everLeaked && !onScreen,
    );
    expect(observed.availableSecrets).toBeUndefined();
    expect(refused).toMatchObject({ ok: false, code: "unknown_secret" });
    expect(everLeaked).toBe(false);
    expect(onScreen).toBe(false);
    expect(world.received().signIns).toHaveLength(1);
  });
});

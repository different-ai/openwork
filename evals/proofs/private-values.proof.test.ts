import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import type { Target } from "@openwork/testkit";
import { privateValuesAdminWorld, privateValuesWorld } from "../worlds/private-values.ts";

const test = spec.world(privateValuesWorld, {
  timeout: 600_000,
  resources: {
    surfaces: ["desktop"],
    services: ["den", "mock"],
    nativeReason: "The command runs in the desktop's main process and what it prints is typed into Electron's native page view; a browser tab has neither.",
  },
});

const governed = spec.world(privateValuesAdminWorld, {
  timeout: 900_000,
  resources: {
    surfaces: ["web", "desktop"],
    services: ["den", "mock"],
    nativeReason: "The organization's rules are read and enforced by the desktop's main process, which also runs the command and types into Electron's native page view.",
  },
});

const approvalCard: Target = { testId: "session-computer-request" };

function tabHandle(value: unknown): string {
  if (!value || typeof value !== "object" || !("tab_id" in value) || typeof value.tab_id !== "string") throw new Error("The browser returned no tab handle.");
  return value.tab_id;
}

function stepOutcomes(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item: unknown) => {
    const type: unknown = item && typeof item === "object" ? Reflect.get(item, "type") : null;
    const outcome: unknown = item && typeof item === "object" ? Reflect.get(item, "outcome") : null;
    return typeof type === "string" && typeof outcome === "string" ? [`${type} ${outcome}`] : [];
  });
}

test("a person keeps a sign-in in their password manager, or pastes it by hand, and the agent signs in with it by naming the command or the value, without ever receiving it", async ({ world, user, agent, probe, step, evidence }) => {
  const sessionId = world.session.sessionId;
  let tabId = "";
  /** Everything the agent was sent by the browser tools in this run, for the leak check at the end. */
  const agentSaw: string[] = [];
  const browser = async (operation: "observe" | "act" | "navigate", args: NonNullable<Parameters<typeof agent.browserTask>[0]["args"]>) => {
    const reply = await agent.browserTask({ sessionId, operation, args });
    agentSaw.push(JSON.stringify(reply));
    return reply;
  };
  const fields = async () => {
    const observed = await browser("observe", { tabId });
    const email = observed.elements?.find((element) => element.type === "email");
    const password = observed.elements?.find((element) => element.type === "password");
    if (!email || !password || !observed.observationId) throw new Error(`The sign-in form was not observed: ${observed.code ?? "no fields"}`);
    return { observed, observationId: observed.observationId, email: email.ref, password: password.ref };
  };
  const signInWithVault = (form: Awaited<ReturnType<typeof fields>>) => browser("act", { tabId, observationId: form.observationId, actions: [
    { type: "fill_from", ref: form.email, command: world.vaultRead("billing/email") },
    { type: "fill_from", ref: form.password, command: world.vaultRead("billing/password") },
  ] });
  const cardLines = async (testId: string) => (await probe.dom(`[data-testid="${testId}"]`)).elements.map((element) => element.text.replace(/\s+/g, " ").trim());
  const cardText = async () => (await cardLines("session-computer-request")).join(" ");
  const screenText = async () => (await probe.dom("body")).elements.map((element) => element.text).join(" ");

  const count = (text: string, value: string) => text.split(value).length - 1;
  /** The person asks about a note; the agent prints it with its own shell and answers. */
  const askAboutNote = async (label: string, which: "billing" | "contact" | "session" = "billing") => {
    const nonce = Math.random().toString(36).slice(2, 10);
    const prompt = `${label} ${nonce}`;
    const reply = `I read the ${which} note. ${nonce}`;
    await world.scriptNoteTurn(prompt, reply, which);
    await user.type("composer", prompt);
    await user.click("Run task");
    await probe.eventually(async () => {
      if (await probe.has("Allow once")) await user.click("Allow once");
      return screenText();
    }, { within: 150_000, label: "the agent answers", until: (text) => text.includes(reply) });
    const requests = await world.modelRequests(prompt);
    return { requests, afterTool: requests.filter((request) => request.completedTools > 0), carrying: requests.filter((request) => request.privateSentinelSeen).length };
  };

  await step("before: with the feature off, the agent is not told it can fill from a command, and trying runs nothing", async () => {
    await agent.run("session.open", { sessionId });
    if (await probe.has("Not now")) await user.click({ role: "button", label: "Not now" });
    await user.see({ testId: "session-browser-toggle" }, { timeoutMs: 60_000 });
    tabId = tabHandle(await agent.run("browser.open_url", { url: world.signInUrl, provider: "builtin" }));
    await probe.eventually(() => browser("observe", { tabId }), {
      within: 30_000, label: "the https sign-in page is readable", until: (reply) => reply.ok && String(reply.url).startsWith(world.site),
    });
    const form = await fields();
    const refused = await signInWithVault(form);
    const asked = (await probe.dom('[data-testid="session-computer-request"]')).elements.length;
    evidence.recordAssertionEvidence(
      "With the feature off, fill_from is refused before anyone is asked and before anything runs",
      `page: ${form.observed.url}; observation says privateValues: ${JSON.stringify(form.observed.privateValues ?? null)}; fill_from answered ok=${refused.ok} code=${refused.code}; approval cards shown: ${asked}; times the vault was run: ${world.vaultRuns().length}`,
      refused.ok === false && refused.code === "values_unavailable" && asked === 0 && world.vaultRuns().length === 0,
    );
    await user.screenshot();
    expect(form.observed.privateValues).toBeUndefined();
    expect(refused).toMatchObject({ ok: false, code: "values_unavailable" });
    expect(asked).toBe(0);
    expect(world.vaultRuns()).toEqual([]);
  });

  await step("before: OpenWork has never held the sign-in, so when the agent's own shell prints it, the model receives it", async () => {
    const turn = await askAboutNote("What does the billing note say?");
    evidence.recordAssertionEvidence(
      "A value OpenWork does not hold reaches the model as it is (this is also the check that the model witness can see one)",
      `requests the model received for this turn: ${turn.requests.length}, of which after the shell ran: ${turn.afterTool.length}; requests containing the email or the password: ${turn.carrying}`,
      turn.afterTool.length > 0 && turn.carrying > 0,
    );
    await user.screenshot();
    expect(turn.afterTool.length).toBeGreaterThan(0);
    expect(turn.carrying).toBeGreaterThan(0);
  });

  await step("after: once an admin turns the feature on, the agent is told this page's fields can be filled from a command, without a restart", async () => {
    await world.turnOnPrivateValues();
    const observed = await probe.eventually(() => browser("observe", { tabId }), {
      within: 150_000, label: "the observation offers fill_from", until: (reply) => reply.privateValues === "fill_from",
    });
    await user.see({ testId: "session-browser-toggle" });
    evidence.recordAssertionEvidence("What the agent is told follows the organization's switch",
      `observation says privateValues: ${JSON.stringify(observed.privateValues)}; the app was not restarted or reloaded.`, observed.privateValues === "fill_from");
    expect(observed.privateValues).toBe("fill_from");
  });

  await step("after: OpenWork asks the person once for both fields, showing each command in full, its field and the site, and Don't run runs nothing", async () => {
    const asking = signInWithVault(await fields());
    await user.see(approvalCard, { timeoutMs: 30_000 });
    const card = await cardText();
    const commands = await cardLines("session-computer-credential-command");
    const into = await cardLines("session-computer-credential-field");
    const where = (await cardLines("session-computer-credential-site")).join("");
    const whole = commands.length === 2 && commands[0]?.endsWith("vault read billing/email") && commands[1]?.endsWith("vault read billing/password")
      && commands.every((line) => line.startsWith("/"));
    await user.screenshot();
    await user.click({ testId: "session-computer-credential-dismiss" });
    const refused = await asking;
    evidence.recordAssertionEvidence(
      "One card lists every command, and declining it runs none of them",
      `card: "${card.slice(0, 150)}"; commands listed: ${commands.length}, ending "${commands.map((line) => line.split("/").at(-2) + "/" + line.split("/").at(-1)).join('" and "')}"; fields: ${into.join(" / ")}; site: ${where}; `
        + `after Don't run the agent got ok=${refused.ok} code=${refused.code}; times the vault was run: ${world.vaultRuns().length}`,
      whole && where === world.siteName && refused.code === "credential_declined" && world.vaultRuns().length === 0,
    );
    expect(card).toContain("Run these 2 commands and fill what they print on");
    expect(whole, `commands on the card: ${commands.join(" | ")}`).toBe(true);
    expect(into).toEqual(["Into an email field", "Into a password field"]);
    expect(where).toBe(world.siteName);
    expect(card).not.toContain(world.password);
    expect(card).not.toContain(world.email);
    expect(refused).toMatchObject({ ok: false, code: "credential_declined" });
    expect(world.vaultRuns()).toEqual([]);
    await user.notSee(approvalCard, { timeoutMs: 3_000 });
  });

  await step("after: on Run and fill, each command runs once, the site signs the person in, and the agent gets outcomes, not values", async () => {
    const filling = signInWithVault(await fields());
    await user.see(approvalCard, { timeoutMs: 30_000 });
    await user.click({ testId: "session-computer-credential-allow" });
    const filled = await filling;
    // The fixture site sends its form as soon as the password field is filled, so no further agent input is needed.
    const received = await probe.eventually(async () => world.received(), {
      within: 20_000, label: "the sign-in reaches the site", until: (state) => state.signIns.length === 1,
    });
    const after = await probe.eventually(() => browser("observe", { tabId }), {
      within: 15_000, label: "the agent reads the signed-in page", until: (reply) => String(reply.text).includes("Signed in to billing"),
    });
    const outcomes = stepOutcomes(filled.steps);
    const emailField = after.elements?.find((element) => element.type === "email");
    evidence.recordAssertionEvidence(
      "The values go from the commands to the page, and only outcomes come back",
      `the agent got ok=${filled.ok}, steps: ${outcomes.join(", ")}; vault runs: ${world.vaultRuns().join(" | ")}; sign-in request carried the real password: ${received.signIns[0]?.carriedSecret}; `
        + `the page says "Signed in to billing"; the email field reads to the agent as ${JSON.stringify(emailField?.value ?? null)}. The page's own script read the real password: ${received.scriptReads.some((read) => read.sawSecret)} (expected: the real value is typed, so the site can read it).`,
      filled.ok === true && received.signIns[0]?.carriedSecret === true,
    );
    await user.screenshot();
    expect(filled).toMatchObject({ ok: true });
    expect(outcomes).toEqual(["fill_from verified", "fill_from verified"]);
    expect(world.vaultRuns()).toEqual(["read billing/email", "read billing/password"]);
    expect(received.signIns).toEqual([{ carriedSecret: true }]);
    expect(String(emailField?.value ?? "")).not.toContain(world.email);
  });

  await step("after: now that OpenWork has filled the sign-in, the same shell output reaches the model and the saved conversation with the values replaced", async () => {
    const since = new Date(Date.now() - 1_000).toISOString();
    const storedBefore = await world.storedConversation();
    const turn = await askAboutNote("Read the billing note again.");
    const all = await world.modelRequestsSince(since);
    const allCarrying = all.filter((request) => request.privateSentinelSeen).length;
    const stored = await world.storedConversation();
    const kept = { before: count(storedBefore, world.password) + count(storedBefore, world.email), after: count(stored, world.password) + count(stored, world.email) };
    const replaced = count(stored, "[secret]") - count(storedBefore, "[secret]");
    evidence.recordAssertionEvidence(
      "Once OpenWork holds a value, no request to the model carries it, whichever tool printed it and however old the message",
      `requests the model received for this turn: ${turn.requests.length}, of which after the shell ran: ${turn.afterTool.length}; containing the email or the password: ${turn.carrying}. `
        + `Every request the model received since the fill, for anything: ${all.length}; containing either: ${allCarrying}. `
        + `These requests include the earlier turn, where the note was printed before OpenWork held it. `
        + `The saved conversation holds the values ${kept.before} times before this turn and ${kept.after} after (the earlier turn's copy is not rewritten); "[secret]" appears ${replaced} more times.`,
      turn.afterTool.length > 0 && turn.carrying === 0 && allCarrying === 0 && kept.after === kept.before && replaced > 0,
    );
    await user.screenshot();
    expect(storedBefore.length).toBeGreaterThan(0);
    expect(turn.afterTool.length).toBeGreaterThan(0);
    expect(turn.carrying).toBe(0);
    expect(allCarrying).toBe(0);
    expect(kept.after).toBe(kept.before);
    expect(replaced).toBeGreaterThan(0);
  });

  await step("after: a program needs the same password, so the agent gives it to the program by name; the card shows the exact command, and the agent reads what it printed with the value hidden", async () => {
    const program = ["/bin/sh", "-c", 'printf "password=%s length=%s" "$BILLING_PASSWORD" "${#BILLING_PASSWORD}"'];
    const runsBefore = world.vaultRuns().length;
    const running = agent.privateValues({ sessionId, args: { values: [{ name: "BILLING_PASSWORD", command: world.vaultRead("billing/password") }], run: { command: program } } }).then((reply) => { agentSaw.push(JSON.stringify(reply)); return reply; });
    await user.see(approvalCard, { timeoutMs: 30_000 });
    const card = await cardText();
    const shownUse = (await cardLines("session-computer-credential-use")).join(" ");
    const into = await cardLines("session-computer-credential-field");
    await user.screenshot();
    await user.click({ testId: "session-computer-credential-allow" });
    const ran = await running;
    const output = String(ran.output ?? "");
    evidence.recordAssertionEvidence(
      "A program gets the value in its environment after the person approves the exact command, and the agent reads its output with the value hidden",
      `card: "${card.slice(0, 160)}"; command shown: ${JSON.stringify(shownUse.slice(0, 120))}; rows: ${into.join(" / ")}; the agent got ok=${ran.ok} exit=${String(ran.exitCode)} output=${JSON.stringify(output)}; `
        + `the password is ${world.password.length} characters; vault runs for this: ${world.vaultRuns().slice(runsBefore).join(" | ")}`,
      ran.ok === true && output === `password=[secret] length=${world.password.length}` && !card.includes(world.password),
    );
    expect(card).toContain("Run this command with a private value?");
    expect(shownUse).toContain("/bin/sh -c");
    expect(shownUse).toContain("$BILLING_PASSWORD");
    expect(into.join(" ")).toContain("As $BILLING_PASSWORD");
    expect(card).not.toContain(world.password);
    expect(ran).toMatchObject({ ok: true, exitCode: 0 });
    expect(output).toBe(`password=[secret] length=${world.password.length}`);
    expect(JSON.stringify(ran)).not.toContain(world.password);
    expect(world.vaultRuns().slice(runsBefore)).toEqual(["read billing/password"]);
    await user.notSee(approvalCard, { timeoutMs: 3_000 });
  });

  const BILLING_EMAIL = "Billing contact email";
  const BILLING_PASSWORD = "Billing password";
  const countOf = async (selector: string) => (await probe.dom(selector)).elements.length;
  const rowsBy = (source: "paste" | "kept" | "command") => countOf(`[data-testid="session-computer-credential-fill"][data-source="${source}"]`);
  const fillWaits = () => countOf('[data-testid="session-computer-credential-allow"]:disabled');
  /** A fresh copy of the sign-in page, signed out, as the agent would reach it. */
  const freshForm = async () => {
    const moved = await browser("navigate", { tabId, url: `${world.signInUrl}?visit=${Math.random().toString(36).slice(2, 8)}` });
    if (!moved.ok) throw new Error(`The sign-in page could not be opened again: ${moved.code ?? "no code"}`);
    await probe.eventually(() => browser("observe", { tabId }), {
      within: 30_000, label: "the sign-in page is signed out again", until: (reply) => reply.ok && reply.elements?.some((element) => element.type === "password" && element.filled !== true) === true,
    });
    return fields();
  };

  await step("before: the person's contact email is in no vault and OpenWork has never held it, so when the agent's shell prints it, the model receives it", async () => {
    const turn = await askAboutNote("What does the contact note say?", "contact");
    evidence.recordAssertionEvidence(
      "A value nobody has pasted yet reaches the model as it is",
      `requests the model received for this turn: ${turn.requests.length}, of which after the shell ran: ${turn.afterTool.length}; requests containing the contact email (the vault's email and password are already replaced): ${turn.carrying}`,
      turn.afterTool.length > 0 && turn.carrying > 0,
    );
    await user.screenshot();
    expect(turn.afterTool.length).toBeGreaterThan(0);
    expect(turn.carrying).toBeGreaterThan(0);
  });

  await step("after: the agent asks for two values by name; the card has a private field for each, Fill waits for both, and what the person pastes signs them in without running anything", async () => {
    const form = await freshForm();
    const runsBefore = world.vaultRuns().length;
    const signInsBefore = world.received().signIns.length;
    const asking = browser("act", { tabId, observationId: form.observationId, actions: [
      { type: "fill_from", ref: form.email, ask: BILLING_EMAIL },
      { type: "fill_from", ref: form.password, ask: BILLING_PASSWORD },
    ] });
    await user.see(approvalCard, { timeoutMs: 30_000 });
    const title = (await cardLines("session-computer-credential-title")).join("");
    const names = await cardLines("session-computer-credential-ask");
    const into = await cardLines("session-computer-credential-field");
    const empty = { pasteRows: await rowsBy("paste"), commands: await countOf('[data-testid="session-computer-credential-command"]'), always: await countOf('[data-testid="session-computer-credential-always"]'), waits: await fillWaits() };
    await user.type({ testId: "session-computer-credential-paste", nth: 0 }, world.pastedEmail, { sensitive: true });
    const half = await fillWaits();
    await user.type({ testId: "session-computer-credential-paste", nth: 1 }, world.password, { sensitive: true });
    await user.click({ testId: "session-computer-credential-keep", nth: 1 });
    const ready = await fillWaits();
    const card = await cardText();
    await user.screenshot();
    await user.click({ testId: "session-computer-credential-allow" });
    const filled = await asking;
    const received = await probe.eventually(async () => world.received(), {
      within: 20_000, label: "the pasted sign-in reaches the site", until: (state) => state.signIns.length === signInsBefore + 1,
    });
    const outcomes = stepOutcomes(filled.steps);
    const carriedEmail = world.latestSignInCarriedPastedEmail();
    evidence.recordAssertionEvidence(
      "Pasted values go from the card to the page; the agent named them and got only outcomes",
      `card: "${title}"; names shown: ${names.join(" / ")}; fields: ${into.join(" / ")}; private paste fields: ${empty.pasteRows}, commands on the card: ${empty.commands}, "Always" offered: ${empty.always === 1}; `
        + `Fill disabled with nothing pasted: ${empty.waits === 1}, with one of two pasted: ${half === 1}, with both: ${ready === 1}; the card's text held a pasted value: ${card.includes(world.pastedEmail) || card.includes(world.password)}. `
        + `The agent got ok=${filled.ok}, steps: ${outcomes.join(", ")}; the site's sign-in carried the pasted email: ${carriedEmail}, the pasted password: ${received.signIns.at(-1)?.carriedSecret}; vault runs during this fill: ${world.vaultRuns().length - runsBefore}`,
      filled.ok === true && carriedEmail && received.signIns.at(-1)?.carriedSecret === true && world.vaultRuns().length === runsBefore,
    );
    expect(title).toContain("Fill these 2 fields on");
    expect(names).toEqual([BILLING_EMAIL, BILLING_PASSWORD]);
    expect(into).toEqual(["Into an email field", "Into a password field"]);
    expect(empty).toEqual({ pasteRows: 2, commands: 0, always: 0, waits: 1 });
    expect([half, ready]).toEqual([1, 0]);
    expect(card).not.toContain(world.pastedEmail);
    expect(card).not.toContain(world.password);
    expect(filled).toMatchObject({ ok: true });
    expect(outcomes).toEqual(["fill_from verified", "fill_from verified"]);
    expect(received.signIns.at(-1)).toEqual({ carriedSecret: true });
    expect(carriedEmail).toBe(true);
    expect(world.vaultRuns()).toHaveLength(runsBefore);
    await user.notSee(approvalCard, { timeoutMs: 3_000 });
  });

  await step("after: now that the person has pasted the contact email, the same shell output reaches the model with it replaced, in this turn and in the earlier one", async () => {
    const since = new Date(Date.now() - 1_000).toISOString();
    const turn = await askAboutNote("Read the contact note again.", "contact");
    const all = await world.modelRequestsSince(since);
    const allCarrying = all.filter((request) => request.privateSentinelSeen).length;
    evidence.recordAssertionEvidence(
      "A pasted value is held like one a command printed: no later request to the model carries it",
      `requests the model received for this turn: ${turn.requests.length}, of which after the shell ran: ${turn.afterTool.length}; containing the contact email, the vault's email or the password: ${turn.carrying}. `
        + `Every request the model received since, for anything: ${all.length}; containing any of them: ${allCarrying}. These requests include the turn before the paste, where the model did receive the contact email.`,
      turn.afterTool.length > 0 && turn.carrying === 0 && allCarrying === 0,
    );
    await user.screenshot();
    expect(turn.afterTool.length).toBeGreaterThan(0);
    expect(turn.carrying).toBe(0);
    expect(allCarrying).toBe(0);
  });

  await step("after: asked again in this chat, the password the person chose to keep fills with one click and nothing to paste, while the email they did not keep has to be pasted again", async () => {
    const form = await freshForm();
    const signInsBefore = world.received().signIns.length;
    const again = browser("act", { tabId, observationId: form.observationId, action: { type: "fill_from", ref: form.password, ask: BILLING_PASSWORD } });
    await user.see(approvalCard, { timeoutMs: 30_000 });
    const keptCard = { kept: await rowsBy("kept"), paste: await rowsBy("paste"), waits: await fillWaits(), into: await cardLines("session-computer-credential-field") };
    await user.screenshot();
    await user.click({ testId: "session-computer-credential-allow" });
    const filled = await again;
    const received = await probe.eventually(async () => world.received(), {
      within: 20_000, label: "the kept password reaches the site", until: (state) => state.signIns.length === signInsBefore + 1,
    });
    await user.notSee(approvalCard, { timeoutMs: 3_000 });
    const next = await freshForm();
    const email = browser("act", { tabId, observationId: next.observationId, action: { type: "fill_from", ref: next.email, ask: BILLING_EMAIL } });
    await user.see(approvalCard, { timeoutMs: 30_000 });
    const emailCard = { kept: await rowsBy("kept"), paste: await rowsBy("paste"), waits: await fillWaits() };
    await user.click({ testId: "session-computer-credential-dismiss" });
    const declined = await email;
    evidence.recordAssertionEvidence(
      "Keeping is per value and the person's choice: the kept one still asks, but needs no pasting",
      `password card: rows from what was kept: ${keptCard.kept}, private paste fields: ${keptCard.paste}, Fill disabled: ${keptCard.waits === 1}, "${keptCard.into.join(" / ")}"; after one click the agent got ok=${filled.ok} and the site's sign-in carried the real password: ${received.signIns.at(-1)?.carriedSecret}. `
        + `Email card (not kept): rows from what was kept: ${emailCard.kept}, private paste fields: ${emailCard.paste}, Fill disabled: ${emailCard.waits === 1}; after Don't fill the agent got ok=${declined.ok} code=${declined.code}`,
      filled.ok === true && received.signIns.at(-1)?.carriedSecret === true && keptCard.kept === 1 && keptCard.paste === 0 && emailCard.paste === 1 && declined.code === "credential_declined",
    );
    expect(keptCard).toEqual({ kept: 1, paste: 0, waits: 0, into: ["Into a password field, from what you kept for this chat"] });
    expect(filled).toMatchObject({ ok: true });
    expect(received.signIns.at(-1)).toEqual({ carriedSecret: true });
    expect(emailCard).toEqual({ kept: 0, paste: 1, waits: 1 });
    expect(declined).toMatchObject({ ok: false, code: "credential_declined" });
    await user.notSee(approvalCard, { timeoutMs: 3_000 });
  });

  await step("after: a program needs a key the person pastes and keeps; asked again in other words for another script there is nothing to paste, the card says the model never sees it, and after Always for this program a third script runs without a card", async () => {
    const apiKey = `made-up-api-key-${world.password.length}-7f3c91e2`;
    const script = (label: string) => ["/bin/sh", "-c", `printf "${label} key=%s length=%s" "$EXAMPLE_API_KEY" "\${#EXAMPLE_API_KEY}"`];
    const run = (ask: string, label: string) => agent.privateValues({ sessionId, args: { values: [{ name: "EXAMPLE_API_KEY", ask }], run: { command: script(label) } } })
      .then((reply) => { agentSaw.push(JSON.stringify(reply)); return reply; });
    const always = () => cardLines("session-computer-credential-always");
    const unseen = async () => (await cardLines("session-computer-credential-unseen")).join(" ");

    const first = run("Example API key", "first");
    await user.see(approvalCard, { timeoutMs: 30_000 });
    const firstCard = { paste: await rowsBy("paste"), kept: await rowsBy("kept"), always: await always(), unseen: await unseen() };
    await user.type({ testId: "session-computer-credential-paste" }, apiKey, { sensitive: true });
    await user.click({ testId: "session-computer-credential-keep" });
    await user.screenshot();
    await user.click({ testId: "session-computer-credential-allow" });
    const one = await first;
    await user.notSee(approvalCard, { timeoutMs: 3_000 });

    const second = run("Example API key (one of ours, same as before)", "second");
    await user.see(approvalCard, { timeoutMs: 30_000 });
    const secondCard = { paste: await rowsBy("paste"), kept: await rowsBy("kept"), always: await always(), unseen: await unseen(), into: await cardLines("session-computer-credential-field") };
    await user.screenshot();
    await user.click({ testId: "session-computer-credential-always" });
    const two = await second;
    await user.notSee(approvalCard, { timeoutMs: 3_000 });

    const three = await run("The Example API key again", "third");
    const cardsAfter = await countOf('[data-testid="session-computer-request"]');
    const outputs = [one, two, three].map((reply) => String(reply.output ?? ""));
    const hidden = (label: string) => `${label} key=[secret] length=${apiKey.length}`;
    evidence.recordAssertionEvidence(
      "A key pasted once and kept is found again under its NAME however the agent words it, the card says the model never sees it, and Always for this program stops the repeated cards",
      `first card: private paste fields: ${firstCard.paste}, kept rows: ${firstCard.kept}, Always offered: ${firstCard.always.length === 1}, "${firstCard.unseen}"; `
        + `second card, asked for in other words: private paste fields: ${secondCard.paste}, kept rows: ${secondCard.kept}, "${secondCard.into.join(" / ")}", button "${secondCard.always.join("")}", "${secondCard.unseen}"; `
        + `third script: cards on screen: ${cardsAfter}; the agent got ${JSON.stringify(outputs)}; a reply held the key: ${[one, two, three].some((reply) => JSON.stringify(reply).includes(apiKey))}`,
      outputs.join("|") === ["first", "second", "third"].map(hidden).join("|") && secondCard.paste === 0 && cardsAfter === 0,
    );
    expect(firstCard).toEqual({ paste: 1, kept: 0, always: [], unseen: "The model never sees this value." });
    expect(secondCard).toEqual({ paste: 0, kept: 1, always: ["Always for this program in this chat"], into: ["As $EXAMPLE_API_KEY, from what you kept for this chat"],
      unseen: "The model never sees this value. Always covers any command that starts with sh with this value in this chat." });
    expect(cardsAfter).toBe(0);
    expect(outputs).toEqual(["first", "second", "third"].map(hidden));
    expect(JSON.stringify([one, two, three])).not.toContain(apiKey);
  });

  const VAULT_KEY = "Vault session key";
  const keyRows = (source: "paste" | "kept") => countOf(`[data-testid="session-computer-credential-fill"][data-row="key"][data-source="${source}"]`);
  const pasteFields = () => countOf('[data-testid="session-computer-credential-paste"]');
  /** Both fields from the vault that answers only with its session key, with or without saying which variable the key goes in. */
  const signInWithLockedVault = (form: Awaited<ReturnType<typeof fields>>, withKey: boolean) => {
    const unlock = withKey ? { unlock: { env: world.vaultSessionEnv, ask: VAULT_KEY } } : {};
    return browser("act", { tabId, observationId: form.observationId, actions: [
      { type: "fill_from", ref: form.email, command: world.vaultReadLocked("billing/email"), ...unlock },
      { type: "fill_from", ref: form.password, command: world.vaultReadLocked("billing/password"), ...unlock },
    ] });
  };

  await step("before: the person's vault is locked, so its command alone fails, nothing is typed, and the agent is told only what the vault complained about", async () => {
    const form = await freshForm();
    const runsBefore = world.vaultRuns().length;
    const signInsBefore = world.received().signIns.length;
    const asking = signInWithLockedVault(form, false);
    await user.see(approvalCard, { timeoutMs: 30_000 });
    const card = { keyRows: await keyRows("paste") + await keyRows("kept"), pasteFields: await pasteFields() };
    await user.click({ testId: "session-computer-credential-allow" });
    const failed = await asking;
    const after = await browser("observe", { tabId });
    // The page ships its email field with an address in it, so the password field is the one that shows whether anything was typed.
    const typedAnything = after.elements?.some((element) => element.type === "password" && element.filled === true) === true;
    evidence.recordAssertionEvidence(
      "A locked vault's command fails as any command does: there is nowhere on the card to give it a key",
      `key rows on the card: ${card.keyRows}, private paste fields: ${card.pasteFields}; after Run and fill the agent got ok=${failed.ok} code=${failed.code} error=${JSON.stringify(String(failed.error ?? "").slice(0, 140))}; `
        + `vault runs during this call: ${world.vaultRuns().slice(runsBefore).join(" | ")}; the password field was filled: ${typedAnything}; sign-ins the site received: ${world.received().signIns.length - signInsBefore}`,
      failed.ok === false && failed.code === "command_failed" && !typedAnything && world.received().signIns.length === signInsBefore,
    );
    await user.screenshot();
    expect(card).toEqual({ keyRows: 0, pasteFields: 0 });
    expect(failed).toMatchObject({ ok: false, code: "command_failed" });
    expect(String(failed.error)).toContain("exit code 5");
    expect(String(failed.error)).toContain("Vault is locked");
    expect(world.vaultRuns().slice(runsBefore)[0]).toBe("read-locked billing/email");
    expect(typedAnything).toBe(false);
    expect(world.received().signIns).toHaveLength(signInsBefore);
    await user.notSee(approvalCard, { timeoutMs: 3_000 });
  });

  await step("after: the agent says which variable the vault reads its key from; the card asks the person for the key once, Run and fill waits for it, and with the key pasted both commands run and sign them in", async () => {
    const form = await freshForm();
    const runsBefore = world.vaultRuns().length;
    const signInsBefore = world.received().signIns.length;
    const asking = signInWithLockedVault(form, true);
    await user.see(approvalCard, { timeoutMs: 30_000 });
    const title = (await cardLines("session-computer-credential-title")).join("");
    const names = await cardLines("session-computer-credential-ask");
    const into = await cardLines("session-computer-credential-field");
    const empty = { commandRows: await rowsBy("command"), keyToPaste: await keyRows("paste"), pasteFields: await pasteFields(), always: await countOf('[data-testid="session-computer-credential-always"]'), waits: await fillWaits() };
    await user.type({ testId: "session-computer-credential-paste", nth: 0 }, world.vaultSessionKey, { sensitive: true });
    await user.click({ testId: "session-computer-credential-keep", nth: 0 });
    const ready = await fillWaits();
    const card = await cardText();
    await user.screenshot();
    await user.click({ testId: "session-computer-credential-allow" });
    const filled = await asking;
    const received = await probe.eventually(async () => world.received(), {
      within: 20_000, label: "the sign-in from the unlocked vault reaches the site", until: (state) => state.signIns.length === signInsBefore + 1,
    });
    const outcomes = stepOutcomes(filled.steps);
    const ran = world.vaultRuns().slice(runsBefore);
    evidence.recordAssertionEvidence(
      "The key goes from the card to the commands' environment, what they print goes to the page, and the agent named all of it without receiving any",
      `card: "${title}"; key asked for as: ${names.join(" / ")}; rows: ${into.join(" / ").replace(/Given to \S+\/vault/, "Given to …/vault")}; command rows: ${empty.commandRows}, key rows: ${empty.keyToPaste}, private paste fields: ${empty.pasteFields}, "Always" offered: ${empty.always === 1}; `
        + `Run and fill disabled before the key is pasted: ${empty.waits === 1}, after: ${ready === 1}; the card's text held the key: ${card.includes(world.vaultSessionKey)}. `
        + `The agent got ok=${filled.ok}, steps: ${outcomes.join(", ")}; vault runs: ${ran.join(" | ")}; the site's sign-in carried the real password: ${received.signIns.at(-1)?.carriedSecret}`,
      filled.ok === true && received.signIns.at(-1)?.carriedSecret === true && empty.keyToPaste === 1 && empty.waits === 1,
    );
    expect(title).toContain("Run these 2 commands and fill what they print on");
    expect(names).toEqual([VAULT_KEY]);
    expect(into.slice(0, 2)).toEqual([`Into an email field, with ${world.vaultSessionEnv} set`, `Into a password field, with ${world.vaultSessionEnv} set`]);
    expect(into[2]).toMatch(new RegExp(`^Given to /\\S+/vault as ${world.vaultSessionEnv}, for this run only$`));
    expect(empty).toEqual({ commandRows: 2, keyToPaste: 1, pasteFields: 1, always: 0, waits: 1 });
    expect(ready).toBe(0);
    expect(card).not.toContain(world.vaultSessionKey);
    expect(filled).toMatchObject({ ok: true });
    expect(outcomes).toEqual(["fill_from verified", "fill_from verified"]);
    expect(ran).toEqual(["read-locked billing/email", "read-locked billing/password"]);
    expect(received.signIns.at(-1)).toEqual({ carriedSecret: true });
    await user.notSee(approvalCard, { timeoutMs: 3_000 });
  });

  await step("after: asked again in this chat, the key the person chose to keep unlocks the vault with one click and nothing to paste", async () => {
    const form = await freshForm();
    const runsBefore = world.vaultRuns().length;
    const signInsBefore = world.received().signIns.length;
    const again = signInWithLockedVault(form, true);
    await user.see(approvalCard, { timeoutMs: 30_000 });
    const keptCard = { keyKept: await keyRows("kept"), keyToPaste: await keyRows("paste"), pasteFields: await pasteFields(), always: await countOf('[data-testid="session-computer-credential-always"]'), waits: await fillWaits() };
    const keyLine = (await cardLines("session-computer-credential-field")).at(-1) ?? "";
    await user.screenshot();
    await user.click({ testId: "session-computer-credential-allow" });
    const filled = await again;
    const received = await probe.eventually(async () => world.received(), {
      within: 20_000, label: "the sign-in with the kept key reaches the site", until: (state) => state.signIns.length === signInsBefore + 1,
    });
    const ran = world.vaultRuns().slice(runsBefore);
    evidence.recordAssertionEvidence(
      "A kept key still asks before every run, but there is nothing to paste",
      `key row from what was kept: ${keptCard.keyKept}, key rows to paste: ${keptCard.keyToPaste}, private paste fields: ${keptCard.pasteFields}, Run and fill disabled: ${keptCard.waits === 1}, "Always" offered: ${keptCard.always === 1}; `
        + `key row: "${keyLine.replace(/Given to \S+\/vault/, "Given to …/vault")}"; after one click the agent got ok=${filled.ok}; vault runs: ${ran.join(" | ")}; the site's sign-in carried the real password: ${received.signIns.at(-1)?.carriedSecret}`,
      filled.ok === true && received.signIns.at(-1)?.carriedSecret === true && keptCard.keyKept === 1 && keptCard.pasteFields === 0,
    );
    expect(keptCard).toEqual({ keyKept: 1, keyToPaste: 0, pasteFields: 0, always: 0, waits: 0 });
    expect(keyLine).toMatch(/, for this run only, from what you kept for this chat$/);
    expect(filled).toMatchObject({ ok: true });
    expect(ran).toEqual(["read-locked billing/email", "read-locked billing/password"]);
    expect(received.signIns.at(-1)).toEqual({ carriedSecret: true });
    await user.notSee(approvalCard, { timeoutMs: 3_000 });
  });

  await step("after: the key is held like any other private value, so when the agent's shell prints the note it is written in, the model receives it replaced", async () => {
    const since = new Date(Date.now() - 1_000).toISOString();
    const turn = await askAboutNote("What does the session note say?", "session");
    const all = await world.modelRequestsSince(since);
    const allCarrying = all.filter((request) => request.privateSentinelSeen).length;
    evidence.recordAssertionEvidence(
      "A key pasted to unlock a vault never reaches the model either, even when a tool prints it",
      `requests the model received for this turn: ${turn.requests.length}, of which after the shell printed the key: ${turn.afterTool.length}; containing the key or any other private value: ${turn.carrying}. `
        + `Every request the model received since, for anything: ${all.length}; containing any of them: ${allCarrying}.`,
      turn.afterTool.length > 0 && turn.carrying === 0 && allCarrying === 0,
    );
    await user.screenshot();
    expect(turn.afterTool.length).toBeGreaterThan(0);
    expect(turn.carrying).toBe(0);
    expect(allCarrying).toBe(0);
  });

  await step("a command that fails types nothing and tells the agent only its exit code and first error line; no value reached the agent or the screen in the whole run", async () => {
    const form = await fields();
    const failing = browser("act", { tabId, observationId: form.observationId, action: { type: "fill_from", ref: form.password, command: world.vaultRead("billing/missing") } });
    await user.see(approvalCard, { timeoutMs: 30_000 });
    const card = await cardText();
    await user.click({ testId: "session-computer-credential-allow" });
    const failed = await failing;
    const privateValues = [world.password, world.email, world.pastedEmail, world.vaultSessionKey];
    const everLeaked = agentSaw.some((reply) => privateValues.some((value) => reply.includes(value)));
    const screen = await screenText();
    const shownOnScreen = privateValues.some((value) => screen.includes(value));
    evidence.recordAssertionEvidence(
      "A failed command is reported in OpenWork's words, and the values never reached the agent or the app's screen",
      `the new command was asked about again: ${card.includes("Run this command and fill what it prints on")}; the agent got ok=${failed.ok} code=${failed.code} error=${JSON.stringify(String(failed.error ?? "").slice(0, 120))}; `
        + `browser tool replies checked: ${agentSaw.length}, containing an email, the password or the vault's key, from a command or pasted: ${everLeaked}; any of them on the app's screen: ${shownOnScreen}; sign-ins the site received in total: ${world.received().signIns.length}`,
      failed.ok === false && failed.code === "command_failed" && !everLeaked && !shownOnScreen,
    );
    expect(card).toContain("Run this command and fill what it prints on");
    expect(failed).toMatchObject({ ok: false, code: "command_failed" });
    expect(String(failed.error)).toContain("exit code 3");
    expect(String(failed.error)).toContain("No item named billing/missing in this vault");
    expect(everLeaked).toBe(false);
    expect(shownOnScreen).toBe(false);
    expect(world.received().signIns).toHaveLength(5);
  });
});

governed("an organization's owner limits private values in Den, and the person's desktop refuses what is blocked before asking, says so in Settings, and still obeys the person's own switches", async ({ world, user, agent, probe, step, evidence }) => {
  const sessionId = world.session.sessionId;
  const admin = user.on(world.web);
  let tabId = "";
  const agentSaw: string[] = [];
  const browser = async (operation: "observe" | "act" | "navigate", args: NonNullable<Parameters<typeof agent.browserTask>[0]["args"]>) => {
    const reply = await agent.browserTask({ sessionId, operation, args });
    agentSaw.push(JSON.stringify(reply));
    return reply;
  };
  const fields = async () => {
    const observed = await browser("observe", { tabId });
    const email = observed.elements?.find((element) => element.type === "email");
    const password = observed.elements?.find((element) => element.type === "password");
    if (!email || !password || !observed.observationId) throw new Error(`The sign-in form was not observed: ${observed.code ?? "no fields"}`);
    return { observationId: observed.observationId, email: email.ref, password: password.ref };
  };
  /** Settings replaces the chat, and the card is shown in the chat. */
  const backToChat = async () => {
    await agent.run("route.session");
    await probe.eventually(() => agent.run("session.open", { sessionId }).then(() => true, () => false), { within: 30_000, label: "the chat is open again", until: Boolean });
    await user.see({ testId: "session-browser-toggle" }, { timeoutMs: 30_000 });
  };
  const freshForm = async () => {
    await backToChat();
    const moved = await browser("navigate", { tabId, url: `${world.signInUrl}?visit=${Math.random().toString(36).slice(2, 8)}` });
    if (!moved.ok) throw new Error(`The sign-in page could not be opened again: ${moved.code ?? "no code"}`);
    await probe.eventually(() => browser("observe", { tabId }), {
      within: 30_000, label: "the sign-in page is signed out again", until: (reply) => reply.ok && reply.elements?.some((element) => element.type === "password" && element.filled !== true) === true,
    });
    return fields();
  };
  const fromVault = async () => {
    const form = await freshForm();
    return browser("act", { tabId, observationId: form.observationId, actions: [
      { type: "fill_from", ref: form.email, command: world.vaultRead("billing/email") },
      { type: "fill_from", ref: form.password, command: world.vaultRead("billing/password") },
    ] });
  };
  const byPasting = async () => {
    const form = await freshForm();
    return browser("act", { tabId, observationId: form.observationId, action: { type: "fill_from", ref: form.password, ask: "Billing password" } });
  };
  const countOf = async (selector: string) => (await probe.dom(selector)).elements.length;
  const textOf = async (selector: string) => (await probe.dom(selector)).elements.map((element) => element.text.replace(/\s+/g, " ").trim());
  const cards = () => countOf('[data-testid="session-computer-request"]');
  const row = (name: string) => `[data-testid="settings-private-values-${name}"]`;
  /** Settings › Computer use, read fresh: what is on, what the organization locked, and the lists below. */
  const settings = async () => {
    await agent.run("settings.panel.open", { panel: "general" });
    await agent.run("settings.panel.open", { panel: "computer" });
    await user.see({ testId: "settings-private-values-commands" }, { timeoutMs: 30_000 });
    const names = ["commands", "paste", "keep"];
    const on: string[] = [];
    const locked: string[] = [];
    for (const name of names) {
      if (await countOf(`${row(name)} [role="switch"][aria-checked="true"]`)) on.push(name);
      if ((await textOf(row(name))).join(" ").includes("Set by your organization")) locked.push(name);
    }
    return {
      on, locked,
      commandsNote: (await textOf(row("commands"))).join(" ").includes("Some commands are set by your organization"),
      note: (await textOf(row("organization"))).join(" "),
      always: await textOf(row("always")),
      recent: await textOf(row("recent")),
      whole: (await textOf("#private-values")).join(" "),
    };
  };
  /** The desktop reads its organization's rules again within half a minute; Settings shows what it last read. */
  const settingsOnce = (label: string, until: (state: Awaited<ReturnType<typeof settings>>) => boolean) =>
    probe.eventually(settings, { within: 120_000, label, until });
  const delivered = (label: string, until: (rules: Awaited<ReturnType<typeof world.deliveredRules>>) => boolean) =>
    probe.eventually(() => world.deliveredRules(), { within: 60_000, label, until });
  const signedIn = (times: number) => probe.eventually(() => world.received().signIns.length, {
    within: 20_000, label: `the site has been signed in to ${times} times`, until: (count) => count === times,
  });
  const terminalDefault = { action: "private_value_terminal", resource: "*", effect: "deny" };
  const screenText = async () => (await probe.dom("body")).elements.map((element) => element.text).join(" ");
  /** The person asks for something; the agent runs the stand-in password manager in its own terminal, then echo. */
  const askTerminal = async (label: string) => {
    await backToChat();
    const nonce = Math.random().toString(36).slice(2, 10);
    const prompt = `${label} ${nonce}`;
    const reply = `I tried the terminal. ${nonce}`;
    const runsBefore = world.passwordManagerRuns().length;
    await world.scriptTerminalTurn(prompt, reply);
    await user.type("composer", prompt);
    await user.click("Run task");
    await probe.eventually(async () => {
      if (await probe.has("Allow once")) await user.click("Allow once");
      return screenText();
    }, { within: 150_000, label: "the agent answers", until: (text) => text.includes(reply) });
    const requests = await world.modelRequests(prompt);
    const stored = await world.storedConversation();
    return {
      ran: world.passwordManagerRuns().length - runsBefore,
      modelGotValue: requests.filter((request) => request.privateSentinelSeen).length,
      echoRan: stored.includes(`terminal-ran-${nonce}`),
      refusal: stored.includes(world.passwordManagerName) && stored.includes("was used to get a private value") && stored.includes("set for Everyone") && stored.includes("fill_from"),
    };
  };
  const saveInDen = async () => {
    await admin.click("Save changes");
    await probe.on(world.web).eventually(async () => (await probe.on(world.web).dom('[data-testid="agent-permissions-save-bar"]')).elements.length, {
      within: 30_000, label: "Den has saved the change", until: (bars) => bars === 0,
    });
  };

  await step("before: the organization has set nothing; Den's Browser tab offers the four private-value permissions, and the person's Settings show three switches that are theirs to change", async () => {
    await admin.see({ testId: "agent-permission-privateValueFills" }, { timeoutMs: 90_000 });
    await admin.see({ testId: "agent-permission-privateValueCommands" });
    await admin.see({ testId: "agent-permission-privateValuePaste" });
    await admin.see({ testId: "agent-permission-privateValueTerminal" });
    await admin.screenshot();
    await agent.run("session.open", { sessionId });
    if (await probe.has("Not now")) await user.click({ role: "button", label: "Not now" });
    await user.see({ testId: "session-browser-toggle" }, { timeoutMs: 60_000 });
    tabId = tabHandle(await agent.run("browser.open_url", { url: world.signInUrl, provider: "builtin" }));
    await probe.eventually(() => browser("observe", { tabId }), {
      within: 150_000, label: "the sign-in page offers fill_from", until: (reply) => reply.ok && reply.privateValues === "fill_from",
    });
    const state = await settingsOnce("Settings shows the three switches", (read) => read.on.length === 3);
    const rules = await world.deliveredRules();
    evidence.recordAssertionEvidence("With nothing set, every switch is the person's own",
      `switches on: ${state.on.join(", ")}; set by the organization: ${state.locked.join(", ") || "none"}; note about the organization: ${JSON.stringify(state.note)}; blocking rules Den hands this desktop: ${rules.filter((rule) => rule.effect === "deny").length}`,
      state.on.length === 3 && state.locked.length === 0);
    await user.screenshot();
    expect(state).toMatchObject({ on: ["commands", "paste", "keep"], locked: [], note: "", always: [], recent: [] });
    expect(rules.filter((rule) => rule.effect === "deny")).toEqual([terminalDefault]);
  });

  await step("after: the person signs in from their vault and chooses Always; Settings then lists both commands under Always and both fills under Recent fills, and no value", async () => {
    const asking = fromVault();
    await user.see(approvalCard, { timeoutMs: 30_000 });
    await user.click({ testId: "session-computer-credential-always" });
    const filled = await asking;
    const again = await fromVault();
    const state = await settingsOnce("Settings lists what was filled", (read) => read.recent.length >= 4);
    const shown = [world.password, world.email].some((value) => state.whole.includes(value));
    evidence.recordAssertionEvidence("Settings shows what is filled without asking and what was filled, never a value",
      `first fill ok=${filled.ok}; asked again in the chat, filled with no card ok=${again.ok}; vault runs: ${world.vaultRuns().length}; "Always" rows: ${state.always.length} (${state.always.map((line) => line.replace(/\S+\/vault/g, "…/vault")).join(" | ")}); `
        + `recent fills: ${state.recent.length}, first: "${state.recent[0]?.replace(/\S+\/vault/g, "…/vault")}"; the email or password anywhere in Settings: ${shown}`,
      filled.ok === true && again.ok === true && state.always.length === 2 && !shown);
    await user.screenshot();
    expect(filled).toMatchObject({ ok: true });
    expect(again).toMatchObject({ ok: true });
    expect(world.vaultRuns()).toHaveLength(4);
    await signedIn(2);
    expect(state.always).toHaveLength(2);
    expect(state.always.join(" ")).toContain(world.siteName);
    expect(state.always.join(" ")).toContain("vault read billing/password");
    expect(state.recent).toHaveLength(4);
    expect(state.recent.every((line) => line.includes("from a command") && line.includes("Filled"))).toBe(true);
    expect(shown).toBe(false);
  });

  await step("after: the owner turns off pasting in Den; the desktop refuses a pasted value before any card, in the organization's words, locks both paste switches in Settings, and still fills from the command", async () => {
    await admin.click({ role: "switch", label: "Paste private values in the chat" });
    await saveInDen();
    await admin.screenshot();
    const rules = await delivered("Den hands the desktop the paste rule", (read) => read.some((rule) => rule.action === "private_value_paste" && rule.effect === "deny"));
    const state = await settingsOnce("Settings locks pasting", (read) => read.locked.includes("paste"));
    await user.screenshot();
    const signInsBefore = world.received().signIns.length;
    const refused = await byPasting();
    const asked = await cards();
    const stillFills = await fromVault();
    evidence.recordAssertionEvidence("A value the organization does not let people paste is refused before the person is asked",
      `rule delivered: ${JSON.stringify(rules.filter((rule) => rule.action === "private_value_paste"))}; Settings locked: ${state.locked.join(", ")}, on: ${state.on.join(", ")}; `
        + `fill_from with ask answered ok=${refused.ok} code=${refused.code} error=${JSON.stringify(String(refused.error ?? "").slice(0, 170))}; cards shown: ${asked}; the same fields from the command: ok=${stillFills.ok}`,
      refused.code === "value_paste_blocked" && asked === 0 && stillFills.ok === true);
    expect(state.locked).toEqual(["paste", "keep"]);
    expect(state.on).toEqual(["commands"]);
    expect(refused).toMatchObject({ ok: false, code: "value_paste_blocked" });
    expect(String(refused.error)).toContain("organization");
    expect(String(refused.error)).toContain("Nothing was run or typed.");
    expect(asked).toBe(0);
    expect(stillFills).toMatchObject({ ok: true });
    await signedIn(signInsBefore + 1);
  });

  await step("after: the owner blocks the vault's command in Den; the Always the person gave no longer runs it, and Settings marks it blocked by the organization", async () => {
    await admin.click({ testId: "agent-permission-privateValueCommands-block-add" });
    await admin.type({ testId: "agent-permission-privateValueCommands-block-input" }, "vault read *");
    await admin.press("Enter");
    await saveInDen();
    await admin.screenshot();
    await delivered("Den hands the desktop the command rule", (read) => read.some((rule) => rule.action === "private_value_command" && rule.effect === "deny" && rule.resource === "vault read *"));
    const state = await settingsOnce("Settings marks the Always as blocked", (read) => read.always.length === 2 && read.always.every((line) => line.includes("Blocked by your organization")));
    await user.screenshot();
    const runsBefore = world.vaultRuns().length;
    const signInsBefore = world.received().signIns.length;
    const refused = await fromVault();
    const asked = await cards();
    evidence.recordAssertionEvidence("A command the organization blocks is not run, even where the person had said Always",
      `Settings: commands switch says some commands are set by the organization: ${state.commandsNote}; "Always" rows marked blocked: ${state.always.filter((line) => line.includes("Blocked by your organization")).length} of ${state.always.length}; `
        + `fill_from answered ok=${refused.ok} code=${refused.code} error=${JSON.stringify(String(refused.error ?? "").replace(/\S+\/vault/g, "…/vault").slice(0, 170))}; cards shown: ${asked}; vault runs since: ${world.vaultRuns().length - runsBefore}; sign-ins since: ${world.received().signIns.length - signInsBefore}`,
      refused.code === "value_command_blocked" && asked === 0 && world.vaultRuns().length === runsBefore);
    expect(state.commandsNote).toBe(true);
    expect(state.locked).toEqual(["paste", "keep"]);
    expect(refused).toMatchObject({ ok: false, code: "value_command_blocked" });
    expect(String(refused.error)).toContain("organization");
    expect(asked).toBe(0);
    expect(world.vaultRuns()).toHaveLength(runsBefore);
    expect(world.received().signIns).toHaveLength(signInsBefore);
  });

  await step("after: the owner blocks the billing site in Den; a fill there is refused for the site itself, and Settings says the organization limits the websites", async () => {
    await admin.click({ testId: "agent-permission-privateValueFills-block-add" });
    await admin.type({ testId: "agent-permission-privateValueFills-block-input" }, "billing.localhost");
    await admin.press("Enter");
    await saveInDen();
    await admin.screenshot();
    await delivered("Den hands the desktop the website rule", (read) => read.some((rule) => rule.action === "private_value_fill" && rule.effect === "deny" && rule.resource === "billing.localhost"));
    const state = await settingsOnce("Settings says websites are limited", (read) => read.note.includes("limits the websites"));
    await user.screenshot();
    const runsBefore = world.vaultRuns().length;
    const refused = await fromVault();
    const asked = await cards();
    evidence.recordAssertionEvidence("A website the organization blocks is refused before commands or pasting are considered",
      `Settings note: ${JSON.stringify(state.note)}; fill_from answered ok=${refused.ok} code=${refused.code} error=${JSON.stringify(String(refused.error ?? "").slice(0, 170))}; cards shown: ${asked}; vault runs since: ${world.vaultRuns().length - runsBefore}`,
      refused.code === "values_blocked" && asked === 0 && world.vaultRuns().length === runsBefore);
    expect(state.note).toBe("Your organization limits the websites private values can be filled on.");
    expect(refused).toMatchObject({ ok: false, code: "values_blocked" });
    expect(String(refused.error)).toContain("organization");
    expect(asked).toBe(0);
    expect(world.vaultRuns()).toHaveLength(runsBefore);
  });

  await step("after: with the organization's rules removed, the person takes back their Always and is asked again, then turns commands off themselves and the agent is told the person did", async () => {
    await world.clearRules();
    await delivered("Den hands the desktop no blocking rule but the terminal default", (read) => read.every((rule) => rule.effect !== "deny" || rule.action === "private_value_terminal"));
    await settingsOnce("Settings unlocks", (read) => read.locked.length === 0 && read.note === "" && read.always.length === 2 && read.always.every((line) => !line.includes("Blocked by your organization")));
    await user.click({ testId: "settings-private-values-always-remove" });
    await probe.eventually(() => countOf(row("always")), { within: 15_000, label: "one Always is removed", until: (count) => count === 1 });
    await user.click({ testId: "settings-private-values-always-remove" });
    await probe.eventually(() => countOf(row("always")), { within: 15_000, label: "no Always is left", until: (count) => count === 0 });
    const runsBefore = world.vaultRuns().length;
    const asking = fromVault();
    await user.see(approvalCard, { timeoutMs: 30_000 });
    await user.click({ testId: "session-computer-credential-dismiss" });
    const declined = await asking;
    await settingsOnce("Settings is open again", (read) => read.on.includes("commands"));
    await user.click({ role: "switch", label: "Get values from commands" });
    const off = await settingsOnce("the person's commands switch is off", (read) => !read.on.includes("commands"));
    await user.screenshot();
    const refused = await fromVault();
    const asked = await cards();
    const last = await settingsOnce("Settings records the refusals", (read) => read.recent.some((line) => line.includes("Turned off here")));
    const leaked = agentSaw.some((reply) => [world.password, world.email].some((value) => reply.includes(value)));
    evidence.recordAssertionEvidence("The person's own switch is obeyed, and the agent is told it was the person, not the organization",
      `after removing both Always rows the card came back: code=${declined.code}; switches on after turning commands off: ${off.on.join(", ")}, locked: ${off.locked.join(", ") || "none"}; `
        + `fill_from answered ok=${refused.ok} code=${refused.code} error=${JSON.stringify(String(refused.error ?? "").slice(0, 150))}; cards shown: ${asked}; vault runs since: ${world.vaultRuns().length - runsBefore}; `
        + `recent fills by result: ${["Filled", "Blocked by your organization", "You said no", "Turned off here"].map((result) => `${result} ${last.recent.filter((line) => line.includes(result)).length}`).join(", ")}; a value in any browser tool reply: ${leaked}`,
      declined.code === "credential_declined" && refused.code === "value_commands_off" && asked === 0 && !leaked);
    await user.screenshot();
    expect(declined).toMatchObject({ ok: false, code: "credential_declined" });
    expect(off.locked).toEqual([]);
    expect(off.on).toEqual(["paste", "keep"]);
    expect(refused).toMatchObject({ ok: false, code: "value_commands_off" });
    expect(String(refused.error)).toContain("The person turned off");
    expect(String(refused.error)).not.toContain("organization");
    expect(asked).toBe(0);
    expect(world.vaultRuns()).toHaveLength(runsBefore);
    expect(last.recent.some((line) => line.includes("Blocked by your organization"))).toBe(true);
    expect(last.recent.some((line) => line.includes("You said no"))).toBe(true);
    expect(leaked).toBe(false);
  });

  await step("after: the owner reads in Den's audit log who filled what, on which site, from where, and what the person or the organization refused, with no value in any of it", async () => {
    const read = () => Promise.all([world.auditedFills("private_value.filled"), world.auditedFills("private_value.fill_declined"), world.auditedFills("private_value.fill_refused")]);
    const [filled, declined, refused] = await probe.eventually(read, {
      within: 60_000, label: "the desktop's reports are in the audit log", until: ([f, d, r]) => f.length >= 6 && d.length >= 2 && r.length >= 3,
    });
    const all = [...filled, ...declined, ...refused].join("\n");
    const leaked = [world.password, world.email].some((value) => all.includes(value));
    evidence.recordAssertionEvidence("Each fill is in the organization's audit log, never its value",
      `filled events: ${filled.length}; declined by the person: ${declined.length}; refused by the organization: ${refused.length}; `
        + `a filled event names the site: ${filled.some((event) => event.includes(world.siteName))}; names the program vault: ${filled.some((event) => event.includes('"vault"'))}; the email or password in any event: ${leaked}`,
      filled.length >= 6 && declined.length >= 2 && refused.length >= 3 && !leaked);
    expect(filled.length).toBeGreaterThanOrEqual(6);
    expect(declined.length).toBeGreaterThanOrEqual(2);
    expect(refused.length).toBeGreaterThanOrEqual(3);
    expect(filled.some((event) => event.includes(world.siteName))).toBe(true);
    expect(leaked).toBe(false);
  });

  await step("after: once the agent names a program no list knows as the source of a value, even in a fill that is refused, the agent's own terminal refuses that program and tells the agent to fill instead; an ordinary command still runs, and the model never receives what the program holds", async () => {
    const rules = await world.deliveredRules();
    const form = await freshForm();
    const declined = await browser("act", { tabId, observationId: form.observationId, action: { type: "fill_from", ref: form.password, command: world.passwordManagerCommand } });
    const tried = await askTerminal(`Get the billing password from ${world.passwordManagerName}.`);
    evidence.recordAssertionEvidence("A program named as a private-value source is kept out of the agent's own terminal by default, whatever its name",
      `program: ${world.passwordManagerName} (on no list); fill_from with it answered ${declined.code}; terminal rule Den hands the desktop: ${JSON.stringify(rules.filter((rule) => rule.action === "private_value_terminal"))}; engine: ${world.engine}; `
        + `times it ran: ${tried.ran}; the agent was told it is fill-only and to use fill_from: ${tried.refusal}; echo ran: ${tried.echoRan}; model requests carrying its value: ${tried.modelGotValue}`,
      declined.code === "value_commands_off" && tried.ran === 0 && tried.refusal && tried.echoRan && tried.modelGotValue === 0);
    await user.screenshot();
    expect(declined).toMatchObject({ ok: false, code: "value_commands_off" });
    expect(rules.filter((rule) => rule.action === "private_value_terminal")).toEqual([terminalDefault]);
    expect(tried).toEqual({ ran: 0, modelGotValue: 0, echoRan: true, refusal: true });
  });

  await step("after: the owner lets private-value programs into the agent's terminal in Den; the same command then runs, which shows the default block was what kept the value from the model", async () => {
    await admin.click({ role: "switch", label: "Let the agent run its private-value programs in its own terminal" });
    await saveInDen();
    await admin.screenshot();
    await delivered("Den hands the desktop the terminal Allow", (read) => read.some((rule) => rule.action === "private_value_terminal" && rule.effect === "allow"));
    const tried = await probe.eventually(() => askTerminal(`Get the billing password from ${world.passwordManagerName} again.`), {
      within: 180_000, label: "the desktop has read the Allow", until: (result) => result.ran > 0,
    });
    evidence.recordAssertionEvidence("An administrator's Allow lifts the terminal block",
      `times it ran: ${tried.ran}; echo ran: ${tried.echoRan}; model requests carrying the manager's value: ${tried.modelGotValue}`,
      tried.ran === 1 && tried.echoRan && tried.modelGotValue > 0);
    await user.screenshot();
    expect(tried.ran).toBe(1);
    expect(tried.echoRan).toBe(true);
    expect(tried.modelGotValue).toBeGreaterThan(0);
  });
});

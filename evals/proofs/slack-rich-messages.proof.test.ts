import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { slackRichMessagesWorld } from "../worlds/slack-rich-messages.ts";

const test = spec.world(slackRichMessagesWorld, {
  timeout: 900_000,
  resources: { surfaces: ["web"], services: ["den"] },
  needs: { commands: ["bun", "python3"] },
});

type Body = Record<string, unknown>;

const ISSUES = [
  ["[ACME-214 Export times out](https://linear.app/acme/issue/ACME-214)", "Dana", "Urgent", "9"],
  ["[ACME-221 Invoice totals round up](https://linear.app/acme/issue/ACME-221)", "Lee", "High", "6"],
  ["ACME-230 Slow search on large workspaces", "Sam", "Medium", "4"],
  ["ACME-233 Dark mode contrast", "Riley", "Low", "2"],
];
const TYPED_TABLE = ["Issue | Owner | Priority | Days open", ...ISSUES.map((row) => row.join(" | ").replace(/\[([^\]]+)\]\([^)]+\)/, "$1"))].join("\n");

const statusReport: Body = {
  target: "me",
  text: "Open issues this week: 4 open, 2 need you before Friday.",
  components: [
    { type: "header", text: "Open issues" },
    { type: "table", columns: ["Issue", "Owner", "Priority", "Days open"], rows: ISSUES },
    { type: "context", text: "From Linear, read Nov 27 at 9:02 AM" },
    { type: "buttons", buttons: [{ text: "Open the board", url: "https://linear.app/acme/team/ACME/active" }] },
  ],
};
const meetingFollowUp: Body = {
  target: "me",
  text: "Follow-up from the Northwind renewal call: they want the security review by Dec 4 and agreed to a two-year term.",
  components: [
    { type: "header", text: "Northwind renewal call" },
    { type: "fields", fields: [{ label: "When", value: "Fri Nov 27, 10:00 AM" }, { label: "Decision", value: "Two-year term, pending security review" }, { label: "Attendees", value: "Alex, Dana and two from Northwind" }, { label: "Next meeting", value: "Tue Dec 8" }] },
    { type: "divider" },
    { type: "table", columns: ["Action item", "Owner", "Due"], rows: [["Send the security questionnaire answers", "Dana", "Dec 2"], ["Draft the two-year order form", "Alex", "Dec 3"], ["Confirm SSO requirements with their IT lead", "Lee", "Dec 4"]] },
    { type: "context", text: "From the meeting notes and the calendar invite" },
  ],
};
const automationResult: Body = {
  target: "me",
  text: "Your weekly signups digest finished: 468 signups, up 14% on last week.",
  components: [
    { type: "fields", fields: [{ label: "This week", value: "468" }, { label: "Last week", value: "412" }, { label: "Change", value: "+14%" }, { label: "Top source", value: "Docs (38%)" }] },
    { type: "context", text: "Weekly signups digest, ran Mon Nov 23 at 9:00 AM" },
    { type: "buttons", buttons: [{ text: "Open in OpenWork", open: "automations" }] },
  ],
};
const needsConnection: Body = {
  target: "me",
  text: "Your pipeline report didn't run: Google Sheets needs you to sign in again. Nothing was changed.",
  components: [
    { type: "context", text: "Pipeline report, stopped Mon Nov 23 at 9:00 AM" },
    { type: "buttons", buttons: [{ text: "Reconnect in OpenWork", open: "connections" }] },
  ],
};
const unsafe: Body = {
  target: "me",
  text: "Chart for the review, cc <@U0SOMEONE>.",
  components: [
    { type: "header", text: "Heads up @channel" },
    { type: "context", text: "cc <!here> and <@U0SOMEONE>" },
    { type: "image", url: "https://charts.example.com/signups.png?token=private", alt: "Signups by week" },
  ],
};

test("a member's agent sends a status table, a meeting follow-up and an Automation result to Slack as real components", async ({ world, user, probe, step, evidence }) => {
  const alex = user.on(world.alexBrowser), riley = user.on(world.rileyBrowser);
  const alexSlack = probe.on(world.alexBrowser);
  const dom = async (selector: string) => (await alexSlack.dom(selector)).elements.length;
  const shown = (text: string) => probe.eventually(() => alexSlack.text(), { within: 30_000, label: `Slack shows "${text}"`, until: (value) => value.includes(text) });
  const send = (body: Body) => world.send("alex", body);
  const input = (body: Body) => JSON.stringify(body);

  await step("given Alex connects Slack in a sandbox organization where the OpenWork app is installed", async () => {
    await alex.navigate(await world.oauthStart("alex"));
    await alex.click({ role: "button", label: "Allow workplace access" });
    await alex.click({ role: "button", label: "Continue" });
    const connected = await probe.eventually(() => world.slackConnected("alex"), { within: 60_000, label: "Alex's Slack is connected", until: Boolean });
    evidence.recordAssertionEvidence("Alex's own Slack account is linked to OpenWork", `connected=${connected}`, connected);
    expect(connected).toBe(true);
    await alex.navigate(world.slackPage);
    await alex.see({ role: "heading", label: "Workbot" }, { timeoutMs: 30_000 });
  });

  await step("before: with the feature off the agent can only send text, so a table arrives as typed characters", async () => {
    const offered = await world.offeredArguments("alex");
    const refused = await send(statusReport);
    const sent = await send({ target: "me", text: `Open issues this week: 4 open, 2 need you before Friday.\n\`\`\`\n${TYPED_TABLE}\n\`\`\`` });
    await shown("Issue | Owner | Priority | Days open");
    const ok = !offered.includes("components") && refused.error === "invalid_capability_arguments" && sent.sent === true && (await dom(".bk-table")) === 0;
    evidence.recordAssertionEvidence("With the feature off, components are neither offered nor accepted", `arguments offered: ${offered.join(", ")}; components -> ${String(refused.error)}; text sent=${String(sent.sent)}; tables on the page=${await dom(".bk-table")}`, ok);
    expect(ok).toBe(true);
    await alex.screenshot();
  });

  await step("when the platform admin turns on Slack components for the organization", async () => {
    await world.turnOnRichMessages();
    const offered = await probe.eventually(() => world.offeredArguments("alex"), { within: 60_000, label: "the agent is offered components", until: (value) => value.includes("components") });
    evidence.recordAssertionEvidence("The agent's tool now lists components", `arguments offered: ${offered.join(", ")}`, offered.includes("components"));
    expect(offered).toContain("components");
  });

  await step("after: with the feature on the same status report arrives with a header, a real table, a source line and a button", async () => {
    const sent = await send(statusReport);
    await shown("From Linear, read Nov 27 at 9:02 AM");
    const counts = { header: await dom(".bk-header"), table: await dom(".bk-table"), rows: await dom(".bk-table tbody tr"), links: await dom('.bk-table a[href^="https://linear.app/"]'), button: await dom('a.bk-button[href="https://linear.app/acme/team/ACME/active"]') };
    const ok = sent.sent === true && counts.header === 1 && counts.table === 1 && counts.rows === 4 && counts.links === 2 && counts.button === 1;
    evidence.recordAssertionEvidence("The sample Slack accepted the blocks and drew a four-row table with two linked issues", `input: ${input(statusReport)} -> sent=${String(sent.sent)}; ${JSON.stringify(counts)}`, ok);
    expect(ok).toBe(true);
    await alex.screenshot();
  });

  await step("after: a meeting follow-up shows the facts in two columns and the action items with owners", async () => {
    const sent = await send(meetingFollowUp);
    await shown("From the meeting notes and the calendar invite");
    const counts = { fields: await dom(".bk-fields > div"), tables: await dom(".bk-table"), dividers: await dom(".bk-divider") };
    const ok = sent.sent === true && counts.fields === 4 && counts.tables === 2 && counts.dividers === 1;
    evidence.recordAssertionEvidence("Four facts, a divider and a three-row action table", `input: ${input(meetingFollowUp)} -> sent=${String(sent.sent)}; ${JSON.stringify(counts)}`, ok);
    expect(ok).toBe(true);
    await alex.screenshot();
  });

  await step("after: an Automation result ends with one button that opens Automations in OpenWork", async () => {
    const sent = await send(automationResult);
    await shown("Weekly signups digest, ran Mon Nov 23 at 9:00 AM");
    const target = new URL("/dashboard/automations", world.den.ref.webUrl).toString();
    const buttons = await dom(`a.bk-button[href="${target}"]`);
    const ok = sent.sent === true && buttons === 1;
    evidence.recordAssertionEvidence("The agent named the place and OpenWork filled in its address", `input: ${input(automationResult)} -> sent=${String(sent.sent)}; "Open in OpenWork" -> ${target} (${buttons})`, ok);
    expect(ok).toBe(true);
    await alex.screenshot();
  });

  await step("after: a run blocked on a connection says what failed and links to the fix", async () => {
    const sent = await send(needsConnection);
    await shown("Pipeline report, stopped Mon Nov 23 at 9:00 AM");
    const target = new URL("/dashboard/your-connections", world.den.ref.webUrl).toString();
    const buttons = await dom(`a.bk-button[href="${target}"]`);
    const ok = sent.sent === true && buttons === 1;
    evidence.recordAssertionEvidence("One sentence, when it stopped, and a button to Your Connections", `input: ${input(needsConnection)} -> sent=${String(sent.sent)}; "Reconnect in OpenWork" -> ${target} (${buttons})`, ok);
    expect(ok).toBe(true);
    await alex.screenshot();
  });

  await step("then a broadcast, a mention and an image from another site never reach Slack as the agent wrote them", async () => {
    const sent = await send(unsafe);
    await shown("Signups by week");
    const counts = { mentions: await dom(".mention"), images: await dom(".bk-image"), imageLinks: await dom('a[href^="https://charts.example.com/"]') };
    const ok = sent.sent === true && counts.mentions === 0 && counts.images === 0 && counts.imageLinks === 1;
    evidence.recordAssertionEvidence("No one is pinged and nothing is fetched from the other site: the image is a link", `input: ${input(unsafe)} -> sent=${String(sent.sent)}; ${JSON.stringify(counts)}`, ok);
    expect(ok).toBe(true);
    await alex.screenshot();
  });

  await step("then raw Block Kit and buttons nothing would answer are refused, and nothing is posted", async () => {
    const before = await dom("#messages > .message");
    const raw = await send({ target: "me", text: "Raw blocks", components: [{ type: "section", text: { type: "mrkdwn", text: "<!channel> raw Block Kit" } }] });
    const choices = await send({ target: "me", text: "The reply to Dana is drafted.", components: [{ type: "choices", prompt: "Send it?", options: ["Send it", "Don't send"] }] });
    const after = await dom("#messages > .message");
    const ok = raw.error === "invalid_capability_arguments" && choices.error === "choices_unavailable" && before === after;
    evidence.recordAssertionEvidence("Only OpenWork's own vocabulary is accepted, and choices need the assistant that answers them", `raw Block Kit -> ${String(raw.error)}; choices with no assistant running -> ${String(choices.error)} ("${String(choices.message)}"); messages ${before} -> ${after}`, ok);
    expect(ok).toBe(true);
  });

  await step("then a teammate in the same Slack workspace sees none of Alex's messages", async () => {
    await riley.navigate(world.joinLink);
    await riley.click({ testId: "join-sandbox-submit" });
    await riley.see({ testId: "join-org-success" }, { timeoutMs: 30_000 });
    await riley.navigate(await world.oauthStart("riley"));
    await riley.click({ role: "button", label: "Allow workplace access" });
    await riley.click({ role: "button", label: "Continue" });
    await probe.eventually(() => world.slackConnected("riley"), { within: 60_000, label: "Riley's Slack is connected", until: Boolean });
    await riley.navigate(world.slackPage);
    await riley.see({ text: "No messages yet" }, { timeoutMs: 30_000 });
    const text = await probe.on(world.rileyBrowser).text();
    const ok = !text.includes("Open issues") && !text.includes("Northwind");
    evidence.recordAssertionEvidence("Each message went only to the member whose agent sent it", ok ? "Riley's conversation with the app is empty" : "Riley can read Alex's messages", ok);
    expect(ok).toBe(true);
    await riley.screenshot();
  });
});

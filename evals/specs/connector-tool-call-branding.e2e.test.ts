import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { connectorBranding, isRecord } from "../worlds/library.ts";

const test = spec.world(connectorBranding, { timeout: 420_000 });

test("connector-backed tool calls show first-class branding and human-readable labels", async ({ world, user, probe, step }) => {
  const sinceIso = new Date().toISOString();
  await user.type("composer", world.prompt);
  await user.click("Run task");

  await step("the real search and connector action are readable while the tool runs", async () => {
    await user.see({ text: /Searched your connections for.*Slack list_channels/ }, { timeoutMs: 60_000 });
    await user.see({ text: /^Listing channels$/ }, { timeoutMs: 30_000 });
    await user.notSee({ text: /openwork-cloud_execute_capability/ });
    await user.screenshot();
  });

  await step("the completed connector action exposes its arguments and survives reload", async () => {
    await user.see({ text: world.proof }, { timeoutMs: 60_000 });
    await user.see("Run task");
    if (world.engine === "v2") await user.click({ role: "button", label: /Looked up.*Show steps/ });
    expect(await world.den.mocks.connector.toolCalls({ name: "list_channels", sinceIso, atLeast: 1 }))
      .toMatchObject([{ name: "list_channels", args: { limit: 3 } }]);
    // TODO(primitive): probe.connectorBranding
    const inspect = () => probe.eval(() => {
      const rows = [...document.querySelectorAll<HTMLElement>('[data-capability-call]')];
      const matching = rows.filter(row => row.textContent.includes('Listed channels'));
      const mark = matching[0]?.querySelector<HTMLElement>('[data-connector-name="Slack"]');
      const image = mark?.querySelector('img');
      return { count: matching.length, connector: mark?.getAttribute('data-connector-name'),
        imageLoaded: image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0 };
    });
    const branded = await probe.eventually(inspect, { within: 15_000, label: "Slack tool icon and one completed row",
      until: (value) => isRecord(value) && value.imageLoaded === true });
    expect(branded).toMatchObject({ count: 1, connector: "Slack", imageLoaded: true });
    await user.click({ role: "button", label: "Listed channels. Show technical details" });
    await user.see({ text: /mcp:.*:list_channels/ });
    await user.see({ text: /"limit":\s*3/ });
    await user.screenshot();
    await user.reload();
    if (world.engine === "v2") await user.click({ role: "button", label: /Looked up.*Show steps/ });
    await user.see({ text: /^Listed channels$/ }, { timeoutMs: 30_000 });
    expect(await inspect()).toMatchObject({ count: 1, connector: "Slack" });
    await user.notSee({ text: /openwork-cloud_execute_capability/ });
    await user.click({ role: "button", label: "Listed channels. Show technical details" });
    await user.see({ text: /"limit":\s*3/ });
    await user.click({ role: "button", label: "Listed channels. Hide technical details" });
  });

  await step("before: a note has not yet been created", async () => {
    await user.notSee({ text: world.mutationProof });
    await user.screenshot();
  });

  await step("a member sees the note being created rather than the last lookup", async () => {
    await user.type("composer", world.mutationPrompt);
    await user.click("Run task");
    if (world.engine === "v2") {
      await user.see({ role: "button", label: /Creating note.*Slack/ }, { timeoutMs: 60_000 });
      await user.notSee({ text: /Tool activity|Task step|Completed with errors/ });
    } else {
      await user.see({ text: /Creating note/ }, { timeoutMs: 60_000 });
    }
    await user.screenshot();
  });

  await step("after: the created note is visible and the result survives reload", async () => {
    await user.see({ text: world.mutationProof }, { timeoutMs: 60_000 });
    await user.see("Run task");
    if (world.engine === "v2") {
      await user.see({ role: "button", label: /Created note.*Slack/ });
    } else {
      await user.see({ text: /Created note/ });
    }
    await user.screenshot();
    await user.reload();
    await user.see({ text: world.mutationProof }, { timeoutMs: 30_000 });
    await user.screenshot();
  });

  await step("a failed connector action stays identifiable and is not shown as successful", async () => {
    await user.type("composer", world.failurePrompt);
    await user.click("Run task");
    await user.see({ text: /^Reading history$/ }, { timeoutMs: 30_000 });
    await user.see({ role: "button", label: /Read history failed/ }, { timeoutMs: 60_000 });
    await user.see("Run task");
    await user.see({ text: "The history lookup failed." });
    await user.notSee({ role: "button", label: "Read history. Show technical details" });
    await user.notSee({ role: "button", label: /^Ran(?:\s|\.|[0-9]|$)/ });
    expect(await world.den.mocks.connector.toolCalls({ name: "read_history", sinceIso, atLeast: 1 }))
      .toMatchObject([{ name: "read_history", args: { limit: 3 } }]);
    await user.screenshot();
    await user.reload();
    await user.see({ role: "button", label: /Read history failed/ }, { timeoutMs: 30_000 });
    await user.see({ text: "The history lookup failed." });
    await user.notSee({ role: "button", label: "Read history. Show technical details" });
    await user.notSee({ role: "button", label: /^Ran(?:\s|\.|[0-9]|$)/ });
  });
});

import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { isolatedMcpApps, isolationPrompt, isolationReply, cloudDraftRouting, draftRoutingPrompt, draftRoutingReply } from "../worlds/saved-apps.ts";

const draftTest = spec.world(cloudDraftRouting, {
  resources: { surfaces: ["appWeb"], services: ["den", "mock"] },
  needs: { commands: ["bun", "pnpm", "opencode"] }, timeout: 600_000,
});

draftTest("APP-DRAFT-ROUTING Cloud SDK draft allows automatic reads and one trusted Send without a second modal, replay, or cross-server dispatch", async ({ world, agent, user, probe, evidence }) => {
  const sinceIso = new Date().toISOString();
  expect(draftRoutingPrompt).not.toContain(world.connectionId);
  await agent.send(draftRoutingPrompt);
  await user.see({ text: draftRoutingReply }, { timeoutMs: 120_000 });
  await user.screenshot();
  const modelRequests = (await world.den.mocks.slack.agentRequests({ promptMarker: draftRoutingPrompt }))
    .filter(request => request.kind === "tool" || request.kind === "final");
  expect(modelRequests.length).toBeGreaterThan(0);
  for (const request of modelRequests) {
    expect(request.advertisedToolNames?.some(name => name.endsWith("execute_capability"))).toBe(true);
    expect(request.advertisedToolNames?.some(name => name.includes("resolve_recipient") || name.includes("other_server_helper") || name.includes("send_slack_message"))).toBe(false);
  }
  try {
    const launches = await world.den.mocks.slack.toolCalls({ name: "render_slack_draft", sinceIso, atLeast: 0 });
    expect(launches.map(call => call.args), "The gateway must dispatch the originating provider launch before SDK rendering").toEqual([{ recipient: "Test recipient" }]);
    const launched = await probe.eventually(() => world.reports(), { within: 30_000, label: "SDK draft received launch result", until: values => values.some(value => value.result !== null) });
    expect(launched).toHaveLength(1);
    expect(launched[0]).toMatchObject({ input: { recipient: "Test recipient" }, result: {
      content: [{ type: "text", text: "Draft ready for Test recipient" }], isError: false,
    } });
  } catch (error) {
    const diagnostics = await world.launchDiagnostics(sinceIso);
    evidence.recordAssertionEvidence("Synthetic draft launch failure diagnostics", JSON.stringify(diagnostics), false);
    await user.screenshot();
    throw error;
  }
  await user.notSee({ text: "Allow App action?" });
  const reports = await probe.eventually(() => world.reports(), { within: 30_000, label: "automatic SDK recipient resolution and completed background, forged, and synthetic send denials", until: values => values.some(value => value.complete === true) });
  expect(reports).toHaveLength(1);
  const sdkApprovalError = { code: -32603, message: expect.stringContaining("requires user approval") };
  expect(reports[0]).toMatchObject({ input: { recipient: "Test recipient" }, helper: { isError: false, structuredContent: { recipient: "Test recipient", id: "synthetic-recipient" } },
    complete: true, send: null, sendError: null, sendClicks: 0, trustedClick: false,
    backgroundSend: null, backgroundSendError: sdkApprovalError, forgedSend: null, forgedSendError: sdkApprovalError,
    syntheticSend: null, syntheticSendError: sdkApprovalError, syntheticClicks: 1, syntheticTrustedClick: false,
    replay: null, replayError: null, replayComplete: false });
  const deniedSend = { approved: false, status: 422, code: "tool_requires_approval" };
  const backgroundRequests = await world.sendRequests();
  expect(backgroundRequests).toEqual([deniedSend, deniedSend, deniedSend]);
  await user.notSee({ text: "Allow App action?" });
  const rejected = reports[0].rejected;
  expect(rejected).toEqual([{ name: "unknown_helper", error: expect.any(String) }, { name: "other_server_helper", error: expect.any(String) }]);
  const calls = await world.den.mocks.slack.toolCalls({ sinceIso, atLeast: 2 });
  expect(calls.map(call => ({ name: call.name, args: call.args }))).toEqual([
    { name: "render_slack_draft", args: { recipient: "Test recipient" } },
    { name: "resolve_recipient", args: { recipient: "Test recipient" } },
  ]);
  expect(await world.den.mocks.other.toolCalls({ sinceIso, atLeast: 0 })).toEqual([]);
  const resolveDelay = await world.resolveDelay();
  expect(resolveDelay.delayed).toBeGreaterThan(0);
  expect(resolveDelay.completed).toBe(resolveDelay.delayed);
  expect(resolveDelay.aborted).toBe(0);
  await user.notSee({ text: "Interactive view unavailable. The normal tool result is still available." });
  await user.screenshot();
  evidence.recordAssertionEvidence("Cloud draft survives a 12-second resolve, permits automatic read-only helpers, and blocks untrusted sends", JSON.stringify({ reconciled: world.reconciled, resolveDelay, reports, backgroundRequests, calls: calls.map(call => ({ name: call.name, args: call.args })), otherDispatches: 0 }), true);

  await using draft = await world.draftSurface();
  const draftUser = user.on(draft);
  await draftUser.see({ text: "Recipient resolved: Test recipient. Draft only; nothing sent." });
  await draftUser.click({ role: "button", label: "Send" });
  await user.notSee({ text: "Allow App action?" });
  await draftUser.see({ text: "Sent to Test recipient." }, { timeoutMs: 30_000 });
  const sent = await probe.eventually(() => world.reports(), { within: 30_000, label: "trusted Send and immediate replay both settled", until: values => values.some(value => value.replayComplete === true) });
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ sendClicks: 1, trustedClick: true, sendError: null,
    syntheticClicks: 1, syntheticTrustedClick: false, replay: null, replayError: sdkApprovalError, replayComplete: true,
    send: { isError: false, structuredContent: { sent: true, id: "synthetic-message" } } });
  const sendRequests = await world.sendRequests();
  expect(sendRequests).toEqual([...backgroundRequests, { approved: true, status: 200, code: null }, deniedSend]);
  const sentCalls = await world.den.mocks.slack.toolCalls({ sinceIso, atLeast: 3 });
  expect(sentCalls.map(call => ({ name: call.name, args: call.args }))).toEqual([
    { name: "render_slack_draft", args: { recipient: "Test recipient" } },
    { name: "resolve_recipient", args: { recipient: "Test recipient" } },
    { name: "send_slack_message", args: { recipient: "synthetic-recipient", text: "The review is ready." } },
  ]);
  expect(await world.den.mocks.other.toolCalls({ sinceIso, atLeast: 0 })).toEqual([]);
  await user.notSee({ text: "Allow App action?" });
  await user.screenshot();
  expect((await world.den.mocks.slack.toolCalls({ sinceIso, atLeast: 0 })).map(call => ({ name: call.name, args: call.args })))
    .toEqual(sentCalls.map(call => ({ name: call.name, args: call.args })));
  evidence.recordAssertionEvidence("One trusted Send dispatches the reviewed Slack message exactly once without a second modal; its immediate replay is denied", JSON.stringify({ reports: sent, sendRequests, calls: sentCalls.map(call => ({ name: call.name, args: call.args })), otherDispatches: 0 }), true);
});

const isolationTest = spec.world(isolatedMcpApps, {
  resources: { surfaces: ["appWeb"], services: ["mock"] },
  needs: { commands: ["bun", "pnpm", "opencode"] }, timeout: 300_000,
});

isolationTest("APP-ISOLATION embedded MCP Apps isolate siblings while SDK initialization and helper calls work", async ({ world, agent, user, probe, evidence }) => {
  const sinceIso = new Date().toISOString();
  await agent.send(isolationPrompt);
  await user.see({ text: isolationReply }, { timeoutMs: 120_000 });
  await user.notSee({ text: "Allow App action?" });
  const reports = await probe.eventually(() => world.reports(), {
    within: 30_000, label: "both SDK Apps received their own input, result, and helper reply",
    until: values => values.length === 2 && values.every(value => value.complete === true),
  });
  expect(await world.nativeConfirmCalls()).toBe(0);
  for (const label of ["A", "B"]) {
    expect(reports.find(value => value.label === label)).toMatchObject({
      input: { marker: `input-${label}` },
      result: { content: [{ type: "text", text: `initial-${label}` }], isError: false,
        structuredContent: { serverTools: { provider: label }, schemaGuidance: `provider-${label}` }, _meta: { privateFixture: `view-only-${label}` } },
      helper: { content: [{ type: "text", text: `helper-${label}` }], isError: label === "A", _meta: { privateFixture: `helper-only-${label}` } },
      order: ["input", "result"], capabilities: { serverTools: {}, openLinks: {} },
      displayModes: [{ mode: "inline" }, { mode: "inline" }, { mode: "inline" }], complete: true,
    });
  }
  expect(reports.find(value => value.label === "A")).toMatchObject({
    siblingReads: 0, siblingInjections: 0, readDenied: 1, injectionDenied: 1, forgedMessages: 1,
  });
  const firstCalls = await world.first.toolCalls({ name: "read_detail", sinceIso, atLeast: 1 });
  const secondCalls = await world.second.toolCalls({ name: "read_detail", sinceIso, atLeast: 1 });
  expect(firstCalls.map(call => call.args)).toEqual([{ marker: "legitimate-A" }]);
  expect(secondCalls.map(call => call.args)).toEqual([{ marker: "legitimate-B" }]);
  evidence.recordAssertionEvidence("Sibling Apps cannot read or inject into each other", "App A attempted sibling DOM reads, proxy script injection, and a forged helper request; both DOM operations raised SecurityError and neither provider observed the forged call.", true);
  evidence.recordAssertionEvidence("Opaque Apps retain the standard SDK round trip", "Both real SDK Apps initialized through the shared renderer, received their distinct launch input and result, and completed exactly one legitimate helper call on their own provider.", true);
  await user.notSee({ text: "Allow App action?" });
  evidence.recordAssertionEvidence("Open Apps complete read-only background helpers without an extra host approval", "Both annotated read-only helpers completed on their own provider exactly once without a host approval click or native confirmation; App A preserved its provider error result.", true);
  evidence.recordAssertionEvidence("Launch delivery preserves provider data and truthfully reports inline-only display", "Complete input arrived before the result; provider structured fields, view-only metadata, and explicit false survived. The helper error flag survived too. The host advertised tools and links and returned inline for all three valid display-mode requests.", true);

  await user.reload();
  const reloaded = await probe.eventually(() => world.reports(), {
    within: 30_000, label: "reloaded Apps complete one background helper each without host approval",
    until: values => values.length === 2 && values.every(value => value.complete === true),
  });
  for (const label of ["A", "B"]) {
    expect(reloaded.find(value => value.label === label)).toMatchObject({
      helperError: null, helper: { content: [{ type: "text", text: `helper-${label}` }], isError: label === "A" },
    });
  }
  await user.notSee({ text: "Allow App action?" });
  expect((await world.first.toolCalls({ name: "read_detail", sinceIso })).map(call => call.args)).toEqual([
    { marker: "legitimate-A" }, { marker: "legitimate-A" },
  ]);
  expect((await world.second.toolCalls({ name: "read_detail", sinceIso })).map(call => call.args)).toEqual([
    { marker: "legitimate-B" }, { marker: "legitimate-B" },
  ]);
  expect(await world.nativeConfirmCalls()).toBe(0);
  evidence.recordAssertionEvidence("Reload preserves read-only background dispatch without duplicates or forged calls", "Each reloaded App completed one additional annotated read-only helper on its own provider. Both provider counts reached exactly two, with no forged arguments, approval dialog, or native confirmation.", true);
});

// The v2 engine does not expose a native archive mutation yet.
isolationTest.skipIf(process.env.OPENWORK_EVAL_ENGINE === "v2")("APP-ARCHIVE archived conversations render Apps without actions (needs v1 archive API)", async ({ world, agent, user, probe, evidence }) => {
  const sinceIso = new Date().toISOString();
  await agent.send(isolationPrompt);
  await user.see({ text: isolationReply }, { timeoutMs: 120_000 });
  await user.notSee({ text: "Allow App action?" });
  await probe.eventually(() => world.reports(), {
    within: 30_000, label: "active Apps complete their initial helper requests",
    until: values => values.length === 2 && values.every(value => value.complete === true && value.helper !== null),
  });
  await agent.run("session.archive", { sessionId: world.session.sessionId, archived: true });
  await agent.run("session.open", { sessionId: world.session.sessionId });
  const archived = await probe.eventually(() => world.reports(), {
    within: 30_000, label: "archived Apps render results but reject helper actions",
    until: values => values.length === 2 && values.every(value => value.complete === true && typeof value.helperError === "string"),
  });
  for (const label of ["A", "B"]) {
    const report = archived.find(value => value.label === label);
    expect(report).toMatchObject({
      input: { marker: `input-${label}` },
      result: { content: [{ type: "text", text: `initial-${label}` }], isError: false,
        structuredContent: { serverTools: { provider: label }, schemaGuidance: `provider-${label}` }, _meta: { privateFixture: `view-only-${label}` } },
      order: ["input", "result"], helper: null,
    });
    expect(report?.capabilities).toEqual({});
  }
  expect((await world.first.toolCalls({ name: "read_detail", sinceIso, atLeast: 1 })).map(call => call.args)).toEqual([{ marker: "legitimate-A" }]);
  expect((await world.second.toolCalls({ name: "read_detail", sinceIso, atLeast: 1 })).map(call => call.args)).toEqual([{ marker: "legitimate-B" }]);
  await user.notSee({ text: "Allow App action?" });
  expect(await world.nativeConfirmCalls()).toBe(0);
  evidence.recordAssertionEvidence("Archived conversations cannot dispatch even read-only App helper calls", "After active Apps completed their initial read-only helpers without host approval, reopened archived Apps received their original inputs and results, rejected helper requests without an approval dialog, and neither provider recorded an additional call. No native confirmation was invoked.", true);
});

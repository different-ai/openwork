import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { codeModeOrgOptIn, expression, items, record, text, toolPayload, type Persona } from "../worlds/code-mode-org-opt-in.ts";

// Effect: keep a tested connected task, find/run it through Library as a team
// viewer, and read fresh data without gaining edit rights or the author's
// connection access. Opt-in changes MCP routing, NOT script availability.
// Scope: protocol authoring/keep/share, real Den settings and Library execution.
// No simulated chat, supported OpenCode projection, or speed/token-cost claim.
const test = spec.world(codeModeOrgOptIn, { timeout: 600_000, resources: { surfaces: ["web"], services: ["den", "mock"] } });

test("an owner keeps an invoice follow-up task, a teammate runs it from Library, and sharing never grants billing access", async ({ world, user, probe, step, evidence }) => {
  const teammate = user.on(world.teammateWeb);
  const outsider = user.on(world.outsiderWeb);
  const withoutBilling = user.on(world.withoutBillingWeb);
  const witness = (claim: string, summary: string, details: unknown) => {
    evidence.recordAssertionEvidence(claim, summary, true);
    evidence.recordJsonArtifact(claim, details);
  };
  const name = "Overdue invoice follow-up";
  const input = { asOf: "2026-09-20" };
  const inputSchema = { title: "Invoice follow-up cutoff", type: "object", required: ["asOf"], additionalProperties: false,
    properties: { asOf: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" } } };
  const outputSchema = { type: "object", required: ["asOf", "summary", "overdueTotal", "followUps"], additionalProperties: false,
    properties: { asOf: { type: "string" }, summary: { type: "string" }, overdueTotal: { type: "number", minimum: 0 },
      followUps: { type: "array", items: { type: "object", required: ["invoice", "account", "due", "balance"], additionalProperties: false,
        properties: { invoice: { type: "string" }, account: { type: "string" }, due: { type: "string" }, balance: { type: "number", minimum: 0 } } } } } };
  const unpaid = { asOf: input.asOf, summary: "Follow up 1 overdue invoice(s); USD 800 outstanding.", overdueTotal: 800,
    followUps: [{ invoice: "INV-102", account: "Account B", due: "2026-09-10", balance: 800 }] };
  const settled = { asOf: input.asOf, summary: "No overdue invoices need follow-up.", overdueTotal: 0, followUps: [] };
  const advertisedTools = async () => items((await world.rpc("tools/list", {}, "teammate")).tools).filter((tool) => {
    const ui = tool._meta ? record(tool._meta).ui : undefined;
    const visibility = ui ? record(ui).visibility : undefined;
    return !Array.isArray(visibility) || visibility.includes("model");
  }).map((tool) => tool.name);
  const discover = async (query: string, caller: Persona = "owner") => items(record(await world.script(`return await tools.$codemode.search({query:${JSON.stringify(query)}})`, caller)).items);
  const calls = () => probe.toolCalls(world.den.mocks.billing);
  const readPair = async (before: number) => {
    const observed = await probe.eventually(calls, { within: 60_000, intervalMs: 100,
      until: (entries) => entries.length >= before + 2, label: "this run read both connected sources" });
    const added = observed.slice(before);
    expect(added.map((call) => call.name).sort()).toEqual(["list_invoices", "list_payments"]);
    expect(added.every((call) => Object.keys(call.args).length === 0)).toBe(true);
    return added.map(({ name, args }) => ({ name, args }));
  };

  const baseline = await step("before: standard MCP already joins invoices and payments into an overdue follow-up list", async () => {
    await user.see({ role: "switch", label: "Enable Code Mode" });
    expect((await probe.dom('[aria-label="Enable Code Mode"][aria-checked="false"]')).elements).toHaveLength(1);
    const names = await advertisedTools();
    expect(names).toContain("search_capabilities");
    expect(names).toContain("execute_capability");
    expect(names).toContain("execute_capability_script");
    expect(names).not.toContain("capability_helper");
    const found = await world.rpc("tools/call", { name: "search_capabilities", arguments: { query: "Billing records", type: "mcp", limit: 20 } }, "teammate");
    expect(found.isError).not.toBe(true);
    const matches = items(toolPayload(found).matches);
    const invoices = matches.find((match) => match.name === `mcp:${world.connection.id}:list_invoices`);
    const payments = matches.find((match) => match.name === `mcp:${world.connection.id}:list_payments`);
    expect(invoices).toBeDefined(); expect(payments).toBeDefined();
    const code = [
      `const [invoiceData, paymentData] = await Promise.all([${text(invoices?.scriptPath)}({}), ${text(payments?.scriptPath)}({})]);`,
      "const followUps = invoiceData.invoices.filter(row => row.due < input.asOf).map(row => ({",
      "invoice: row.id, account: row.account, due: row.due,",
      "balance: row.amount - paymentData.payments.filter(payment => payment.invoiceId === row.id).reduce((total, payment) => total + payment.amount, 0)",
      "})).filter(row => row.balance > 0).sort((a, b) => a.invoice.localeCompare(b.invoice));",
      "const overdueTotal = followUps.reduce((total, row) => total + row.balance, 0);",
      "return { asOf: input.asOf, followUps, overdueTotal, summary: followUps.length ? `Follow up ${followUps.length} overdue invoice(s); USD ${overdueTotal} outstanding.` : 'No overdue invoices need follow-up.' };",
    ].join("\n");
    expect(code).not.toContain("INV-102"); expect(code).not.toContain("800");
    const request = { name: "execute_capability_script", arguments: { code, input, inputSchema, outputSchema } };
    const before = (await calls()).length;
    const result = await world.rpc("tools/call", request, "teammate");
    expect(result.isError).not.toBe(true); expect(toolPayload(result).value).toEqual(unpaid);
    const reads = await readPair(before);
    await user.click({ text: "Connection behavior" });
    await user.see({ text: /keeps private App tools out of the model/ });
    witness("Off is the counterfactual: scripts and the billing task already work", "With opt-in off, the teammate's client reads invoices and payments and identifies one overdue invoice with USD 800 outstanding. Standard routers and the optional script tool are advertised; the helper is absent.", { modelTools: names, task: "Which overdue invoices need follow-up?", reads, result: toolPayload(result).value });
    await user.screenshot("Before: Code Mode is off; the connected invoice task already works through standard routing");
    return { code, request, invoicePath: text(invoices?.scriptPath), paymentPath: text(payments?.scriptPath) };
  });

  await step("the owner enables script-first routing; save and reload persist it but a teammate cannot change it", async () => {
    await user.click({ role: "switch", label: "Enable Code Mode" });
    await user.click({ role: "button", label: "Save settings" });
    await user.see({ text: "Workspace settings updated." });
    await user.reload(); await user.see({ role: "switch", label: "Enable Code Mode" });
    expect((await probe.dom('[aria-label="Enable Code Mode"][aria-checked="true"]')).elements).toHaveLength(1);
    const blocked = await world.attempt("teammate", "/v1/org", { codeModeEnabled: false }, "PATCH");
    expect(blocked.response.status).toBe(403);
    evidence.recordAssertionEvidence("The setting survives reload and remains owner/admin controlled", "Teammate PATCH codeModeEnabled:false returned 403; reloaded switch is checked.", true);
    await user.screenshot("After save and reload: the owner's Code Mode opt-in remains on");
  });

  const receiptId = await step("after: discovery moves inside MCP scripts; the same task still returns the same useful answer", async () => {
    const names = await advertisedTools();
    expect(names).toContain("execute_capability_script"); expect(names).toContain("capability_helper");
    expect(names).not.toContain("search_capabilities"); expect(names).not.toContain("execute_capability");
    const matches = await discover("Billing records", "teammate");
    expect(matches.some((match) => expression(match) === baseline.invoicePath)).toBe(true);
    expect(matches.some((match) => expression(match) === baseline.paymentPath)).toBe(true);
    const before = (await calls()).length;
    const result = await world.rpc("tools/call", baseline.request, "teammate");
    expect(result.isError).not.toBe(true); expect(toolPayload(result).value).toEqual(unpaid);
    const reads = await readPair(before);
    const tested = await world.rpc("tools/call", baseline.request);
    expect(tested.isError).not.toBe(true); expect(toolPayload(tested).value).toEqual(unpaid);
    const receiptId = text(record(toolPayload(tested).metadata).receiptId);
    witness("Changed routing, preserved task outcome—not a speed claim", "After opt-in, discovery works inside scripts, the helper is advertised and standard routers are app-only. Reading the same billing records still returns the same USD 800 follow-up. No chat, latency or token-cost comparison is claimed.", { modelTools: names, discovery: 'tools.$codemode.search({query:"Billing records"})', code: baseline.code, input, reads, result: toolPayload(result).value, ownerReceipt: receiptId });
    return receiptId;
  });

  const saved = await step("protocol: the owner keeps the exact tested procedure by receipt; it starts private", async () => {
    const save = (await discover("save Workflow")).find((match) => match.path === "tools.den.saveWorkflow");
    expect(save).toBeDefined();
    const keep = { name, receiptId, pluginId: world.pluginId };
    const foreign = await world.attempt("teammate", "/v1/workflows", { name: "Foreign attempt", receiptId });
    expect(foreign.response.status).toBe(400);
    const kept = record(await world.script(`return await ${expression(save)}({body:${JSON.stringify(keep)}})`));
    const history = await probe.api(world.den.admin, `/v1/workflow-authoring-history?receiptId=${receiptId}`);
    expect(history.response.status).toBe(200);
    const procedure = record(items(record(history.body).items)[0]?.procedure);
    expect(procedure.contract).toEqual({ input, inputSchema, outputSchema }); expect(procedure.code).toBe(baseline.code);
    const id = text(kept.configObjectId);
    const find = async (caller: Persona) => (await discover(name, caller)).find((match) => text(match.path).includes(`plugin:${world.pluginId}:${id}`));
    expect(await find("teammate")).toBeUndefined(); expect(await find("outsider")).toBeUndefined();
    await teammate.reload(); await teammate.click({ role: "button", label: "Plugins" });
    await teammate.see({ role: "heading", label: "No plugins yet" });
    await teammate.screenshot("Before sharing: the teammate cannot find the owner's private billing procedure");
    witness("Receipt-only keep retains exact code/input/schemas without granting team access", "The owner saves using the successful receipt without resubmitting source or schemas. The retained procedure matches exactly. A teammate cannot save that private receipt, and neither teammate nor outsider can discover the Workflow before sharing.", { request: keep, workflowId: id, foreignReceiptSaveStatus: foreign.response.status, teammateDiscovery: false, outsiderDiscovery: false });
    return { id, version: text(kept.configObjectVersionId), save, keep, find };
  });

  await step("protocol boundary: failed and invalid attempts stay private and cannot become working Workflows", async () => {
    const failed = await world.rpc("tools/call", { name: "execute_capability_script", arguments: { code: "throw new Error('Synthetic failure')" } });
    expect(failed.isError).toBe(true);
    const failure = toolPayload(failed); expect(failure.status).toBe("failed");
    const failedId = text(failure.receiptId);
    const failedHistory = await probe.api(world.den.admin, `/v1/workflow-authoring-history?receiptId=${failedId}`);
    expect(items(record(failedHistory.body).items)).toHaveLength(1);
    const denied = await world.attempt("owner", "/v1/workflows", { name: "Failed attempt", receiptId: failedId });
    expect(denied.response.status).toBe(400); expect(record(denied.body).error).toBe("workflow_authoring_run_not_successful");
    const foreignHistory = await probe.api(world.den.members.teammate, `/v1/workflow-authoring-history?receiptId=${failedId}`);
    expect(items(record(foreignHistory.body).items)).toEqual([]);
    const before = (await calls()).length;
    const rejectedResult = await world.rpc("tools/call", { name: "execute_capability_script", arguments: {
      code: `await ${baseline.invoicePath}({}); return await ${expression(saved.save)}({body:${JSON.stringify(saved.keep)}});`,
      input: { asOf: 42 }, inputSchema,
    } });
    expect(rejectedResult.isError).toBe(true);
    const rejected = toolPayload(rejectedResult);
    expect(rejected.error).toBe("invalid_arguments"); expect(record(rejected.retention).canSaveByReceipt).toBe(false);
    expect((await calls()).length).toBe(before);
    const rejectedId = text(rejected.receiptId);
    const rejectedHistory = await probe.api(world.den.admin, `/v1/workflow-authoring-history?receiptId=${rejectedId}`);
    const version = items(record(rejectedHistory.body).items)[0];
    expect(record(record(version).execution).status).toBe("failed");
    expect(record(record(version).procedure).contract).toEqual({ input: { asOf: 42 }, inputSchema });
    const rejectedKeep = await world.attempt("owner", "/v1/workflows", { name: "Invalid contract attempt", receiptId: rejectedId });
    expect(record(rejectedKeep.body).error).toBe("workflow_authoring_run_not_successful");
    witness("Failed and invalid attempts remain private and cannot become working tasks", "The author can inspect a failed attempt; the teammate cannot. Failed and invalid-input receipts cannot be saved. Invalid input is retained with its exact contract but stops before any billing call.", { failedStatus: failure.status, ownFailedHistoryCount: 1, foreignFailedHistory: foreignHistory.body, failedSaveError: record(denied.body).error, invalidInputError: rejected.error, invalidSaveError: record(rejectedKeep.body).error, canSaveByReceipt: false, providerDispatches: 0 });
  });

  const shared = await step("protocol sharing: a team viewer can execute but cannot edit or read private authoring history", async () => {
    const access = (await discover("postPluginsAccess")).find((match) => match.path === "tools.den.postPluginsAccess");
    expect(access).toBeDefined();
    await world.script(`return await ${expression(access)}({path:{pluginId:${JSON.stringify(world.pluginId)}},body:{teamId:${JSON.stringify(world.teamId)},role:"viewer",orgWide:false}})`);
    const shared = await saved.find("teammate"); expect(shared).toBeDefined(); expect(await saved.find("outsider")).toBeUndefined();
    const before = (await calls()).length;
    const result = record(await world.script(`return await ${expression(shared)}(${JSON.stringify(input)})`, "teammate"));
    expect(result.value).toEqual(unpaid); await readPair(before);
    const privateHistory = await probe.api(world.den.members.teammate, `/v1/workflow-authoring-history?receiptId=${receiptId}`);
    expect(items(record(privateHistory.body).items)).toEqual([]);
    const edit = await world.attempt("teammate", "/v1/workflows/test", { configObjectId: saved.id, name, code: baseline.code, exampleInput: input, inputSchema, outputSchema, requiredCapabilities: [] });
    expect(edit.response.status).toBe(403);
    witness("Sharing grants execution, not editing or private attempt history", "The selected team viewer discovers and runs the saved task using their own member access. Editing is rejected with 403 and the owner's private attempt history remains empty for the teammate.", { result: result.value, editStatus: edit.response.status, authoringHistory: privateHistory.body });
    return shared;
  });

  await step("boundary: an outsider has billing access but no Workflow access; guessed execution never reaches the provider", async () => {
    await outsider.reload(); await outsider.click({ role: "button", label: "Plugins" });
    await outsider.see({ role: "heading", label: "No plugins yet" });
    await outsider.notSee({ role: "link", label: /Billing procedures/ }); await outsider.notSee({ text: name });
    expect(await saved.find("outsider")).toBeUndefined();
    const before = (await calls()).length;
    const guessed = await world.rpc("tools/call", { name: "execute_capability_script", arguments: { code: `return await ${expression(shared)}(${JSON.stringify(input)})` } }, "outsider");
    expect(guessed.isError).toBe(true); expect((await calls()).length).toBe(before);
    witness("Workflow access is required even with billing access", "The outside-team member sees no shared Workflow and cannot discover it. Calling its known path is rejected without reaching either billing tool.", { discovered: false, error: items(guessed.content)[0]?.text, providerDispatches: 0 });
    await outsider.screenshot("After team sharing: the outside-team member still has no billing Workflow");
  });

  await step("the owner finds the saved task through Library, and the teammate opens the shared task through the same path", async () => {
    await user.click({ role: "link", label: "My Library" }); await user.click({ role: "button", label: "Plugins" });
    await user.click({ role: "link", label: /Billing procedures/ });
    await user.see({ role: "button", label: /Overdue invoice follow-up/ });
    await user.screenshot("The owner's saved invoice Workflow appears inside its Library Plugin");
    await user.click({ role: "button", label: /Overdue invoice follow-up/ });
    await user.see({ role: "button", label: "Run workflow" });
    await user.screenshot("The owner opens the saved task by clicking through Library, without a supplied link");
    await teammate.reload(); await teammate.click({ role: "button", label: "Plugins" });
    await teammate.see({ text: "Billing team" }); await teammate.click({ role: "link", label: /Billing procedures/ });
    await teammate.see({ role: "button", label: /Overdue invoice follow-up/ });
    await teammate.screenshot("After sharing: the teammate finds the invoice Workflow in the shared Library Plugin");
    await teammate.click({ role: "button", label: /Overdue invoice follow-up/ });
    await teammate.see({ role: "button", label: "Run workflow" });
    await teammate.notSee({ role: "tab", label: "Edit" });
    await teammate.screenshot("The teammate can run the shared task, but cannot edit its procedure");
  });

  await step("the teammate runs the task in Den and sees the overdue invoice, not just a successful tool call", async () => {
    await teammate.type({ role: "textbox", label: /^As of/ }, input.asOf, { replace: true, verify: true });
    const before = (await calls()).length;
    await teammate.click({ role: "button", label: "Run workflow" });
    await teammate.see({ testId: "den-workflow-artifact-result" }, { text: /Follow up 1 overdue invoice\(s\); USD 800 outstanding\./, timeoutMs: 60_000 });
    await teammate.see({ testId: "den-workflow-artifact-result" }, { text: /INV-102/ });
    const reads = await readPair(before);
    await teammate.see({ role: "button", label: "Run workflow" });
    witness("The teammate's Library run produces an actionable payment follow-up", "After normal Library navigation and entering the cutoff date, Run workflow reads both sources. Den shows INV-102, Account B and USD 800 outstanding; it excludes the fully paid and not-yet-due invoices.", { reads, result: unpaid, excluded: ["INV-101 already paid", "INV-103 not due"] });
    await teammate.screenshot("The teammate's Den run identifies Account B's overdue invoice with USD 800 outstanding");
  });

  await step("after a payment arrives, rerunning the same saved task removes the settled invoice from follow-up", async () => {
    await world.settleInvoice();
    const before = (await calls()).length;
    await teammate.click({ role: "button", label: "Run workflow" });
    await teammate.see({ testId: "den-workflow-artifact-result" }, { text: /No overdue invoices need follow-up\./, timeoutMs: 60_000 });
    const reads = await readPair(before);
    witness("The same saved task changes its answer when a payment arrives", "Only the external payment fixture changes: INV-102 receives USD 800. Rerunning the same saved code with the same cutoff rereads both sources and displays no overdue invoices. It does not replay the previous answer.", { fixtureChange: "USD 800 payment for INV-102", reads, before: unpaid, after: settled });
    await teammate.screenshot("After payment: the same saved task rereads billing records and shows no overdue invoices");
  });

  await step("a team viewer without billing access cannot borrow the author's connection through MCP or Den", async () => {
    // This member shares the Workflow team but has never received its source grant.
    expect(await saved.find("withoutBilling")).toBeDefined();
    const sources = await discover("Billing records", "withoutBilling");
    expect(sources.some((match) => text(match.path).includes(world.connection.id))).toBe(false);
    const before = (await calls()).length;
    const rejected = await world.rpc("tools/call", { name: "execute_capability_script", arguments: { code: `return await ${expression(shared)}(${JSON.stringify(input)})` } }, "withoutBilling");
    expect(rejected.isError).toBe(true);
    expect((await calls()).length).toBe(before);
    const rest = await world.attempt("withoutBilling", `/v1/workflows/${saved.id}/run`, { pluginId: world.pluginId, configObjectVersionId: saved.version, input });
    expect(rest.response.status).toBe(400); expect(record(rest.body).error).toBe("capability_unavailable");
    await withoutBilling.reload(); await withoutBilling.click({ role: "button", label: "Plugins" });
    await withoutBilling.click({ role: "link", label: /Billing procedures/ });
    await withoutBilling.click({ role: "button", label: /Overdue invoice follow-up/ });
    await withoutBilling.type({ role: "textbox", label: /^As of/ }, input.asOf, { replace: true, verify: true });
    await withoutBilling.click({ role: "button", label: "Run workflow" });
    await withoutBilling.see({ role: "alert" }, { timeoutMs: 60_000 });
    expect((await calls()).length).toBe(before);
    witness("Sharing the procedure does not grant billing access", "A second team viewer can find the Workflow but has no billing connection grant. MCP, the run endpoint and the Den form reject execution; the provider receives zero calls. Existing explicitly shared snapshots retain their current policy—this proves no new execution borrows the author's access.", { workflowDiscovered: true, restStatus: rest.response.status, restError: rest.body, mcpError: items(rejected.content)[0]?.text, providerDispatches: 0 });
    await withoutBilling.screenshot("A Workflow grant without billing access cannot run the task or borrow the author's connection");
  });
});

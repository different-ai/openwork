import { runToolTurn } from "@openwork/behaviors";
import { spec, type Target } from "@openwork/testkit";
import { computerSharingStateSchema } from "@openwork/types/computer-sharing";
import { expect } from "vitest";
import { computersLaptopToLaptop, studioName, travelName } from "../worlds/computers-laptop-to-laptop.ts";

// MICROSANDBOX_LIVE=1 MICROSANDBOX_PRODUCT_PROOF=1 OPENWORK_EVAL_SURFACES_DIR=/private/tmp/ow-c2a-surfaces pnpm evals:e2e computers-laptop-to-laptop --local --engine v2 --surface electron
const test = spec.world(computersLaptopToLaptop, { timeout: 900_000,
  resources: { surfaces: ["desktop", "web"], services: ["den", "mock"],
    nativeReason: "Two separate native apps exchange work through Den, and the target runs it in a real microVM with live host mounts." },
  needs: { placement: "local", platform: "darwin", optIn: ["MICROSANDBOX_LIVE"] } });
const settingsTitle = "Run code from my other computers";
const sharingLabel = "Let my other computers run code here (in the sandbox)";
const sharing: Target = { role: "switch", label: sharingLabel };
const allowed: Target = { role: "switch", label: travelName };
const wait = { timeoutMs: 60_000 };
const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;

test("Maya runs work from Travel MacBook inside Studio Mac's sandbox without sharing the rest of the Mac", async ({ world, user, agent, probe, step, evidence }) => {
  const travel = user.on(world.travel), studio = user.on(world.studio), web = user.on(world.ownerWeb), other = user.on(world.otherWeb);
  const targetProbe = probe.on(world.studio), webProbe = probe.on(world.ownerWeb);
  const travelAgent = agent.on(world.travel), studioAgent = agent.on(world.studio);
  const switchState = (label: string, checked: boolean) => targetProbe.dom(`[role="switch"][aria-label="${label}"][aria-checked="${checked}"]`);
  const settings = async (person: typeof studio, control: typeof studioAgent) => {
    await control.run("route.settings.general");
    await person.click("Devices");
  };
  const sharingReady = async (enabled: boolean, sourceAllowed = false, revoked = false) => {
    return probe.eventually(() => targetProbe.desktopApi("/computers/sharing"), { within: 60_000, label: "Studio Mac's sharing choices reach Den", until: result => {
      const state = result.status === 200 ? computerSharingStateSchema.safeParse(result.body).data : undefined;
      return Boolean(state && state.settings.enabled === enabled && state.sync === "synced" && state.organizationAllows
        && state.settings.sources.length === Number(sourceAllowed) && state.revokedSources.length === Number(revoked));
    } });
  };
  const observed = (claim: string, detail: string, ok: boolean) => {
    evidence.recordAssertionEvidence(claim, detail, ok);
    expect(ok, detail).toBe(true);
  };
  const settle = (tool: string, args: Record<string, unknown>, previousId?: string) => probe.eventually(() => world.toolCall(tool, input => Object.entries(args).every(([key, value]) => input[key] === value)), {
    within: 150_000, label: `the new ${tool} call finishes`, until: value => value !== null && value.callId !== previousId,
  });
  const text = (call: Awaited<ReturnType<typeof settle>>) => call?.error || call?.output || "";
  const runsOn = { tool: "runs_on", arguments: { computer: studioName } };
  const ownerRefusal = "Studio Mac isn't set to take work from other computers. Its owner decides whether to allow it.";
  const sourceRefusal = "Studio Mac doesn't take work from this computer. Its owner chooses which computers may in Settings > Devices on Studio Mac.";
  const echoWorld = { prepareTurn: (prompt: string, reply: string, calls: Parameters<typeof world.prepareTurn>[2]) => world.prepareTurn(prompt, reply, calls, true) };
  // Use the actual tool result for the visible reply. The model never scripts the expected outcome.
  const select = async (prompt: string, reply: string | RegExp) => {
    const previous = await world.toolCall("runs_on", input => input.computer === studioName);
    await echoWorld.prepareTurn(prompt, "No tool result was returned.", [runsOn]);
    await travel.type("composer", prompt);
    await travel.click("Run task");
    expect(await world.offeredTools(prompt)).toContain("runs_on");
    const result = text(await settle("runs_on", runsOn.arguments, previous?.callId));
    if (typeof reply === "string") expect(result).toContain(reply);
    else expect(result).toMatch(reply);
    await travel.see({ text: reply }, wait);
    return result;
  };
  const approve = async (prompt: string, tool: string, args: Record<string, unknown>, showPrompt = false) => {
    const queuedBefore = await world.commandCount();
    const filesBefore = await world.fileSnapshot();
    await echoWorld.prepareTurn(prompt, "No tool result was returned.", [{ tool, arguments: args }]);
    await travel.type("composer", prompt);
    await travel.click("Run task");
    await travel.see("Allow once", { timeoutMs: 120_000 });
    expect(await world.commandCount()).toBe(queuedBefore);
    expect(await world.fileSnapshot()).toEqual(filesBefore);
    if (showPrompt) await travel.screenshot();
    const start = Date.now();
    await travel.click("Allow once");
    const call = await settle(tool, args);
    const elapsed = Date.now() - start;
    await travel.see("Run task", { timeoutMs: 120_000 });
    if (call?.status === "error") {
      const travelProbe = probe.on(world.travel);
      const button = 'button[aria-label^="Show details for"]';
      const details = { role: "button", label: /^Show details for Couldn.t / } satisfies Target;
      const count = async () => (await travelProbe.dom(`[data-text-step-row="failed"] ${button}`)).elements.length;
      const matches = await probe.eventually(count, { within: 10_000, label: "the latest failed action has an error disclosure", until: value => value > 0 });
      await travel.click({ ...details, nth: matches - 1 });
    }
    return { call, elapsed, sent: (await world.commandCount()) - queuedBefore };
  };
  const inventory = { testId: "my-computer-inventory" };
  const rowIds = [world.target.id, world.source.id].map(id => `computer-inventory-row-${id}`);
  const rowSelector = rowIds.map(id => `[data-testid="${id}"]`).join(",");
  const runCode = '[data-testid^="computer-inventory-row-"] [data-run-code="sandbox"]';
  const folder = (name: string): Target => ({ role: "combobox", label: `Access to ${name}` });
  async function openSharedDetail() {
    await web.see(inventory, wait);
    await web.see({ text: "In sandbox, 2 folders" }, wait);
    const row = (await webProbe.dom(`${runCode}`)).elements[0];
    expect(row?.text).toContain("In sandbox, 2 folders");
    const replica = await Promise.all(rowIds.map(id => webProbe.dom(`[data-testid="${id}"]:has([data-run-code="sandbox"])`)));
    const index = replica.findIndex(result => result.elements.length === 1);
    if (index < 0) throw new Error("No row holds Studio Mac's sharing policy.");
    const carrying = replica[index]?.elements[0];
    await web.click({ testId: rowIds[index] });
    await web.see({ role: "heading", label: "Run code here" }, wait);
    await web.see({ role: "button", label: "Revoke" }, wait);
    return carrying?.text ?? "";
  }

  await step("before: Studio Mac is not taking work from other computers", async () => {
    await settings(studio, studioAgent);
    await studio.see(sharing, wait);
    await sharingReady(false);
    const off = (await switchState(sharingLabel, false)).elements.length === 1;
    expect(off).toBe(true);
    await studio.screenshot();
    await travel.see("composer", { editable: true, ...wait });
    await select("Can I run work on Studio Mac?", ownerRefusal);
    const queued = await world.commandCount();
    observed("The owner's choice stops work before it is sent", `${ownerRefusal} ${queued} commands reached Den.`, off && queued === 0 && (await world.fileSnapshot())[1] === null);
    await travel.screenshot();
  });

  await step("Maya allows Travel MacBook and makes only drafts editable", async () => {
    await studio.click(sharing);
    await studio.see(folder("drafts"), wait);
    await studio.click(folder("drafts"));
    await studio.click({ role: "option", label: "Can edit" });
    await studio.see(folder("drafts"), { ...wait, text: "Can edit" });
    await studio.click(allowed);
    const state = await sharingReady(true, true);
    expect(state.body).toMatchObject({ settings: { enabled: true, folders: [{ path: world.website, access: "read" }, { path: world.drafts, access: "edit" }], sources: [{ kind: "computer", id: world.source.id }] } });
    await studio.see(allowed, wait);
    const on = (await switchState(travelName, true)).elements.length === 1;
    observed("One computer can use two folders", "Travel MacBook is allowed; website is Read-only, and drafts is Can edit.", on);
    await studio.screenshot();
  });

  await step("Den shows two sandbox folders on the single physical Mac's row", async () => {
    await web.reload();
    const row = await openSharedDetail();
    const sources = (await webProbe.dom('ul[aria-label="Sources of access"] > li')).elements.map(entry => entry.text);
    const folded = (await webProbe.dom('[data-testid="computer-inventory-merged"]')).elements.map(entry => entry.text).join(" ");
    const rows = (await webProbe.dom(rowSelector)).elements;
    const access = sources.find(entry => entry.includes(travelName));
    observed("The two sign-ins stay one inventory row without moving access", `${row}; ${folded}; ${access ?? "no source shown"}`,
      rows.length === 1 && /1 older sign-in/.test(folded) && Boolean(access?.includes(world.website) && access.includes(world.drafts) && access.includes("Read-only") && access.includes("Can edit")));
    await web.screenshot();
  });

  await step("Travel MacBook points its chat at Studio Mac", async () => {
    await select("Use Studio Mac for this chat.", /This chat now runs on Studio Mac/);
    const reply = text(await settle("runs_on", runsOn.arguments));
    observed("The chat names Studio Mac and its shared folders", reply, reply.includes("This chat now runs on Studio Mac") && reply.includes("(read-only)") && reply.includes("(can edit)"));
    await travel.screenshot();
  });

  await step("Travel MacBook asks before reading the website brief", async () => {
    const { call, sent } = await approve("Read the website brief on Studio Mac.", "read", { path: world.websiteFile }, true);
    await travel.see({ text: new RegExp(world.websiteText) }, wait);
    observed("The read waits for approval, then returns the exact host bytes", `0 before approval; ${sent} sent after; the brief's nonce matched.`, call?.status === "completed" && text(call).includes(world.websiteText) && sent === 1);
    await travel.screenshot();
  });

  const linuxCommand = `uname -s; cat ${quote(world.websiteFile)}`;
  await step("Travel MacBook asks before running a Linux command in the shared folder", async () => {
    const { call, sent } = await approve("Check the operating system and show the brief from Studio Mac.", "shell", { command: linuxCommand, workdir: world.website }, true);
    await travel.see({ text: /Linux/ }, wait);
    observed("The command runs in Studio Mac's Linux sandbox, not on macOS", `0 before approval; ${sent} sent after; Linux and the exact website nonce returned.`,
      call?.status === "completed" && /^Linux\b/.test(text(call)) && text(call).includes(world.websiteText) && sent === 1);
    await travel.screenshot();
  });

  await step("Travel MacBook asks before saving a draft onto Studio Mac", async () => {
    const { call, sent } = await approve("Save a new draft in Studio Mac's drafts folder.", "write", { path: world.draftFile, content: world.draftText }, true);
    const bytes = await world.fileSnapshot();
    observed("A permitted write lands on the Mac's disk", `0 before approval; ${sent} sent after; ${bytes[1]?.length ?? 0} exact bytes in draft.txt.`,
      call?.status === "completed" && sent === 1 && bytes[1] === world.draftText && bytes[0] === world.websiteText);
    await travel.screenshot();
  });

  await step("Studio Mac's sandbox cannot open the private sibling folder", async () => {
    const { call, sent } = await approve("Check that the private note is not visible from the shared website folder.", "shell", { command: `cat ${quote(world.privateFile)}`, workdir: world.website });
    await travel.see({ text: /No such file/ }, wait);
    const untouched = await world.privateUntouched();
    observed("Den accepted the working folder, but the sandbox could not see the file", `${sent} command reached Studio Mac; No such file; private access and modification times unchanged: ${untouched}.`,
      sent === 1 && text(call).includes("No such file") && !text(call).includes(world.privateText) && untouched);
    await travel.screenshot();
  });

  await step("Studio Mac's sandbox cannot overwrite the read-only website", async () => {
    const { call, sent } = await approve("Check that the website brief cannot be overwritten by the shell.", "shell", { command: `printf 'overwrite witness' > ${quote(world.websiteFile)}`, workdir: world.website });
    await travel.see({ text: /Read-only file system/ }, wait);
    const [website] = await world.fileSnapshot();
    observed("A real read-only mount blocks the write", `${sent} command reached Studio Mac; Read-only file system; exact original bytes remain.`, sent === 1 && text(call).includes("Read-only file system") && website === world.websiteText);
    await travel.screenshot();
  });

  await step("Den refuses a direct write into the read-only folder before sending it", async () => {
    const { call, sent } = await approve("Try to replace the read-only website brief directly.", "write", { path: world.websiteFile, content: "direct write witness" });
    const refusal = "The folder I need on Studio Mac is shared read-only. Its owner decides whether it can be edited.";
    await travel.see({ text: refusal }, wait);
    observed("Den explains the owner controls write access", `${refusal} ${sent} commands queued.`, sent === 0 && text(call).includes(refusal) && (await world.fileSnapshot())[0] === world.websiteText);
    await travel.screenshot();
  });

  await step("Den refuses a direct read outside the owner's two shared folders", async () => {
    const { call, sent } = await approve("Try to open the unshared note directly.", "read", { path: world.privateFile });
    const refusal = "The folder I need on Studio Mac isn't shared with me. Its owner decides which folders to share.";
    await travel.see({ text: refusal }, wait);
    observed("Den explains the folder was never shared", `${refusal} ${sent} commands queued; the private file was not touched.`,
      sent === 0 && text(call).includes(refusal) && !text(call).includes(world.privateText) && await world.privateUntouched());
    await travel.screenshot();
  });

  await step("Maya turns off Travel MacBook and its very next request is refused", async () => {
    await studio.click(allowed);
    const state = await sharingReady(true);
    expect(state.body).toMatchObject({ settings: { sources: [] } });
    await studio.screenshot();
    const { call, sent } = await approve("Try the website brief after removing this MacBook's access.", "shell", { command: `cat ${quote(world.websiteFile)} # removed`, workdir: world.website });
    await travel.see({ text: sourceRefusal }, wait);
    observed("The owner can stop the next call without closing the chat", `${sourceRefusal} ${sent} commands queued.`, sent === 0 && text(call).includes(sourceRefusal));
    await travel.screenshot();
  });

  await step("Maya allows Travel MacBook again and the same chat can read the brief", async () => {
    await studio.click(allowed);
    await sharingReady(true, true);
    const { call, sent } = await approve("Read the website brief after restoring access.", "shell", { command: `cat ${quote(world.websiteFile)} # restored`, workdir: world.website });
    await travel.see({ text: new RegExp(world.websiteText) }, wait);
    observed("The very next approved request can reach the sandbox again", `${sent} request reached Studio Mac; the brief matched the original bytes.`, sent === 1 && text(call).includes(world.websiteText));
    await travel.screenshot();
  });

  await step("Maya revokes access in Den and Studio Mac shows the organization's revocation", async () => {
    await web.reload();
    await openSharedDetail();
    await web.click({ role: "button", label: "Revoke" });
    await web.click({ testId: "confirm-dialog-action" });
    await web.see({ text: /Revoked by Maya Okafor/ }, wait);
    await web.screenshot();
    const revoked = "Revoked in your organization's settings";
    await studio.see({ text: revoked }, wait);
    const state = await sharingReady(true, true, true);
    expect(state.body).toMatchObject({ revokedSources: [{ source: { kind: "computer", id: world.source.id } }] });
    observed("Den's revocation overrides the local allow", `${revoked}; the Travel MacBook switch is off.`, (await switchState(travelName, false)).elements.length === 1);
    await studio.screenshot();
  });

  await step("Studio Mac reports when it was last seen instead of queuing work after quitting", async () => {
    // Restore consent so this request exercises reachability, not the narrower-grant refusal.
    await web.click({ role: "button", label: "Allow again" });
    await sharingReady(true, true);
    await probe.eventually(world.targetListening, { within: 60_000, label: "Studio Mac is listening before quitting", until: Boolean });
    await world.stopStudio();
    await probe.eventually(world.targetListening, { within: 60_000, label: "Studio Mac's listening window expires", until: value => !value });
    const before = await world.fileSnapshot();
    const { call, sent, elapsed } = await approve("Try saving a draft after Studio Mac quits.", "write", { path: world.draftFile, content: "offline write witness" });
    const offline = /Studio Mac is offline, last seen .*Nothing ran there\./;
    await travel.see({ text: offline }, wait);
    const after = await world.fileSnapshot();
    observed("The offline answer is quick and nothing is queued", `${text(call)} ${elapsed} ms after approval; ${sent} commands sent; both files unchanged.`,
      offline.test(text(call)) && elapsed < 5_000 && sent === 0 && JSON.stringify(after) === JSON.stringify(before));
    await travel.screenshot();
  });

  await step("Den activity names the source, folder and target without exposing commands or file contents", async () => {
    await web.reload();
    await web.see(inventory, wait);
    // After Studio Mac quits, the other sign-in can represent the same physical row.
    const currentRow = await probe.eventually(async () => {
      for (const id of rowIds) if ((await webProbe.dom(`[data-testid="${id}"]`)).elements.length) return id;
      return null;
    }, { within: 60_000, label: "the physical Mac's inventory row loads" });
    if (!currentRow) throw new Error("The Mac is missing from My Computers.");
    await web.click({ testId: currentRow });
    const activity: Target = { role: "button", label: "Activity" };
    await web.see(activity, wait);
    await web.click(activity);
    const expected = `${travelName} was allowed to run a command in ${world.website} on ${studioName} for Maya Okafor`;
    await web.see({ text: expected }, wait);
    const entries = (await webProbe.dom('ul[aria-label="Recent activity"] > li > p')).elements.map(entry => entry.text);
    const leak = entries.some(entry => ["uname -s", "cat ", "printf ", "overwrite witness", world.privateText, world.websiteText, world.draftText].some(value => entry.includes(value)));
    observed("Activity is a description of access, not a transcript", `${expected}. Command or file contents exposed: ${leak}.`, entries.includes(expected) && !leak);
    await web.screenshot();
  });

  await step("Priya cannot see or reach another member's Studio Mac", async () => {
    await other.see(inventory, wait);
    await other.notSee({ text: studioName });
    const check = await world.otherMemberCheck();
    observed("A teammate gets the same answer as for an unknown computer", `Studio Mac visible: ${check.visible}; HTTP ${check.hidden} for Studio Mac and HTTP ${check.unknown} for an unknown computer, with identical bodies: ${check.same}.`,
      !check.visible && check.hidden === 404 && check.unknown === 404 && check.same);
    await other.screenshot();
  });

  await step("Turning Computers off removes both Settings and the chat's computer tool", async () => {
    await world.turnOffComputers();
    await travel.reload();
    await settings(travel, travelAgent);
    await travel.see({ role: "heading", label: "Devices" }, wait);
    // Also outlive the source server's routing catalog cache before the next prompt.
    await travel.notSee({ role: "heading", label: settingsTitle }, { timeoutMs: 31_000 });
    await travel.screenshot();
    await travel.click("Back to app");
    await travelAgent.run("session.open", { sessionId: world.session.sessionId });
    const prompt = await runToolTurn({ user: travel }, world, "Say hello with Computers switched off.", []);
    const tools = await world.offeredTools(prompt);
    observed("The flag removes the feature, not the rest of chat", `${tools.length} tools advertised; the computer selection tool is absent.`, tools.length > 0 && !tools.includes("runs_on"));
  });
});

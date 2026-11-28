import { spec, type Probe, type SpecBodyContext, type Target, type User } from "@openwork/testkit";
import { expect } from "vitest";
import { assertNoProviderKeys, cloudFolder, cloudNames, computersCloudComputers, travelName } from "../worlds/computers-cloud-computers.ts";

// MICROSANDBOX_LIVE=0 MICROSANDBOX_PRODUCT_PROOF=1 OPENWORK_EVAL_SURFACES_DIR=/private/tmp/ow-c2a-surfaces pnpm evals:e2e computers-cloud-computers --local --engine v2 --surface electron
const test = spec.world(computersCloudComputers, { timeout: 900_000,
  resources: { surfaces: ["desktop", "web"], services: ["den", "mock"], nativeReason: "The native desktop identifies itself to Den and uses provider credentials held by its own local server." },
  needs: { placement: "local", platform: "darwin" } });
const daytonaTest = spec.world((seed, context) => computersCloudComputers(seed, context, "daytona"), {
  timeout: 900_000, resources: { surfaces: ["desktop", "web"], services: ["den", "mock"], nativeReason: "The native desktop executes approved work on Daytona through its own local server." },
  needs: { placement: "local", platform: "darwin", env: ["DAYTONA_API_KEY"] },
});
const freestyleTest = spec.world((seed, context) => computersCloudComputers(seed, context, "freestyle"), {
  timeout: 900_000, resources: { surfaces: ["desktop", "web"], services: ["den", "mock"], nativeReason: "The native desktop executes approved work on Freestyle through its own local server." },
  needs: { placement: "local", platform: "darwin", env: ["FREESTYLE_API_KEY"] },
});

type World = Awaited<ReturnType<typeof computersCloudComputers>>;
type Context = SpecBodyContext<World>;
const wait = { timeoutMs: 60_000 };
const accessLabel = "Allow my OpenWork apps to access this entire computer";
const accessSwitch: Target = { role: "switch", label: accessLabel };
const settingsDialog: Target = { role: "dialog", label: "Edit computer" };
const workingFolder: Target = { role: "textbox", label: "Working folder" };
const saveAccess: Target = { role: "button", label: "Save access" };
const ownerRefusal = (name: string) => `I can't use ${name}. Its owner can allow access to the entire computer in Settings > Devices.`;
const markerCommand = `printf 'revocation witness' > ${cloudFolder}/revoked.txt`;

function journey({ world, user, agent, probe, evidence }: Context) {
  const travel = user.on(world.travel), desktop = probe.on(world.travel);
  const web = user.on(world.ownerWeb), webProbe = probe.on(world.ownerWeb);
  const control = agent.on(world.travel);
  const strings: string[] = [];
  const observed = (claim: string, detail: string, ok: boolean) => {
    assertNoProviderKeys(claim, detail);
    strings.push(claim, detail);
    evidence.recordAssertionEvidence(claim, detail, ok);
    expect(ok, detail).toBe(true);
  };
  const screenshot = async (person: User = travel, surface: Probe = desktop) => {
    const text = (await surface.dom("body")).elements.map(element => element.text);
    assertNoProviderKeys(...text);
    strings.push(...text);
    await person.screenshot();
  };
  const settle = (tool: string, args: Record<string, unknown>, previousId?: string) => probe.eventually(() => world.toolCall(tool, args), {
    within: 150_000, label: `the new ${tool} call finishes`, until: value => value !== null && value.callId !== previousId,
  });
  const text = (call: Awaited<ReturnType<typeof settle>>) => {
    const output = call?.error || call?.output || "";
    assertNoProviderKeys(output);
    return output;
  };
  const send = async (prompt: string, tool: string, args: Record<string, unknown>) => {
    const previous = await world.toolCall(tool, args);
    await world.prepareTurn(prompt, [{ tool, arguments: args }]);
    await travel.see("composer", { editable: true, ...wait });
    await travel.type("composer", prompt);
    await travel.click("Run task");
    return previous?.callId;
  };
  async function select(prompt: string, name: string, reply: string) {
    const args = { computer: name };
    const previous = await send(prompt, "runs_on", args);
    expect(await world.offeredSelection(prompt)).toBe(true);
    const result = text(await settle("runs_on", args, previous));
    expect(result).toContain(reply);
    await travel.see({ text: reply }, wait);
    return result;
  }
  async function approve(prompt: string, tool: string, args: Record<string, unknown>, pending?: () => Promise<void>) {
    const previous = await send(prompt, tool, args);
    await travel.see("Allow once", { timeoutMs: 120_000 });
    const call = await world.toolCall(tool, args);
    if (call === null) expect(previous).toBeUndefined();
    else expect(call.callId).toBe(previous);
    await pending?.();
    await screenshot();
    await travel.click("Allow once");
    const settled = await settle(tool, args, previous);
    const result = text(settled);
    await travel.see("Run task", { timeoutMs: 120_000 });
    if (settled?.status === "error") {
      const button = 'button[aria-label^="Show details for"]';
      const count = async () => (await desktop.dom(`[data-text-step-row="failed"] ${button}`)).elements.length;
      const matches = await probe.eventually(count, { within: 10_000, label: "the failed action has an error disclosure", until: value => value > 0 });
      await travel.click({ role: "button", label: /^Show details for Couldn.t /, nth: matches - 1 });
    }
    return { call: settled, result };
  }
  async function openSettings() {
    await control.run("route.settings.general");
    await travel.click("Devices");
    const manage: Target = { role: "button", label: `Manage ${world.target.label}` };
    await travel.see(manage, wait);
    await travel.click(manage);
    await travel.click({ role: "menuitem", label: "Edit" });
    await travel.see(settingsDialog, wait);
    await travel.see(accessSwitch, wait);
  }
  const switchIs = async (on: boolean) => (await desktop.dom(`[role="switch"][aria-labelledby="device-run-work-label"][aria-checked="${on}"]`)).elements.length === 1;
  async function changeAccess(on: boolean) {
    await travel.click(accessSwitch);
    if (on) await travel.type(workingFolder, cloudFolder, { replace: true });
    await travel.click(saveAccess);
    const access = await probe.eventually(world.targetAccess, { within: 60_000, label: "Maya's saved choice reaches Den", until: value => on
      ? value?.choice === "allow" && value.scope === "whole_vm" && value.folders.length === 1 && value.folders[0] === cloudFolder
      : value?.choice === "off" });
    await probe.eventually(() => switchIs(on), { within: 60_000, label: "the desktop shows Maya's saved choice" });
    return access;
  }
  async function returnToChat() {
    await travel.click({ role: "button", label: "Cancel" });
    await travel.notSee(settingsDialog);
    await travel.click("Back to app");
    await control.run("session.open", { sessionId: world.session.sessionId });
  }
  return { travel, web, webProbe, observed, screenshot, select, approve, openSettings, switchIs, changeAccess, returnToChat,
    verifyEvidence: () => assertNoProviderKeys(...strings),
  };
}

async function liveCloud(context: Context) {
  const { world, step } = context;
  const cloud = world.cloud;
  if (!cloud) throw new Error("The real cloud computer was not created.");
  const name = world.target.label;
  const { travel, web, webProbe, observed, screenshot, select, approve, openSettings, changeAccess, returnToChat, verifyEvidence } = journey(context);
  const selected = `This chat now runs on ${name}`;
  const command = "uname -s && cat nonce.txt";
  const noAcceptedWorkYet = async () => { expect(await world.acceptedWorkCount()).toBe(0); };
  try {
    await step(`before: ${name} refuses work until its owner allows access`, async () => {
      const reply = await select(`Can I run work on ${name}?`, name, ownerRefusal(name));
      const accepted = await world.acceptedWorkCount();
      const marker = await cloud.fileExists(cloud.markerFile);
      observed("Registering a cloud computer does not grant access", `${reply} ${accepted} requests accepted; no marker file was created.`, accepted === 0 && !marker);
      await screenshot();
    });

    await step(`Maya allows her apps to use all of ${name}`, async () => {
      await openSettings();
      const access = await changeAccess(true);
      observed("The owner chooses whole-computer access and a working folder", `Whole-computer access is on; work starts in ${cloudFolder}.`, access?.scope === "whole_vm" && access.folders[0] === cloudFolder);
      await screenshot();
      await returnToChat();
    });

    await step(`after: Travel MacBook points the chat at ${name}`, async () => {
      const reply = await select(`Use ${name} for this chat.`, name, selected);
      observed("The chat names the cloud computer and where work starts", reply, reply.includes(`Work starts in ${cloudFolder} there.`));
      await screenshot();
    });

    await step(`Maya approves reading the nonce from ${name}`, async () => {
      const { call, result } = await approve(`Read the note on ${name}.`, "read", { path: cloud.nonceFile }, noAcceptedWorkYet);
      observed("Only the approved read returns the exact nonce", "Den accepted no work before approval; the nonce matched the bytes seeded on the cloud computer.", call?.status === "completed" && result.includes(cloud.nonce));
      await travel.see({ text: cloud.nonce }, wait);
      await screenshot();
    });

    await step(`Maya approves a Linux command in ${name}'s working folder`, async () => {
      const before = await world.acceptedWorkCount();
      const { call, result } = await approve(`Check the operating system and show the note from ${name}.`, "shell", { command, workdir: cloudFolder }, async () => {
        expect(await world.acceptedWorkCount()).toBe(before);
      });
      observed("The approved command runs on Linux in the chosen folder", "No new access was accepted before approval; Linux and the exact nonce came back from the command.", call?.status === "completed" && /^Linux\b/.test(result) && result.includes(cloud.nonce));
      await travel.see({ text: /Linux/ }, wait);
      await screenshot();
    });

    await step(`Maya approves saving a new draft to ${name}`, async () => {
      const { call } = await approve(`Save a new draft on ${name}.`, "write", { path: cloud.draftFile, content: cloud.draft }, async () => {
        expect(await cloud.fileExists(cloud.draftFile)).toBe(false);
      });
      const matches = await cloud.draftMatches();
      observed("The provider independently confirms the approved write", `No draft before approval; all ${Buffer.byteLength(cloud.draft)} bytes of draft.txt matched when read back directly from the provider.`, call?.status === "completed" && matches);
      await screenshot();
    });

    await step(`Den names Travel MacBook, the folder and ${name}, not the command`, async () => {
      await web.reload();
      const row = { testId: `computer-inventory-row-${world.target.id}` };
      await web.see(row, wait);
      await web.click(row);
      await web.see({ role: "button", label: "Activity" }, wait);
      await web.click({ role: "button", label: "Activity" });
      const expected = `${travelName} was allowed to run a command in ${cloudFolder} on ${name} for Maya Okafor`;
      await web.see({ text: expected }, wait);
      const entries = (await webProbe.dom('ul[aria-label="Recent activity"] > li > p')).elements.map(entry => entry.text);
      assertNoProviderKeys(...entries);
      const leaked = entries.some(entry => ["uname -s", "cat nonce.txt", cloud.nonce, cloud.draft.trim()].some(value => entry.includes(value)));
      observed("Activity describes access without exposing commands or contents", `${expected}. Command or file contents exposed: ${leaked}.`, entries.includes(expected) && !leaked);
      await screenshot(web, webProbe);
    });

    await step(`Maya turns access off and the next call cannot run on ${name}`, async () => {
      await openSettings();
      await changeAccess(false);
      await screenshot();
      await returnToChat();
      const before = await world.acceptedWorkCount();
      const { result } = await approve(`Try creating a marker on ${name} after turning access off.`, "shell", { command: markerCommand, workdir: cloudFolder }, async () => {
        expect(await cloud.fileExists(cloud.markerFile)).toBe(false);
      });
      await travel.see({ text: ownerRefusal(name) }, wait);
      const accepted = (await world.acceptedWorkCount()) - before;
      const exists = await cloud.fileExists(cloud.markerFile);
      observed("The next approved request is refused before it runs", `${ownerRefusal(name)} ${accepted} new requests accepted; the provider confirmed there was no marker file.`, result.includes(ownerRefusal(name)) && accepted === 0 && !exists);
      await screenshot();
    });
  } finally { verifyEvidence(); }
}

daytonaTest("Maya approves work on Build box from Travel MacBook and can stop it again", { timeout: 900_000 }, liveCloud);
freestyleTest("Maya approves work on Preview box from Travel MacBook and can stop it again", { timeout: 900_000 }, liveCloud);

test("Maya sees why her desktop cannot run work on a cloud computer it cannot reach", async (context) => {
  const { world, step } = context;
  const { travel, observed, screenshot, select, approve, openSettings, switchIs, changeAccess, returnToChat, verifyEvidence } = journey(context);
  const name = cloudNames.daytona;
  try {
    await step("before: registering Build box does not allow it to take work", async () => {
      const reply = await select("Can I run work on Build box?", name, ownerRefusal(name));
      const accepted = await world.acceptedWorkCount();
      observed("The chat points Maya to the owner's Settings", `${reply} ${accepted} requests accepted.`, accepted === 0);
      await screenshot();
    });
    await step("Maya allows whole-computer access to Build box in Settings", async () => {
      await openSettings();
      expect(await switchIs(false)).toBe(true);
      const access = await changeAccess(true);
      observed("Den saves Maya's choice", `Whole-computer access is on with ${cloudFolder} as the working folder.`, access?.scope === "whole_vm" && access.folders[0] === cloudFolder);
      await screenshot();
      await returnToChat();
    });
    await step("after: the chat says it needs the Daytona key and nothing ran", async () => {
      await select("Use Build box for this chat.", name, `This chat now runs on ${name}`);
      const refusal = "Build box needs its Daytona key on this machine before OpenWork can reach it. Nothing ran there.";
      const { result } = await approve("Check the operating system on Build box.", "shell", { command: "uname -s", workdir: cloudFolder });
      await travel.see({ text: refusal }, wait);
      observed("Maya knows what is missing on this computer", result, result.includes(refusal) && !/^Linux\b/.test(result));
      await screenshot();
    });
    await step("Archive box cannot take work from other computers yet", async () => {
      if (!world.unsupported) throw new Error("The unhandled cloud provider was not registered.");
      const label = world.unsupported.label;
      const reply = await select("Can I run work on Archive box instead?", label, `${label} can't take work from other computers yet.`);
      const accepted = await world.acceptedWorkCount(world.unsupported.id);
      observed("An unsupported provider cannot accept work", `${reply} ${accepted} requests accepted.`, accepted === 0);
      await screenshot();
    });
  } finally { verifyEvidence(); }
});

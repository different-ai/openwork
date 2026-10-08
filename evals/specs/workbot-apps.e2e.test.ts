import { expect } from "vitest";
import { spec, type Probe, type User } from "@openwork/testkit";
import { workbotApps, type AppView } from "../worlds/workbot-apps.ts";

const test = spec.world(workbotApps, { resources: { surfaces: ["appWeb"], services: ["den", "mock"] }, needs: { placement: "local" }, timeout: 900_000 });
const composer = { label: "Message Workbot" };

type World = Awaited<ReturnType<typeof workbotApps>>;

/** Past the welcome, in the main chat, with Workbot's hello on screen. */
async function startChatting({ world, user, probe }: { world: World; user: User; probe: Probe }) {
  await user.navigate(world.url);
  await probe.eventually(async () => (await probe.dom("button:not([disabled])")).elements.some((button) => button.text === "Get started"), { within: 30_000, label: "The connection choice is ready" });
  await user.click("Get started");
  await user.click("Start chatting");
  await user.see({ text: world.hello }, { timeoutMs: 60_000 });
  await user.see(composer, { editable: true });
}

async function send(user: User, text: string) {
  await user.type(composer, text);
  await user.click({ role: "button", label: "Send" });
}

test("a member uses Apps inside Workbot's replies, and Workbot knows what they did there", async ({ world, user, probe, step, evidence }) => {
  // One App is looked at a time; it stays open across the steps that click in it.
  let view: AppView | undefined;
  await using _openView = { [Symbol.asyncDispose]: async () => { await view?.[Symbol.asyncDispose](); } };
  const open = async (title: string) => {
    await view?.[Symbol.asyncDispose]();
    view = await world.appView(title);
    return view;
  };
  const apps = async () => (await probe.dom("[data-workbot-app]")).elements.length;

  await step("given a member in their main chat, with Apps on for their workspace", async () => {
    await startChatting({ world, user, probe });
    expect(await apps()).toBe(0);
    evidence.recordAssertionEvidence("The member's main chat has started", "Workbot's hello is on screen and no App is open yet.", true);
  });

  await step("when they ask Workbot to check stock, the Inventory App opens in the reply with the result it opened with", async () => {
    await send(user, world.stock);
    await user.see({ text: world.stockReply }, { timeoutMs: 60_000 });
    await user.see({ text: world.stockTitle }, { timeoutMs: 30_000 });
    const stock = await open(world.stockTitle);
    await stock.sees("stock", "WIDGET-7: 12 in stock", 60_000);
    // The App tried to reserve stock as it opened, before anyone clicked: Workbot refused it.
    await stock.sees("guard", /runs only right after a click in the App/);
    expect(await stock.text()).not.toContain(`Reserved ${world.reservation}`);
    await user.screenshot();
    evidence.recordAssertionEvidence(
      "A connected MCP server's App opens inside the reply",
      `Workbot called the Inventory stock check through OpenWork Connect. Its App opened under "${world.stockReply}" with the stock the tool returned, and the reservation it tried before any click was refused.`,
      true,
    );
  });

  await step("when they click Reserve in the App, it reserves, and the App tells Workbot what it reserved", async () => {
    if (!view) throw new Error("The Stock check App is not open");
    await view.click("Reserve 6");
    await view.sees("reservation", `Reserved ${world.reservation}`);
    await user.screenshot();
    evidence.recordAssertionEvidence("A click runs the App's change", `One click in the App reserved stock: it shows "Reserved ${world.reservation}".`, true);
  });

  await step("when they click Ask Workbot about it, the App asks as them, and Workbot answers from what the App told it", async () => {
    if (!view) throw new Error("The Stock check App is not open");
    await view.click("Ask Workbot about it");
    await user.see({ text: world.ask }, { timeoutMs: 30_000 });
    await user.see({ text: world.askReply }, { timeoutMs: 60_000 });
    const seen = world.witness();
    evidence.recordAssertionEvidence(
      "What the App reported reached the model, and its launch did not",
      `When the App asked "${world.ask}", the model's request carried the App's report with ${world.reservation} (${seen.sawReservation}); no request carried the App's launch (${!seen.sawLaunchMeta}).`,
      seen.sawReservation && !seen.sawLaunchMeta,
    );
    expect(seen.sawReservation).toBe(true);
    expect(seen.sawLaunchMeta).toBe(false);
    await user.screenshot();
  });

  await step("when they open the App built in OpenWork, its read-only price lookup runs as it opens", async () => {
    await send(user, world.price);
    await user.see({ text: world.priceReply }, { timeoutMs: 60_000 });
    await user.see({ text: world.priceTitle }, { timeoutMs: 30_000 });
    const price = await open(world.priceTitle);
    await price.sees("price", "WIDGET-7 costs 7", 60_000);
    expect(await apps()).toBe(2);
    await user.screenshot();
    evidence.recordAssertionEvidence("An App built in OpenWork opens inside the reply", `The Price check App opened under "${world.priceReply}" and showed the unit price its read-only lookup returned, with no click.`, true);
  });

  await step("after a reload, both Apps come back as they were, and the model isn't asked again", async () => {
    const requests = world.witness().requests;
    await view?.[Symbol.asyncDispose]();
    view = undefined;
    await user.navigate(world.url);
    await user.see({ text: world.askReply }, { timeoutMs: 60_000 });
    await user.see({ text: world.stockTitle }, { timeoutMs: 30_000 });
    await user.see({ text: world.priceTitle });
    const stock = await open(world.stockTitle);
    await stock.sees("stock", "WIDGET-7: 12 in stock", 60_000);
    expect(world.witness().requests).toBe(requests);
    await user.screenshot();
    evidence.recordAssertionEvidence("Apps are kept with the conversation", `After a reload both Apps opened again with what they opened with, and the model got no new request (${requests} before and after).`, true);
  });

  await step("after Apps are turned off for the workspace, the replies stay and the Apps are gone", async () => {
    await view?.[Symbol.asyncDispose]();
    view = undefined;
    await world.setApps(false);
    // Workbot asks Den who the person is at most every 30 seconds, so the switch takes up to that long.
    const remaining = await probe.eventually(async () => {
      await user.navigate(world.url);
      await user.see({ text: world.priceReply }, { timeoutMs: 30_000 });
      return apps();
    }, { within: 120_000, intervalMs: 5_000, label: "Apps leave the chat once they are off", until: (count) => count === 0 });
    expect(remaining).toBe(0);
    await user.see({ text: world.stockReply });
    await user.screenshot();
    evidence.recordAssertionEvidence("Turning Apps off keeps the conversation", `With Workbot's Apps off, the replies "${world.stockReply}" and "${world.priceReply}" stay and no App shows.`, remaining === 0);
  });
});

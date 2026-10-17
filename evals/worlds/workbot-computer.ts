import type { Seed } from "@openwork/env";
import { bootWorkbot, enableWorkbot, signInWorkbot } from "../../worlds/lib/workbot.ts";

/** The real signed-in Workbot and Den; no paid VM is created by this rollout/recovery journey. */
export async function workbotComputerWorld(seed: Seed) {
  const stack = new AsyncDisposableStack();
  try {
    const workbot = await bootWorkbot(stack, undefined, { live: false, features: { workbotDocuments: true } });
    const signed = await signInWorkbot(workbot);
    await signed.call("/v1/workbot/messages", { method: "POST", body: JSON.stringify({ id: "desktop_proof_hello", text: "Hello" }) });
    const web = await seed.web({ den: workbot.den, headless: true, viewport: { width: 1440, height: 960 } });
    for (const pair of signed.cookie.split("; ")) {
      const equal = pair.indexOf("=");
      await web.client.send("Network.setCookie", { name: pair.slice(0, equal), value: pair.slice(equal + 1), url: workbot.workbotUrl, httpOnly: true, sameSite: "Lax" });
    }
    await web.client.send("Page.navigate", { url: `${workbot.workbotUrl}/computer` });
    return {
      web,
      setEnabled: (value: boolean, workspaceAssistant = false) => enableWorkbot(workbot.den, { computerUse: value, remoteComputers: value, workbotDocuments: true, workbotWorkspaceAssistant: workspaceAssistant }),
      call: signed.call,
      async [Symbol.asyncDispose]() { await stack.disposeAsync(); },
    };
  } catch (error) { await stack.disposeAsync(); throw error; }
}

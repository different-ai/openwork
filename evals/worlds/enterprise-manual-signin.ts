import { createDesktopHandoffGrant, evalIn } from "@openwork/behaviors";
import { attachSurface, clickAt, locate, pressKey, typeText } from "@openwork/cdp";
import type { Place, Seed } from "@openwork/env";

export async function enterpriseManualSigninWorld(seed: Seed, { place }: { place: Place }) {
  const den = await seed.den({ org: { name: "Manual Handoff Workspace" } });
  // The generic desktop readiness helper expects the consumer welcome or
  // workspace screen. This journey starts at the earlier Enterprise gate.
  const host = place.host();
  const handle = await host.spawnElectron("enterprise-manual-signin", {
    profile: "fresh",
    env: { OPENWORK_DESKTOP_DISTRIBUTION: "enterprise" },
  });
  const app = await attachSurface(handle).catch(async () => {
    await host.disposeSurface(handle);
    throw new Error("Could not attach to the Enterprise activation screen.");
  });
  return {
    app,
    den,
    // Use real keyboard input without putting a one-time grant in the user
    // trace. No OS deep-link callback or auth control seam is invoked.
    async pasteLinkAndSubmit() {
      const grant = await createDesktopHandoffGrant(den.admin);
      const link = new URL("openwork://den-auth");
      link.searchParams.set("grant", grant);
      link.searchParams.set("denBaseUrl", den.ref.webUrl);
      try {
        await pressKey(app, process.platform === "darwin" && place.kind === "local" ? "Meta+A" : "Control+A");
        await typeText(app, link.toString());
        const submit = await locate(app, { role: "button", label: "Continue" });
        await clickAt(app, submit.center);
        const submitted = await evalIn(app, `(async () => {
          const deadline = Date.now() + 10_000;
          while (document.querySelector('#organization-server-input') && Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 50));
          }
          return !document.querySelector('#organization-server-input');
        })()`, { awaitPromise: true, timeoutMs: 15_000 });
        if (!submitted) throw new Error("Manual link submission did not reach confirmation.");
      } catch {
        // Never expose CDP arguments containing the link in error evidence.
        await evalIn(app, `document.querySelector('#organization-server-input')?.remove()`);
        throw new Error("Could not paste and submit the manual sign-in link.");
      }
    },
    async [Symbol.asyncDispose]() {
      try { await app[Symbol.asyncDispose](); }
      finally { await host.disposeSurface(handle); }
    },
  };
}

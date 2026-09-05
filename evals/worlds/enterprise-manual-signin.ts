import { createDesktopHandoffGrant, evalIn } from "@openwork/behaviors";
import { pressKey, typeText } from "@openwork/cdp";
import type { Place, Seed } from "@openwork/env";
import { desktop } from "@openwork/hosts";

export async function enterpriseManualSigninWorld(seed: Seed, { place }: { place: Place }) {
  const den = await seed.den({ org: { name: "Manual Handoff Workspace" } });
  const app = await desktop({
    name: "enterprise-manual-signin",
    host: place.host(),
    env: { OPENWORK_DESKTOP_DISTRIBUTION: "enterprise" },
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
        await typeText(app, link.toString());
        await pressKey(app, "Enter");
      } catch {
        // Never expose CDP arguments containing the link in error evidence.
        await evalIn(app, `document.querySelector('#organization-server-input')?.remove()`);
        throw new Error("Could not paste and submit the manual sign-in link.");
      }
    },
    async [Symbol.asyncDispose]() { await app[Symbol.asyncDispose](); },
  };
}

import { spec } from "@openwork/testkit";
import { denOAuthErrorPage } from "../worlds/den-oauth-error-page.ts";

const test = spec.world(denOAuthErrorPage, {
  timeout: 300_000,
  needs: { commands: ["bun", "pnpm"], placement: "local" },
  resources: { surfaces: ["web"], services: ["den"] },
});

test("an OAuth error that cannot return to the client is explained on OpenWork's own page", async ({ world, user, step, evidence }) => {
  const person = user.on(world.web);
  await step("before: a client asks to return to an address it never registered", async () => {
    await person.navigate(world.authorizeUrl);
  });
  await step("after: the branded error page says what happened and what to do, with diagnostics collapsed", async () => {
    await person.see({ text: "The app's return address isn't registered" }, { timeoutMs: 90_000 });
    await person.see({ text: "What to do next" });
    await person.see({ text: "Technical details" });
    await person.notSee({ text: "Something went wrong" });
    await person.notSee({ text: "Ask AI" });
    await person.see({ text: "Back to OpenWork" });
    evidence.recordAssertionEvidence(
      "The error is explained in OpenWork's own words",
      "The browser landed on /connect/error with the title \"The app's return address isn't registered\", a \"What to do next\" list and a \"Back to OpenWork\" link; Better Auth's \"Something went wrong\" card and its \"Ask AI\" button were absent.",
      true,
    );
    await person.screenshot();
    await person.click({ text: "Technical details" });
    await person.see({ text: "invalid_redirect" });
    evidence.recordAssertionEvidence(
      "Diagnostics stay collapsed until asked for",
      "The provider's error code invalid_redirect appeared only after opening the \"Technical details\" row.",
      true,
    );
    await person.screenshot();
  });
});

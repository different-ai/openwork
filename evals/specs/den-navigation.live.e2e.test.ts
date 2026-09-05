import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { liveAccountBrowser, liveBrowserNeeds, liveSignedOutBrowser } from "../worlds/live-den-browser.ts";

const publicPage = spec.world(liveSignedOutBrowser, {
  needs: { optIn: ["OPENWORK_EVAL_LIVE"], env: ["OPENWORK_EVAL_LIVE_DEN_API_URL", "OPENWORK_EVAL_LIVE_DEN_WEB_URL"] },
});
const account = spec.world(liveAccountBrowser, { needs: liveBrowserNeeds, timeout: 240_000 });

publicPage(".live signed-out visitors can load the email-first login form", async ({ user, evidence }) => {
  await user.see({ role: "textbox", label: "Email" }, { timeoutMs: 60_000 });
  await user.see({ role: "button", label: "Next" });
  await user.notSee({ role: "textbox", label: "Password" });
  await user.notSee({ testId: "den-org-sidebar" });
  evidence.recordAssertionEvidence("Public login", "Email and Next render without exposing a password form or an authenticated workspace.", true);
});

publicPage(".live protected dashboard routes require authentication", async ({ world, user, evidence }) => {
  for (const path of ["/dashboard", "/dashboard/manage-members", "/dashboard/inference"]) {
    await user.navigate(`${world.den.webUrl}${path}`);
    await user.see({ role: "textbox", label: "Email" }, { timeoutMs: 60_000 });
    await user.notSee({ testId: "den-org-sidebar" });
    expect((await world.location()).pathname).not.toContain("/dashboard");
    evidence.recordAssertionEvidence(`Access guard ${path}`, "Direct navigation returned to login without rendering workspace controls.", true);
  }
});

account(".live dashboard search opens Members and Connectors; navigation survives reload", async ({ world, user, probe, evidence }) => {
  await user.navigate(world.den.webUrl);
  await user.type({ role: "textbox", label: "Email" }, world.inbox.email);
  await user.click({ role: "button", label: "Next" });
  await user.type({ role: "textbox", label: "Password" }, world.password);
  await user.click({ role: "button", label: "Sign in" });
  await user.see({ testId: "den-org-sidebar" }, { timeoutMs: 60_000 });
  for (const [query, pathname] of [["members", "/manage-members"], ["mcp", "/mcp-connections"]]) {
    await user.click({ testId: "den-command-palette-trigger" });
    await user.type({ testId: "den-command-palette-input" }, query, { replace: true });
    await user.press("Enter");
    await user.notSee({ testId: "den-command-palette" });
    await probe.eventually(() => world.location(), { within: 30_000, until: (url) => url.pathname.includes(pathname), label: `navigation to ${pathname}` });
    expect((await world.location()).pathname).toContain(pathname);
    await user.reload();
    await user.see({ testId: "den-org-sidebar" });
    expect((await world.location()).pathname).toContain(pathname);
    await user.notSee({ role: "textbox", label: "Email" });
    evidence.recordAssertionEvidence(`Dashboard search ${query}`, `Search opened ${pathname}; reloading preserved the route and authenticated shell.`, true);
  }
});

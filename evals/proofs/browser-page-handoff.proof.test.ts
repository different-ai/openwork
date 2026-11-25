import { spec } from "@openwork/testkit";
import { expect } from "vitest";
import { browserPageHandoff } from "../worlds/browser-page-handoff.ts";

const test = spec.world(browserPageHandoff, {
  resources: { surfaces: ["desktop"], services: ["den"],
    nativeReason: "The built-in tab and the operating system browser opener both run in Electron." },
});

test("a person continues the current page in their default browser", async ({ world, user, agent, probe, step, evidence }) => {
  const open = { role: "button", label: "Open in default browser" } as const;
  await step("before: the page is open inside the conversation", async () => {
    await agent.run("session.open", { sessionId: world.session.sessionId });
    if (await probe.has("Not now")) await user.click({ role: "button", label: "Not now" });
    await user.see({ testId: "session-browser-toggle" }, { timeoutMs: 60_000 });
    await agent.run("browser.open_url", { url: world.page, provider: "builtin" });
    await user.see(open);
    expect(await world.browserUrls.opened()).not.toContain(world.page);
    await user.screenshot();
  });
  await step("after: the toolbar opens that same address in the default browser", async () => {
    await user.click(open);
    const urls = await probe.eventually(() => world.browserUrls.opened(), {
      within: 10_000, label: "the operating system receives the current page", until: values => values.includes(world.page),
    });
    const count = urls.filter(url => url === world.page).length;
    evidence.recordAssertionEvidence("The current page opens once", `Matching browser opens: ${count}`, count === 1);
    expect(count).toBe(1);
    await user.see(open);
    await user.screenshot();
  });
});

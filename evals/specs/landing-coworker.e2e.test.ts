import { expect } from "vitest";
import { chrome } from "@openwork/hosts";
import { emulateFocus, freezeMotion, reload, setViewport } from "@openwork/cdp";
import { spec } from "@openwork/testkit";

// A new visitor journey: an actual announcement page, its native links, and
// the Models handoff. No live account or checkout is created by this spec.
for (const width of [1280, 375]) {
  const test = spec.world(async () => {
    const origin = process.env.OPENWORK_EVAL_LANDING_URL;
    if (!origin) throw new Error("OPENWORK_EVAL_LANDING_URL is required");
    const web = await chrome({ name: "coworker-announcement-" + width, startUrl: origin + "/coworker" });
    try {
      await setViewport(web, { width, height: 900, deviceScaleFactor: 1 });
      // Wait for a complete document before adding the motion fixture;
      // streaming hydration would otherwise replace its head style.
      await reload(web);
      await emulateFocus(web);
      // Use the standard motion fixture so pointer targeting cannot race an
      // in-flight smooth scroll and click a neighboring FAQ.
      await freezeMotion(web);
      return { web, origin, async [Symbol.asyncDispose]() { await web.stop(); } };
    } catch (error) {
      await web.stop();
      throw error;
    }
  }, { needs: { env: ["OPENWORK_EVAL_LANDING_URL"] }, timeout: 90_000 });

  test("Coworker announcement offers early access and an intentional Models handoff at " + width + "px", async ({ world, user, probe, step, evidence }) => {
    await step("Understand the product and its availability", async () => {
      await user.see({ text: "Introducing Open Coworker" });
      const text = await probe.text();
      expect(text).toContain("Better together.");
      expect(text).not.toContain("A coworker who remembers");
      expect(text).toContain("Public download coming soon.");
      expect(text).not.toMatch(/\$100|first 50|24 hours|unlimited/i);
      evidence.recordAssertionEvidence("The announcement introduces coworkers and accurately labels early access", "The browser leads with Your work. Better together. and the upcoming public download, with no unapproved offer or unlimited usage claim.", true);
    });
    await step("Follow the explanation and read the execution limits", async () => {
      await user.click({ role: "link", text: "Try the demo" });
      expect(await probe.hash()).toBe("#how");
      await user.see({ text: "Pick up the conversation." });
      expect(await probe.text()).toContain("How’s the launch brief coming along?");
      expect(await probe.text()).toContain("Draft · Ready to review");
      expect(await probe.text()).not.toContain("1 Worker running");
      await user.see({ testId: "coworker-question-1" });
      await user.click({ testId: "coworker-question-1" });
      await probe.eventually(async () => (await probe.text()).includes("Those Cloud runs cannot read your coworker's local files or memory today."), { within: 5_000, label: "the expanded execution answer" });
      expect(await probe.text()).toContain("Those Cloud runs cannot read your coworker's local files or memory today.");
      evidence.recordAssertionEvidence("Visitors can follow the product explanation and expand the local-versus-Cloud answer", "The native explanation link reaches #how and the FAQ opens to explain execution limits.", true);
    });
    await step("Try Dynamic effort without changing another coworker's preference", async () => {
      await user.click({ testId: "demo-effort-toggle" });
      await user.see({ role: "dialog", label: "Preview Dynamic effort" });
      await user.click({ role: "button", label: "All in" });
      await user.see({ testId: "demo-effort-toggle" }, { text: /Dynamic effort\s*All in/ });
      expect(await probe.text()).toContain("Replies in this demo are scripted.");
      await user.press("Escape");
      await user.click({ role: "button", label: "Talk to Editor" });
      await user.see({ testId: "demo-effort-toggle" }, { text: /Dynamic effort\s*Balanced/ });
      await user.click({ role: "button", label: "Talk to Scout" });
      await user.see({ testId: "demo-effort-toggle" }, { text: /Dynamic effort\s*All in/ });
      await user.click({ testId: "demo-effort-toggle" });
      await user.click({ testId: "demo-effort-reset" });
      await user.see({ testId: "demo-effort-toggle" }, { text: /Dynamic effort\s*Balanced/ });
      await user.press("Escape");
      evidence.recordAssertionEvidence("The app's Dynamic effort control is usable inside the demo composer", "All in persists for Scout while Editor stays Balanced; Reset restores the default. The preview explicitly identifies scripted replies.", true);
    });
    await step("Talk with coworkers and open their work", async () => {
      await user.click({ role: "button", label: "Send example message" });
      await probe.eventually(async () => (await probe.text()).includes("Start with one useful moment:"), { within: 5_000, label: "Scout's scripted reply" });
      await user.see({ text: "Who should this brief help first?" });
      await user.click({ testId: "demo-answer-1" });
      await user.see({ testId: "demo-thinking" });
      await probe.eventually(async () => (await probe.text()).includes("I’ll focus the brief on the campaign handoff:"), { within: 5_000, label: "Scout uses the selected audience" });
      await user.click({ role: "button", label: "Open Launch brief" });
      expect(await probe.text()).toContain("Your direction · Marketing teams");
      expect(await probe.text()).toContain("Make the first minute feel useful.");
      await user.click({ role: "button", label: "All documents" });
      await user.see({ role: "button", label: "Read Launch brief" });
      await user.click({ role: "button", label: "Talk to Editor" });
      expect(await probe.text()).toContain("Could you help with the announcement?");
      expect(await probe.text()).not.toContain("Start with one useful moment:");
      await user.click({ role: "button", label: "Send example message" });
      await probe.eventually(async () => (await probe.text()).includes("I’ve added that as an alternative opening"), { within: 5_000, label: "Editor's scripted revision" });
      await user.click({ role: "button", label: "Open Announcement draft" });
      expect(await probe.text()).toContain("Alternative opening");
      expect(await probe.text()).toContain("Good work starts with a little company.");
      await user.click({ role: "button", label: "Talk to Ops" });
      expect(await probe.text()).toContain("Where are we with the launch checklist?");
      await user.click({ role: "button", label: "Talk to Scout" });
      expect(await probe.text()).toContain("Start with one useful moment:");
      expect(await probe.text()).not.toContain("I’ve added that as an alternative opening");
      evidence.recordAssertionEvidence("The walkthrough keeps each coworker's conversation and document separate", "A visitor sends example messages, opens a brief, revises Editor's draft, explores Ops, and returns to Scout's preserved reply. No account or inference is required.", true);
    });
    await step("Explore assignments, schedules, and example connections", async () => {
      await user.click({ testId: "demo-view-assignments" });
      await user.click({ role: "button", label: "Assign to Scout" });
      expect(await probe.text()).toContain("Working on it · Demo");
      await user.click({ role: "button", label: "See sample result" });
      expect(await probe.text()).toContain("The draft-review example is the easiest to understand.");
      await user.click({ role: "button", label: "Pause sample schedule" });
      expect(await probe.text()).toContain("Paused in demo");
      await user.click({ role: "button", label: "Resume sample schedule" });
      expect(await probe.text()).toContain("Mondays at 9:00 AM · Active");
      await user.click({ testId: "demo-view-connections" });
      await user.click({ role: "button", label: "Connect Google Drive demo" });
      expect(await probe.text()).toContain("Connected in demo · 3 sample documents");
      await user.click({ role: "button", label: "Connect Slack demo" });
      expect(await probe.text()).toContain("Connected in demo · #launch-team");
      expect(await probe.text()).toContain("4 of 6 moments tried");
      await user.click({ role: "button", label: "Disconnect Google Drive demo" });
      expect(await probe.text()).not.toContain("Connected in demo · 3 sample documents");
      expect(await probe.text()).toContain("Connected in demo · #launch-team");
      evidence.recordAssertionEvidence("Visitors can explore the assignment lifecycle and toggle independent sample connections", "A sample assignment returns a result; its schedule pauses and resumes. Drive and Slack connect in the demo, and disconnecting Drive leaves Slack connected. The page keeps these examples distinct from real actions.", true);
    });
    await step("Explore an animated group chat and create a custom coworker", async () => {
      await user.click({ role: "link", label: "Try the team conversation" });
      await user.see({ role: "button", label: "Send group message" });
      await user.click({ role: "button", label: "Ask Scout to reply" });
      await user.click({ role: "button", label: "Ask Ops to reply" });
      await user.see({ testId: "demo-group-mentions" }, { text: "@Editor" });
      await user.click({ role: "button", label: "Send group message" });
      await user.see({ testId: "demo-thinking" });
      await probe.eventually(async () => (await probe.text()).includes("Editor replied. The others stayed out of this turn."), { within: 5_000, label: "only the named coworker replies" });
      expect(await probe.text()).not.toContain("Building on Scout’s research");
      expect(await probe.text()).not.toContain("You choose when we’re ready to share.");
      await user.click({ role: "button", label: "Everyone" });
      await user.see({ testId: "demo-group-mentions" }, { text: "@everyone" });
      await user.click({ role: "button", label: "Send group message" });
      await user.see({ testId: "demo-thinking" });
      await probe.eventually(async () => (await probe.text()).includes("A direction, a draft, and a plan."), { within: 8_000, label: "the three coworkers finish their turns" });
      expect(await probe.text()).toContain("Building on Scout’s research");
      expect(await probe.text()).toContain("You choose when we’re ready to share.");
      await user.see({ role: "button", label: "Send group message" });
      // Reply controls must remain usable after a longer conversation fills
      // the scrollable panel, including the fixed-height desktop grid.
      await user.click({ role: "button", label: "Ask Scout to reply" });
      await user.click({ role: "button", label: "Ask Editor to reply" });
      await user.see({ testId: "demo-group-mentions" }, { text: "@Ops" });
      await user.click({ role: "button", label: "Send group message" });
      await probe.eventually(async () => (await probe.text()).includes("Ops replied. The others stayed out of this turn."), { within: 5_000, label: "the next group turn uses the new recipients" });
      expect(await probe.text()).not.toContain("Building on Scout’s research");
      await user.click({ role: "link", label: "Make a coworker in the demo" });
      await user.see({ role: "textbox", label: "Coworker name" });
      await user.type({ role: "textbox", label: "Coworker name" }, "Robin", { replace: true });
      await user.click({ role: "button", label: "Mint" });
      await user.click({ role: "button", label: "Soft square" });
      await user.see({ text: "Robin" });
      await user.click({ role: "button", label: "Set responsibilities" });
      await user.type({ role: "textbox", label: "Coworker role" }, "Research partner", { replace: true });
      await user.type({ role: "textbox", label: "Coworker mission" }, "Summarize the launch feedback.", { replace: true });
      await user.type({ role: "textbox", label: "Responsibility 1" }, "Summarize launch feedback", { replace: true });
      await user.click({ testId: "demo-personality-details" });
      await user.click({ role: "button", label: "Thoughtful" });
      expect(await probe.text()).toContain("Personality changes the wording while working.");
      await user.click({ role: "button", label: "Add coworker" });
      await user.see({ text: "With Robin" });
      await user.see({ role: "button", label: "Talk to Robin" });
      expect(await probe.text()).toContain("Make a little room on your team.");
      await user.click({ role: "button", label: "Send example message" });
      await user.see({ testId: "demo-thinking" });
      await probe.eventually(async () => (await probe.text()).includes("Your mission is: “Summarize the launch feedback.”"), { within: 5_000, label: "the custom coworker's sample reply reflects its mission" });
      await user.click({ testId: "demo-answer-0" });
      await probe.eventually(async () => (await probe.text()).includes("Let’s start with: “Summarize launch feedback”"), { within: 5_000, label: "Robin follows the chosen responsibility" });
      await user.click({ testId: "demo-view-assignments" });
      expect(await probe.text()).toContain("Summarize launch feedback");
      expect(await probe.text()).not.toContain("Compare three launch examples");
      await user.click({ role: "button", label: "Assign to Robin" });
      await user.click({ testId: "demo-open-create" });
      await user.click({ role: "button", label: "Start with Support" });
      await user.see({ role: "textbox", label: "Coworker name" }, { value: "Ellis" });
      await user.click({ role: "button", label: "Set responsibilities" });
      await user.click({ role: "button", label: "Add coworker" });
      await user.see({ text: "With Ellis" });
      await user.click({ testId: "demo-view-assignments" });
      expect(await probe.text()).toContain("Prepare a weekly feedback digest");
      await user.see({ role: "button", label: "Assign to Ellis" });
      await user.click({ role: "button", label: "Talk to Robin" });
      await user.click({ testId: "demo-view-assignments" });
      expect(await probe.text()).toContain("Summarize launch feedback");
      expect(await probe.text()).toContain("Working on it · Demo");
      expect(await probe.text()).not.toContain("Prepare a weekly feedback digest");
      await user.click({ role: "button", label: "Pause animation" });
      await user.see({ role: "button", label: "Resume animation" });
      await user.click({ role: "button", label: "Resume animation" });
      evidence.recordAssertionEvidence("The walkthrough demonstrates group collaboration and personalized coworker creation", "Scout, Editor, and Ops take visible turns after a thinking state. Visitors direct a reply to Editor or everyone, answer a coworker’s question, and create Research and Support coworkers with distinct responsibilities and independent assignment state. Animation can be paused.", true);
    });
    await step("Preview the membership path and reset the sample workspace", async () => {
      await user.click({ testId: "demo-view-chat" });
      await user.click({ testId: "demo-model-source" });
      await user.click({ role: "button", label: "Use OpenWork Models in demo" });
      await user.see({ testId: "demo-model-source" }, { text: "OpenWork Models" });
      await user.see({ role: "link", label: "See membership" });
      await user.click({ role: "button", label: "Reset demo" });
      await user.see({ testId: "demo-model-source" }, { text: "Free model" });
      const reset = await probe.text();
      expect(reset).toContain("0 of 6 moments tried");
      expect(reset).not.toContain("Start with one useful moment:");
      expect(reset).not.toContain("Explore models through an OpenWork membership.");
      expect(reset).not.toContain("Robin");
      expect(reset).not.toContain("Ellis");
      expect(reset).not.toContain("I’ll focus the brief on the campaign handoff:");
      await user.click({ testId: "demo-open-group" });
      await user.see({ role: "button", label: "Send group message" });
      await user.see({ testId: "demo-group-mentions" }, { text: "@everyone" });
      await user.click({ testId: "demo-open-create" });
      await user.see({ role: "textbox", label: "Coworker name" }, { value: "Milo" });
      await user.click({ testId: "demo-view-connections" });
      expect(await probe.text()).not.toContain("Connected in demo");
      await user.click({ role: "button", label: "Talk to Editor" });
      expect(await probe.text()).not.toContain("I’ve added that as an alternative opening");
      await user.click({ role: "button", label: "Reset demo" });
      expect(await probe.text()).toContain("Sample data and scripted replies.");
      evidence.recordAssertionEvidence("The model selector offers membership information and reset clears the sample state", "Selecting OpenWork Models exposes a membership link. Reset restores the free source, clears every coworker's replies and both connections, and resets walkthrough progress. No checkout is completed.", true);
    });
    await step("Get early access without an unintended purchase", async () => {
      await user.click({ role: "link", text: "Get early access", nth: 0 });
      expect(await probe.hash()).toBe("#get-started");
      await user.see({ role: "link", text: "Email for early access" });
      expect(await probe.text()).toContain("Opens your email app");
      const response = await fetch(world.origin + "/coworker", { signal: AbortSignal.timeout(30_000) });
      expect(response.status).toBe(200);
      const html = await response.text();
      const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((match) => match[1]!.replaceAll("&amp;", "&"));
      expect(hrefs).toContain("mailto:team@openworklabs.com?subject=Open%20Coworker%20early%20access");
      for (const mode of ["sign-up", "sign-in"]) {
        const href = hrefs.find((value) => value.includes("intent=models") && value.includes("mode=" + mode));
        expect(href).toBeTruthy();
        const url = new URL(href!);
        expect(url.origin).toBe("https://app.openworklabs.com");
        expect(url.searchParams.get("intent")).toBe("models");
        expect(url.searchParams.get("utm_campaign")).toBe("coworker");
        expect(url.searchParams.has("token")).toBe(false);
      }
      expect(html).toContain("It does not grant early access to Open Coworker.");
      expect(html).toContain("/coworker/opengraph-image");
      const socialImage = await fetch(world.origin + "/coworker/opengraph-image", { signal: AbortSignal.timeout(30_000) });
      expect(socialImage.status).toBe(200);
      expect(socialImage.headers.get("content-type")).toContain("image/png");
      evidence.recordAssertionEvidence("Early access and Models have separate, truthful destinations", "Email opens a real early-access request; signup and member sign-in links preserve Models intent and campaign attribution without tokens. Membership explicitly does not grant early access.", true);
    });
    await step("Discover the announcement from the main homepage", async () => {
      await user.navigate(world.origin + "/");
      await user.click({ role: "link", label: /Meet Open Coworker/ });
      await user.see({ text: "Introducing Open Coworker" });
      expect(await probe.text()).toContain("Public download coming soon.");
      evidence.recordAssertionEvidence("Homepage visitors can discover the Coworker announcement", "The homepage announcement link opens the real Coworker page with the same accurate early-access availability.", true);
    });
  });
}

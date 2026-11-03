import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { workbotOpenWorkplace } from "../worlds/workbot-open-workplace.ts";

const test = spec.world(workbotOpenWorkplace, {
  timeout: 900_000,
  needs: { commands: ["pnpm"], placement: "local" },
  resources: { surfaces: ["web"], services: ["den", "mock"] },
});

const SUBJECT = "Supplier sync";
const MAIL = "Q4 pilot forecast: committed vs. expansion";
const REPLY = "Thanks, confirmed for Thursday.";
const NOTE = "Supplier sync notes.txt";
const NOTE_TEXT = "Supplier sync moved to Thursday.";

test("Workbot works on the same Open Outlook, Calendar and Drive a person sees, and only theirs", async ({ world, user, probe, step, evidence }) => {
  await user.resizeViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  const casey = user.on(world.caseyWeb);
  const ask = async (text: string, answer: string, actor = user) => {
    await actor.type({ role: "textbox", label: "Message Workbot" }, text, { replace: true });
    await actor.click({ role: "button", label: "Send" });
    await actor.see({ text: answer }, { timeoutMs: 90_000 });
  };
  // A person's first open greets them and lists the apps their team connected; later opens go straight to the chat.
  const opened = new Set<unknown>();
  const openChat = async (actor = user) => {
    await actor.navigate(world.url);
    if (!opened.has(actor)) {
      opened.add(actor);
      await actor.see({ role: "button", label: "Get started" }, { timeoutMs: 90_000 });
      await actor.click({ role: "button", label: "Get started" });
      await actor.see({ text: "Microsoft 365" }, { timeoutMs: 30_000 });
      await actor.screenshot();
      await actor.click({ role: "button", label: "Start chatting" });
    }
    await actor.see({ role: "textbox", label: "Message Workbot" }, { timeoutMs: 90_000 });
  };

  await step("an event added to Alex's Open Calendar appears in Alex's Workbot Calendar", async () => {
    await world.createEvent("alex", SUBJECT, world.wednesday, 30);
    await user.navigate(world.alex.calendar);
    await user.see({ text: SUBJECT }, { timeoutMs: 30_000 });
    await user.screenshot();
    await user.navigate(`${world.url}/calendar`);
    await user.see({ text: SUBJECT }, { timeoutMs: 90_000 });
    evidence.recordAssertionEvidence("Workbot Calendar reads Alex's Open Calendar through Den's Microsoft 365 connector", `${SUBJECT} shown in Workbot Calendar`, await probe.has(SUBJECT));
    await user.screenshot();
  });

  await step("Alex asks Workbot to find and then move the meeting, and Open Calendar has the new time", async () => {
    await openChat();
    await ask(`find the meeting "${SUBJECT}"`, `"${SUBJECT}" is on your Outlook calendar`);
    await user.see({ text: "Used Outlook Calendar" });
    await user.screenshot();
    await ask(`move the meeting "${SUBJECT}" to ${world.thursday.toISOString()}`, `Moved "${SUBJECT}"`);
    
    await user.screenshot();
    const moved = await world.event("alex", SUBJECT);
    expect(moved?.start).toBe(world.thursday.getTime());
    expect(moved && moved.end - moved.start).toBe(30 * 60_000);
    evidence.recordAssertionEvidence("The reschedule landed in Alex's Open Calendar, same length", `start ${new Date(moved?.start ?? 0).toISOString()}`, moved?.start === world.thursday.getTime());
    await user.navigate(world.alex.calendar);
    await user.see({ text: world.thursday.toISOString().slice(0, 16) }, { timeoutMs: 30_000 });
    await user.screenshot();
  });

  await step("Alex asks Workbot to draft a reply, and the draft is in Alex's Open Outlook, unsent", async () => {
    await openChat();
    await ask(`reply to the email "${MAIL}" with "${REPLY}"`, `Saved a reply draft to "${MAIL}"`);
    await user.see({ text: "Used Outlook" });
    await user.screenshot();
    const drafts = await world.drafts("alex");
    expect(drafts.some((draft) => draft.subject === `RE: ${MAIL}` && draft.body.includes(REPLY))).toBe(true);
    evidence.recordAssertionEvidence("The reply draft is in Alex's Open Outlook Drafts", drafts.map((draft) => draft.subject).join("; "), drafts.some((draft) => draft.body.includes(REPLY)));
    await user.navigate(world.alex.outlook);
    await user.click({ role: "button", label: /^Drafts/ });
    await user.see({ text: `RE: ${MAIL}` }, { timeoutMs: 30_000 });
    await user.screenshot();
  });

  await step("Alex asks Workbot to save a note, and it is in Alex's Open Drive and Workbot Documents", async () => {
    await openChat();
    await ask(`save "${NOTE_TEXT}" to OneDrive as "${NOTE}"`, `Saved ${NOTE} to your OneDrive.`);
    expect(await world.fileText("alex", NOTE)).toBe(NOTE_TEXT);
    await user.navigate(world.alex.drive);
    await user.see({ text: NOTE }, { timeoutMs: 30_000 });
    await user.screenshot();
    await user.navigate(`${world.url}/documents`);
    await user.see({ text: NOTE }, { timeoutMs: 90_000 });
    evidence.recordAssertionEvidence("Workbot Documents lists the note from Alex's Open Drive", NOTE, await probe.has(NOTE));
    await user.screenshot();
  });

  await step("Casey, signed in to the same workspace, sees none of Alex's changes", async () => {
    await casey.navigate(`${world.url}/calendar`);
    await casey.see({ text: "Northwind / Blue Harbor customer pilot review" }, { timeoutMs: 90_000 });
    await casey.notSee({ text: SUBJECT });
    await casey.screenshot();
    await casey.navigate(`${world.url}/documents`);
    await casey.see({ text: "Northwind-pilot-brief.docx" }, { timeoutMs: 90_000 });
    await casey.notSee({ text: NOTE });
    await casey.screenshot();
    await openChat(casey);
    await ask(`find the meeting "${SUBJECT}"`, `I couldn't find a meeting called "${SUBJECT}"`, casey);
    await casey.screenshot();
    const caseyEvent = await world.event("casey", SUBJECT);
    const caseyDrafts = await world.drafts("casey");
    const caseyFiles = await world.files("casey");
    expect(caseyEvent).toBeNull();
    expect(caseyDrafts.some((draft) => draft.body.includes(REPLY))).toBe(false);
    expect(caseyFiles).not.toContain(NOTE);
    expect(await world.files("alex")).toContain(NOTE);
    evidence.recordAssertionEvidence("Casey's workplace holds none of Alex's event, draft or note", `event: ${caseyEvent ? "found" : "none"}; drafts: ${caseyDrafts.length}; files: ${caseyFiles.join(", ")}`, caseyEvent === null && !caseyDrafts.some((draft) => draft.body.includes(REPLY)) && !caseyFiles.includes(NOTE));
  });
});

import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { lowStorageWarningWorld, type DiskReading } from "../worlds/low-storage-warning.ts";

const test = spec.world(lowStorageWarningWorld, {
  timeout: 600_000,
  resources: { surfaces: ["appWeb"], services: ["den"] },
});

const GB = 1024 ** 3;
const MB = 1024 ** 2;
const TOTAL = 256 * GB;
const almostFull: DiskReading = { freeBytes: 1.4 * GB, totalBytes: TOTAL, level: "low" };
const full: DiskReading = { freeBytes: 120 * MB, totalBytes: TOTAL, level: "critical" };
const roomy: DiskReading = { freeBytes: 180 * GB, totalBytes: TOTAL, level: "ok" };

const ALMOST_FULL = "Your disk is almost full";
const ALMOST_FULL_DETAIL = "1.4 GB left. Free up space so OpenWork can keep saving your work.";
const FULL = "Your disk is full";
const FULL_DETAIL = "120 MB left. OpenWork can't save changes until you free up space.";

/** What the real server said about this machine's disk, in words for the report. */
function realAnswer(raw: string | null): { text: string; measured: boolean } {
  if (!raw) return { text: "no answer", measured: false };
  const value: unknown = JSON.parse(raw);
  const free: unknown = typeof value === "object" && value !== null ? Reflect.get(value, "freeBytes") : null;
  const level: unknown = typeof value === "object" && value !== null ? Reflect.get(value, "level") : null;
  if (typeof free !== "number" || typeof level !== "string") return { text: raw.slice(0, 120), measured: false };
  return { text: `${(free / GB).toFixed(1)} GB free, level ${level}`, measured: free > 0 };
}

test("a member whose disk is almost full is told how much space is left before saving fails", async ({ world, user, probe, step, evidence }) => {
  const askedAtLeastOnce = () => probe.eventually(() => world.asked(), {
    within: 60_000, label: "the app asks its server how much disk is left",
    until: value => value.asked > 0,
  });
  /** The messages on screen, as the member reads them. */
  const messages = async () => (await probe.dom("[data-sonner-toast]")).elements.map(element => element.text.replace(/\s+/g, " ").trim());
  await user.resizeViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });

  await step("before: with 1.4 GB left on the disk, the app says nothing", async () => {
    await world.showDisk(almostFull);
    await user.reload();
    await user.see("composer", { timeoutMs: 60_000 });
    await user.notSee({ text: ALMOST_FULL }, { timeoutMs: 5_000 });
    const { asked } = await world.asked();
    const shown = await messages();
    evidence.recordAssertionEvidence(
      "Without the warning, a nearly full disk goes unmentioned",
      `disk reading on offer: 1.4 GB free of 256 GB; times the app asked for it: ${asked}; messages on screen: ${shown.length}`,
      asked === 0 && shown.length === 0,
    );
    await user.screenshot();
    expect(asked, "the app does not ask about the disk while the warning is off").toBe(0);
    expect(shown).toEqual([]);
  });

  await step("after: with the warning on, a message says the disk is almost full and how much is left", async () => {
    await world.turnOnWarning();
    await user.reload();
    await user.see({ text: ALMOST_FULL }, { timeoutMs: 90_000 });
    await user.see({ text: ALMOST_FULL_DETAIL });
    const { asked, real } = await askedAtLeastOnce();
    const answer = realAnswer(real);
    // Witness: the reading shown is test-owned, so the real server's own answer
    // is what proves it measures the disk it runs on.
    evidence.recordAssertionEvidence(
      "The app asks its server for the space left, and the server measures the real disk",
      `times asked: ${asked}; this machine's server answered: ${answer.text}; the app was shown: 1.4 GB free of 256 GB`,
      asked > 0 && answer.measured,
    );
    await user.screenshot();
    expect(answer.measured, "the real server reports free space on its own disk").toBe(true);
  });

  await step("after: with 120 MB left, the message says the disk is full and saving cannot continue", async () => {
    await world.showDisk(full);
    await user.reload();
    await user.see({ text: FULL }, { timeoutMs: 90_000 });
    await user.see({ text: FULL_DETAIL });
    await user.notSee({ text: ALMOST_FULL });
    const shown = await messages();
    const stronger = shown.length === 1 && shown[0]?.includes(FULL) === true && shown[0].includes(FULL_DETAIL);
    evidence.recordAssertionEvidence(
      "A disk that is nearly out of space gets the stronger message",
      `the app was shown: 120 MB free of 256 GB; messages on screen: ${shown.length}; it reads: ${shown[0] ?? "nothing"}`,
      stronger,
    );
    await user.screenshot();
    expect(stronger, "one message, saying the disk is full and that saving cannot continue").toBe(true);
  });

  await step("a member with plenty of space sees no message", async () => {
    await world.showDisk(roomy);
    await user.reload();
    await user.see("composer", { timeoutMs: 60_000 });
    const { asked } = await askedAtLeastOnce();
    await user.notSee({ text: FULL }, { timeoutMs: 5_000 });
    await user.notSee({ text: ALMOST_FULL });
    const shown = await messages();
    evidence.recordAssertionEvidence(
      "Room on the disk means nothing is shown",
      `the app was shown: 180 GB free of 256 GB; times asked: ${asked}; messages on screen: ${shown.length}`,
      asked > 0 && shown.length === 0,
    );
    await user.screenshot();
    expect(shown).toEqual([]);
  });
});

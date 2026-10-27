import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { defaultDaytonaExec } from "../evals/packages/hosts/src/daytona.ts";
import { attachSurface, browserScript } from "../evals/packages/cdp/src/index.ts";
import { parsePrivatePreview } from "../evals/packages/hosts/src/private-web-preview.ts";
import { control, evalIn, waitFor } from "../evals/packages/behaviors/src/desktop.ts";
import { validateSandboxInfo } from "./workshop-fleet.ts";
import { unlockWorkshopDesktop } from "./lib/workshop-unlock.ts";
import { redactWorkshopDiagnostic } from "./lib/workshop-redaction.ts";

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
export function fleetSeat(value: unknown, attendee: string) {
  assert.match(attendee, /^attendee(?:0[1-9]|1[0-9]|20)$/);
  assert.ok(record(value) && Array.isArray(value.seats));
  const matches = value.seats.filter((seat) => record(seat) && seat.attendee === attendee);
  assert.equal(matches.length, 1, "Attendee is missing or ambiguous in this private manifest");
  const seat = matches[0]; assert.ok(record(seat) && record(seat.sandbox) && typeof seat.sandbox.id === "string");
  assert.match(seat.sandbox.id, /^[0-9a-f-]{36}$/i);
  assert.ok(typeof seat.viewer === "string" && typeof seat.expiresAt === "string");
  assert.ok(Date.parse(seat.expiresAt) > Date.now(), "Workshop has expired; never extend TTL implicitly");
  return { id: seat.sandbox.id, viewer: seat.viewer, expiresAt: seat.expiresAt, attendee };
}
export async function fleetControl(manifest: string, attendee: string, action: string, extra?: string) {
  const value: unknown = JSON.parse(await readFile(manifest, "utf8"));
  const seat = fleetSeat(value, attendee);
  const info = await defaultDaytonaExec(["info", seat.id, "-f", "json"], { timeoutMs: 30_000 });
  assert.equal(info.code, 0, "Owned seat is not available");
  const actual: unknown = JSON.parse(info.stdout); validateSandboxInfo(actual);
  assert.ok(record(actual) && typeof actual.name === "string" && actual.name.startsWith("openwork-connector-workshop-") && actual.name.includes(`-${attendee}-`), "Provider identity does not match the owned workshop seat");
  if (action === "status") return { attendee, state: actual.state, private: true, expiresAt: seat.expiresAt };
  // Opens only the local private card; never prints the viewer capability.
  if (action === "open") return { attendee, privateCard: pathToFileURL(join(dirname(manifest), `${attendee}.html`)).href };
  if (action === "unlock") { await unlockWorkshopDesktop(seat.id); return { attendee, unlocked: true, scope: "owned ephemeral desktop only" }; }
  assert.ok(["stop-turn", "reset-sample-data"].includes(action), "Use status, open, stop-turn, unlock, or reset-sample-data");
  if (action === "reset-sample-data") assert.equal(extra, `--confirm-personal-reset=${attendee}`, "Explicit confirmation is required; this command never resets the whole service");
  const port = action === "stop-turn" ? 9825 : 9222;
  const preview = await defaultDaytonaExec(["preview-url", seat.id, "-p", String(port), "--expires", "900"], { timeoutMs: 30_000 });
  assert.equal(preview.code, 0);
  await using surface = await attachSurface({ name: `fleetctl-${attendee}`, kind: port === 9825 ? "electron" : "chrome", hostKind: "daytona", sandboxId: seat.id, cdpUrl: parsePrivatePreview(preview.stdout, seat.id, port).browserOrigin });
  if (action === "stop-turn") { await control(surface, "composer.stop"); return { attendee, stoppedFocusedTurn: true }; }
  await evalIn(surface, () => { location.href = "https://open-workplace-workshop.onrender.com/_workshop/reset"; return true; });
  await waitFor(surface, () => location.pathname === "/_workshop/reset" && document.readyState === "complete", { timeoutMs: 30_000, label: "owned personal reset page" });
  await evalIn(surface, browserScript(() => {
    const button = [...document.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Reset my sample data");
    if (!button) throw new Error("Personal reset confirmation missing"); button.click(); return true;
  }, []));
  await waitFor(surface, () => location.pathname === "/", { timeoutMs: 60_000, label: "owned personal reset completed" });
  return { attendee, reset: "personal sample data only", otherSeatsTouched: false };
}
if (import.meta.main) {
  const [manifest, attendee, action, extra] = process.argv.slice(2); assert.ok(manifest && attendee && action);
  try { console.log(await fleetControl(manifest, attendee, action, extra)); }
  catch (error) { console.error(redactWorkshopDiagnostic(error instanceof Error ? error.message : String(error), [])); process.exitCode = 1; }
}

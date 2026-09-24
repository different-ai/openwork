import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { isRecord } from "../worlds/openwork-server-cli.ts";
import { LOOKALIKE_ORIGINS, TYPED_ORIGIN, WORKSPACE_ORIGIN, orgWebOrigins } from "../worlds/org-web-origins.ts";

// New journey: an organization owner approves the exact origin of their
// self-hosted OpenWork web instance in Org settings. Members can then be
// handed back to that origin after sign-in and the site can call Den from the
// browser; admins can only read the list, and other organizations, lookalike
// origins, and the removed origin stay refused.
const test = spec.world(orgWebOrigins, {
  timeout: 600_000,
  resources: { surfaces: ["web"], services: ["den"] },
});

const RETURN_URL = `${WORKSPACE_ORIGIN}/`;
const SIGNIN_URL = `${WORKSPACE_ORIGIN}/signin`;

test("an owner approves their self-hosted web origin so members can sign in there, while other sites and other organizations still cannot", async ({ world, user, probe, step, evidence }) => {
  const owner = user.on(world.ownerWeb);
  const admin = user.on(world.adminWeb);
  const phone = user.on(world.ownerPhone);
  const section = { text: "Approved web origins" };
  const summary = { testId: "web-origins-summary-state" };
  const approvedRow = { text: WORKSPACE_ORIGIN };
  const removeButton = { role: "button" as const, label: `Remove ${WORKSPACE_ORIGIN}` };
  const approveButton = { role: "button" as const, label: "Approve origin" };
  // user.see/hover centre their target with scrollIntoView (including inline), so
  // each screenshot first re-centres the section header; locating the truncated
  // origin text on a phone would scroll that one line sideways.
  const frame = async (person: typeof owner) => {
    await person.see(section);
    await person.screenshot();
  };

  const activeOrg = async (session: typeof world.owner) => {
    const result = await probe.api(session, "/v1/me/orgs");
    return isRecord(result.body) && typeof result.body.activeOrgId === "string" ? result.body.activeOrgId : "";
  };
  const approvedOrigins = async () => {
    const result = await probe.api(world.owner, "/v1/org/web-origins", { headers: { "x-openwork-org-id": world.orgId } });
    const origins = isRecord(result.body) && Array.isArray(result.body.origins) ? result.body.origins : [];
    return origins.flatMap((entry) => (isRecord(entry) && typeof entry.origin === "string" ? [entry.origin] : []));
  };

  await step("given a teammate in the owner's organization and an outside account in a different organization", async () => {
    await owner.see(section, { timeoutMs: 90_000 });
    const [teammateOrg, outsiderOrg] = await Promise.all([activeOrg(world.teammate), activeOrg(world.outsider)]);
    const ok = teammateOrg === world.orgId && outsiderOrg === world.outsideOrgId && teammateOrg !== outsiderOrg;
    evidence.recordAssertionEvidence(
      "The teammate and the outside account are signed in to different organizations",
      `teammate active org ${teammateOrg}; outside account active org ${outsiderOrg}; owner's org ${world.orgId}`,
      ok,
    );
    expect(ok).toBe(true);
  });

  await step("before: the owner opens Approved web origins and nothing is approved", async () => {
    await owner.click(section);
    await owner.see(summary, { text: "None" });
    await owner.see({ text: "No origins approved yet." });
    await owner.see({ placeholder: "https://workspace.example.com" });
    await owner.see({ text: "Members who sign in on an approved origin share their OpenWork session with that site." });
    await frame(owner);
  });

  await step(`before: the teammate cannot be sent back to ${WORKSPACE_ORIGIN} and that site gets no browser access`, async () => {
    await owner.see(approveButton);
    const [handoff, preflight] = await Promise.all([world.handoff(world.teammate, RETURN_URL), world.preflight(WORKSPACE_ORIGIN)]);
    const ok = handoff.status === 400 && handoff.error === "invalid_return_url" && handoff.returnUrl === null && preflight.allowOrigin === null;
    evidence.recordAssertionEvidence(
      "Before approval the sign-in handoff and browser access are both refused",
      `POST /v1/auth/desktop-handoff {returnUrl:"${RETURN_URL}"} → ${handoff.status} ${handoff.error}; OPTIONS /v1/me/orgs from ${WORKSPACE_ORIGIN} → ${preflight.status}, Access-Control-Allow-Origin ${preflight.allowOrigin ?? "(absent)"}`,
      ok,
    );
    expect(ok).toBe(true);
  });

  await step(`when the owner types ${TYPED_ORIGIN} and approves it`, async () => {
    await owner.type({ placeholder: "https://workspace.example.com" }, TYPED_ORIGIN);
    await owner.click(approveButton);
    await owner.see(approvedRow, { timeoutMs: 30_000 });
    const origins = await approvedOrigins();
    const ok = origins.length === 1 && origins[0] === WORKSPACE_ORIGIN;
    evidence.recordAssertionEvidence(
      "The typed origin is saved once, in its exact lowercase form without a path",
      `typed "${TYPED_ORIGIN}"; saved ${JSON.stringify(origins)}`,
      ok,
    );
    expect(ok).toBe(true);
  });

  await step(`after: the list shows ${WORKSPACE_ORIGIN} approved by the owner`, async () => {
    await owner.see(summary, { text: "1 origin" });
    await owner.see({ text: /^Approved by Olivia Owner on / });
    await owner.see(removeButton);
    await owner.see({ placeholder: "https://workspace.example.com" }, { value: "" });
    await owner.notSee({ role: "alert" }, { timeoutMs: 2_000 });
    await frame(owner);
  });

  await step(`then the teammate is sent back to ${SIGNIN_URL} and that site gets credentialed browser access`, async () => {
    await owner.see(approvedRow);
    const [handoff, preflight] = await Promise.all([world.handoff(world.teammate, RETURN_URL), world.preflight(WORKSPACE_ORIGIN)]);
    const ok = handoff.status === 200 && handoff.returnUrl === SIGNIN_URL
      && preflight.allowOrigin === WORKSPACE_ORIGIN && preflight.allowCredentials === "true";
    evidence.recordAssertionEvidence(
      "After approval the handoff returns to the origin's sign-in page and browser access is allowed",
      `POST /v1/auth/desktop-handoff → ${handoff.status}, returnUrl ${handoff.returnUrl}; OPTIONS /v1/me/orgs from ${WORKSPACE_ORIGIN} → ${preflight.status}, Access-Control-Allow-Origin ${preflight.allowOrigin}, Access-Control-Allow-Credentials ${preflight.allowCredentials}`,
      ok,
    );
    expect(ok).toBe(true);
  });

  await step("then the owner, who belongs to two organizations, signs in fresh with no organization selected and still lands in the approving one", async () => {
    await owner.see(approvedRow);
    const before = await world.sessionOrgs(world.ownerFreshSignIn);
    const handoff = await world.handoff(world.ownerFreshSignIn, RETURN_URL);
    const exchanged = handoff.grant ? await world.exchange(handoff.grant) : { status: 0, organizationId: null };
    const ok = before.count >= 2 && before.activeOrgId === null
      && handoff.status === 200 && handoff.returnUrl === SIGNIN_URL
      && exchanged.status === 200 && exchanged.organizationId === world.orgId;
    evidence.recordAssertionEvidence(
      "A fresh sign-in with no active organization is handed back into the organization that approved the origin",
      `fresh session: ${before.count} organizations, active ${before.activeOrgId ?? "(none)"}; POST /v1/auth/desktop-handoff → ${handoff.status}, returnUrl ${handoff.returnUrl ?? handoff.error}; exchange → ${exchanged.status}, organization ${exchanged.organizationId ?? "(none)"} (approving org ${world.orgId})`,
      ok,
    );
    expect(ok).toBe(true);
  });

  await step("after: on a phone-width screen the approved origin and its controls fit without sideways scrolling", async () => {
    await phone.see(section, { timeoutMs: 90_000 });
    await phone.reload();
    await phone.see(section, { timeoutMs: 90_000 });
    await phone.click(section);
    await phone.see(removeButton);
    await phone.see(approveButton);
    const page = await probe.on(world.ownerPhone).dom("html");
    const fits = page.documentWidth <= page.viewportWidth;
    evidence.recordAssertionEvidence(
      "The expanded section fits a 390px screen",
      `document scrollWidth ${page.documentWidth}px; viewport width ${page.viewportWidth}px`,
      fits,
    );
    expect(page.documentWidth).toBeLessThanOrEqual(page.viewportWidth);
    await frame(phone);
  });

  await step("an admin sees the approved origin with its controls locked and cannot change it", async () => {
    await admin.reload();
    await admin.see(section, { timeoutMs: 90_000 });
    await admin.click(section);
    await admin.see(approvedRow);
    await admin.see({ text: "Locked. Owners and super-admins can change approved origins." });
    await admin.see(approveButton);
    await admin.see(removeButton);
    await admin.notSee({ text: "Members who sign in on an approved origin share their OpenWork session with that site." }, { timeoutMs: 2_000 });
    const refused = await admin.click(removeButton).then(() => "clicked", (error: unknown) => (error instanceof Error ? error.message : String(error)));
    const locked = await probe.on(world.adminWeb).dom(`input[type="url"]:disabled, button[aria-label="Remove ${WORKSPACE_ORIGIN}"]:disabled`);
    const origins = await approvedOrigins();
    const ok = /disabled/i.test(refused) && locked.elements.length === 2 && origins.length === 1 && origins[0] === WORKSPACE_ORIGIN;
    evidence.recordAssertionEvidence(
      "The admin sees the controls but they are locked and nothing changes",
      `clicking Remove → ${/disabled/i.test(refused) ? "refused (control disabled)" : refused}; disabled origin input and Remove button ${locked.elements.length}/2; approved origins ${JSON.stringify(origins)}`,
      ok,
    );
    expect(ok).toBe(true);
    await frame(admin);
  });

  await step("an outside organization's member and lookalike origins are still refused", async () => {
    await owner.see(approvedRow);
    const outside = await world.handoff(world.outsider, RETURN_URL);
    const lookalikes = await Promise.all(LOOKALIKE_ORIGINS.map(async (origin) => ({
      origin,
      handoff: await world.handoff(world.teammate, `${origin}/`),
      preflight: await world.preflight(origin),
    })));
    const ok = outside.status === 400 && outside.error === "invalid_return_url"
      && lookalikes.every((entry) => entry.handoff.status === 400 && entry.handoff.error === "invalid_return_url" && entry.preflight.allowOrigin === null);
    evidence.recordAssertionEvidence(
      "Approval applies only to the owner's organization and the exact origin",
      [
        `outside org member → ${outside.status} ${outside.error}`,
        ...lookalikes.map((entry) => `teammate → ${entry.origin}: ${entry.handoff.status} ${entry.handoff.error}; CORS allow-origin ${entry.preflight.allowOrigin ?? "(absent)"}`),
      ].join("; "),
      ok,
    );
    expect(ok).toBe(true);
  });

  await step("after: the owner removes the origin and can undo it", async () => {
    await owner.click(removeButton);
    await owner.see({ text: `Removed ${WORKSPACE_ORIGIN}` }, { timeoutMs: 30_000 });
    await owner.see({ role: "button", label: "Undo" });
    await owner.see(summary, { text: "None" });
    await owner.notSee(removeButton, { timeoutMs: 5_000 });
    await frame(owner);
  });

  await step(`after: the teammate can no longer be sent back to ${WORKSPACE_ORIGIN} and browser access ends`, async () => {
    await owner.see({ role: "button", label: "Undo" });
    const [handoff, preflight, origins] = await Promise.all([
      world.handoff(world.teammate, RETURN_URL), world.preflight(WORKSPACE_ORIGIN), approvedOrigins(),
    ]);
    const ok = handoff.status === 400 && handoff.error === "invalid_return_url" && preflight.allowOrigin === null && origins.length === 0;
    evidence.recordAssertionEvidence(
      "Removal refuses the handoff and browser access again",
      `approved origins ${JSON.stringify(origins)}; POST /v1/auth/desktop-handoff → ${handoff.status} ${handoff.error}; OPTIONS /v1/me/orgs from ${WORKSPACE_ORIGIN} → Access-Control-Allow-Origin ${preflight.allowOrigin ?? "(absent)"}`,
      ok,
    );
    expect(ok).toBe(true);
  });
});

import { expect } from "vitest";
import { createAndSelectWorkspace, evalIn, go, waitFor } from "@openwork/behaviors";
import type { Surface } from "@openwork/cdp";
import { desktop } from "@openwork/hosts";
import {
  faultProxy,
  needs,
  server,
  signInDesktopAs,
  test,
  unmetNeeds,
} from "@openwork/testkit";
import type { TestNeeds } from "@openwork/testkit";

const requirements: TestNeeds = { optIn: ["OPENWORK_EVAL_E2E_TESTS"] };
const missingRequirements = unmetNeeds(requirements, process.env);
const title = missingRequirements.length > 0
  ? `Library Add session restore skipped — needs: ${missingRequirements.join(", ")}`
  : "Library Add stays on the requested route and exposes bounded Cloud session restoration";

const addSkillButton = `[...document.querySelectorAll("button")]
  .find((button) => (button.textContent ?? "").trim() === "Add skill")`;
const pendingAddSkill = `(() => {
  const button = ${addSkillButton};
  return button instanceof HTMLButtonElement
    && button.disabled
    && button.getAttribute("aria-busy") === "true"
    && button.getAttribute("aria-label") === "Add skill — Checking session"
    && button.title === "Checking session";
})()`;
const enabledAddSkill = `(() => {
  const button = ${addSkillButton};
  return button instanceof HTMLButtonElement
    && !button.disabled
    && button.getAttribute("aria-busy") !== "true";
})()`;

async function reloadCommitted(surface: Surface, label: string): Promise<number> {
  const previousTimeOrigin = await evalIn(surface, "performance.timeOrigin");
  expect(typeof previousTimeOrigin).toBe("number");
  await evalIn(surface, "location.reload(); true").catch(() => undefined);
  await waitFor(surface, `performance.timeOrigin !== ${JSON.stringify(previousTimeOrigin)}`, {
    timeoutMs: 10_000,
    label,
  });
  return Date.now();
}

test(title, { timeout: 600_000 }, async ({ evidence, place }) => {
  needs(requirements);
  const stamp = Date.now();
  await using den = await server({
    place,
    org: {
      name: `Library session restore ${stamp}`,
      admin: {
        email: `library-session-restore-${stamp}@openwork.test`,
        name: "Library Session Restore Admin",
        password: "OpenWorkEval123!",
      },
    },
  });
  await using proxy = await faultProxy(den.ref, {
    place,
    sandbox: den.placement?.kind === "daytona" ? den.placement.sandboxId : undefined,
  });
  await using surface = await desktop({
    name: "library-add-session-restore",
    host: place.host(),
    bootstrap: {
      baseUrl: proxy.ref.webUrl,
      apiBaseUrl: proxy.ref.webUrl,
      requireSignin: false,
    },
  });

  const selected = await createAndSelectWorkspace(surface, {
    path: `/tmp/openwork-library-session-restore-${stamp}`,
  });
  const skillsRoute = `/workspace/${selected.workspaceId}/extensions/skills`;
  const sessionRoute = `/workspace/${selected.workspaceId}/session`;

  await go(surface, skillsRoute);
  await waitFor(surface, `location.hash.endsWith(${JSON.stringify(skillsRoute)})
    && Boolean(document.querySelector('input[placeholder="Search your library"]'))`, {
    timeoutMs: 30_000,
    label: "signed-out Skills Library",
  });
  const signedOutAddVisible = await evalIn(surface, `Boolean(${addSkillButton})`);
  expect(signedOutAddVisible).toBe(false);
  evidence.recordAssertionEvidence(
    "A truly signed-out Skills Library hides Add skill",
    "The fresh raw desktop rendered the Skills Library without an Add skill button before any Cloud credential was stored.",
    signedOutAddVisible === false,
  );

  await go(surface, sessionRoute);
  await waitFor(surface, `location.hash.endsWith(${JSON.stringify(sessionRoute)})`, {
    timeoutMs: 10_000,
    label: "pre-sign-in session route",
  });
  const navigationInstalled = await evalIn(surface, `(() => {
    window.addEventListener("openwork-den-session-updated", (event) => {
      if (event.detail?.status === "success") {
        window.location.hash = ${JSON.stringify(`#${skillsRoute}`)};
      }
    }, { once: true });
    return true;
  })()`);
  expect(navigationInstalled).toBe(true);
  await signInDesktopAs(surface, proxy.ref, den.admin);
  await waitFor(surface, `location.hash.endsWith(${JSON.stringify(skillsRoute)})`, {
    timeoutMs: 5_000,
    label: "immediate post-sign-in Skills route",
  });
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  const postSignInRoute = await evalIn(surface, "location.hash");
  expect(postSignInRoute).toBe(`#${skillsRoute}`);
  evidence.recordAssertionEvidence(
    "The delayed sign-in redirect preserves newer navigation",
    `The route remained ${postSignInRoute} one second after the successful sign-in event instead of reverting to /session.`,
    postSignInRoute === `#${skillsRoute}`,
  );

  await proxy.faults.latency("/api/den/v1/me", 10_000, { times: 100 });
  const healthyCommittedAt = await reloadCommitted(surface, "slow healthy session reload");
  await waitFor(surface, pendingAddSkill, {
    timeoutMs: 1_000,
    label: "pending Add skill during slow healthy session check",
  });
  const healthyPendingElapsedMs = Date.now() - healthyCommittedAt;
  expect(healthyPendingElapsedMs).toBeLessThanOrEqual(1_000);
  evidence.recordAssertionEvidence(
    "A persisted session exposes pending Add skill immediately",
    `The disabled, busy Add skill button with the accessible “Checking session” label appeared ${healthyPendingElapsedMs}ms after reload.`,
    healthyPendingElapsedMs <= 1_000,
  );

  const healthyBoundMs = 12_750;
  await waitFor(surface, enabledAddSkill, {
    timeoutMs: Math.max(1, healthyBoundMs - (Date.now() - healthyCommittedAt)),
    label: "enabled Add skill after slow healthy session check",
  });
  const healthyEnabledElapsedMs = Date.now() - healthyCommittedAt;
  expect(healthyEnabledElapsedMs).toBeLessThanOrEqual(healthyBoundMs);
  expect(await evalIn(surface, `location.hash.endsWith(${JSON.stringify(skillsRoute)})`)).toBe(true);
  const healthyFaults = (await proxy.requestLog()).filter((request) =>
    request.faulted && request.path.startsWith("/api/den/v1/me")
  );
  expect(healthyFaults.length).toBeGreaterThan(0);
  evidence.recordAssertionEvidence(
    "Slow healthy Cloud confirmation enables Add skill within one timeout plus render margin",
    `A real 10,000ms /v1/me latency was observed and Add skill enabled after ${healthyEnabledElapsedMs}ms without leaving /extensions/skills.`,
    healthyEnabledElapsedMs <= healthyBoundMs && healthyFaults.length > 0,
  );

  await proxy.faults.clear();
  await proxy.faults.latency("/api/den/v1/me", 20_000, { times: 100 });
  const stalledCommittedAt = await reloadCommitted(surface, "stalled session reload");
  await waitFor(surface, pendingAddSkill, {
    timeoutMs: 1_000,
    label: "pending Add skill during stalled session check",
  });
  const stalledPendingElapsedMs = Date.now() - stalledCommittedAt;
  expect(stalledPendingElapsedMs).toBeLessThanOrEqual(1_000);

  const stalledBoundMs = 13_500;
  await waitFor(surface, `${enabledAddSkill}
    && document.body.innerText.includes("OpenWork Cloud is temporarily unavailable.")`, {
    timeoutMs: Math.max(1, stalledBoundMs - (Date.now() - stalledCommittedAt)),
    label: "enabled Add skill after stalled session timeout",
  });
  const stalledEnabledElapsedMs = Date.now() - stalledCommittedAt;
  expect(stalledEnabledElapsedMs).toBeGreaterThanOrEqual(11_500);
  expect(stalledEnabledElapsedMs).toBeLessThanOrEqual(stalledBoundMs);
  expect(await evalIn(surface, `location.hash.endsWith(${JSON.stringify(skillsRoute)})`)).toBe(true);
  evidence.recordAssertionEvidence(
    "A stalled Cloud check retains and enables the persisted session after timeout",
    `With /v1/me delayed 20,000ms, Add skill changed from pending at ${stalledPendingElapsedMs}ms to enabled with the unavailable notice at ${stalledEnabledElapsedMs}ms.`,
    stalledPendingElapsedMs <= 1_000
      && stalledEnabledElapsedMs >= 11_500
      && stalledEnabledElapsedMs <= stalledBoundMs,
  );
});

import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import type { Probe } from "@openwork/testkit";
import {
  SUBMITTED_WORKSPACE_ADDRESS,
  packagedActivatedEgressWorld,
  packagedPreactivationEgressWorld,
} from "../worlds/packaged-preactivation-egress.ts";
import type { EgressRequest } from "../worlds/packaged-preactivation-egress.ts";

/**
 * An enterprise install must not talk to anyone before the person tells it
 * which organization it belongs to. Until the workspace address is submitted
 * the only server the app could reach is a build default — the hosted
 * runtime-config probe at app.openworklabs.com — plus product analytics and
 * Cloud inventory, none of which the organization chose or can see. The
 * renderer made those requests above the activation gate on every fresh boot.
 *
 * Both halves boot the same packaged enterprise binary on a fresh profile
 * behind a refusing proxy that records every non-loopback request. The
 * negative half has no bootstrap and watches a quiet window, then submits a
 * workspace address and checks that only that host is contacted. The positive
 * control seeds an activation stamp for a Den on that same host and shows the
 * same witness does see the runtime-config probe and analytics once activated.
 */
const ACTIVATION_HEADING = "Link this app to your organization";

/**
 * The unfixed build probed runtime-config before first paint and flushed the
 * "app_opened" analytics event 10 s after mount; 25 s leaves margin for a slow
 * renderer boot on top of that flush interval.
 */
const QUIET_WINDOW_MS = 25_000;

/** How long the submitted address may take to produce its first request. */
const SUBMISSION_WINDOW_MS = 20_000;

const SUBMITTED_HOST = new URL(SUBMITTED_WORKSPACE_ADDRESS).hostname;
const ANALYTICS_HOST = "us.i.posthog.com";

const preactivation = spec.world(packagedPreactivationEgressWorld, { timeout: 180_000 });
const activated = spec.world(packagedActivatedEgressWorld, { timeout: 180_000 });

function describeEgress(requests: readonly EgressRequest[]): string {
  return JSON.stringify(requests.map((request) => `${request.method} ${request.target}`));
}

async function requireEnterpriseFlavor(world: { flavor: () => Promise<string | null> }, probe: Probe) {
  const flavor = await probe.eventually(() => world.flavor(), {
    within: 30_000,
    label: "packaged distribution flavor",
    until: (value) => value !== null,
  });
  if (flavor !== "enterprise") {
    throw new Error(`Activation gates only the enterprise flavor; OPENWORK_EVAL_ELECTRON_BINARY points at a ${flavor ?? "unknown"} build`);
  }
}

preactivation("an unactivated enterprise install makes no request outside loopback until a workspace address is submitted", async ({ world, user, probe, evidence }) => {
  await requireEnterpriseFlavor(world, probe);
  await probe.eventually(() => world.rootText(), {
    within: 60_000,
    label: "enterprise activation gate mounted in #root",
    until: (text) => text.includes(ACTIVATION_HEADING),
  });
  await user.see({ text: ACTIVATION_HEADING });

  // The renderer is up. Watch the proxy for the whole quiet window, stopping
  // early only if a request does appear.
  const quietUntil = Date.now() + QUIET_WINDOW_MS;
  const beforeSubmission = await probe.eventually(() => world.egress(), {
    within: QUIET_WINDOW_MS + 10_000,
    intervalMs: 1_000,
    label: "non-loopback requests before a workspace address is submitted",
    until: (requests) => requests.length > 0 || Date.now() >= quietUntil,
  });
  // The install is still unactivated at the end of the window, so any request
  // above went to a host nobody chose.
  await user.see({ text: ACTIVATION_HEADING });
  await user.screenshot();

  expect(beforeSubmission, `requests left loopback before a workspace address was submitted: ${describeEgress(beforeSubmission)}`).toEqual([]);
  evidence.recordAssertionEvidence(
    `An unactivated enterprise install makes no non-loopback request within ${QUIET_WINDOW_MS / 1000}s of showing "${ACTIVATION_HEADING}"`,
    `proxy log: ${describeEgress(beforeSubmission)}`,
    beforeSubmission.length === 0,
  );

  // Submitting a workspace address is the moment the organization server
  // becomes known. A pasted sign-in link names that server and finishes in
  // the app itself, so the exchange contacts the submitted host and nothing
  // else — and the witness proves it sees renderer traffic at all.
  const signInLink = `openwork://den-auth?grant=eval-grant-refused-by-witness&denBaseUrl=${encodeURIComponent(SUBMITTED_WORKSPACE_ADDRESS)}`;
  await user.type({ testId: "organization-server-input" }, signInLink);
  await user.click({ testId: "organization-server-continue" });
  await user.see({ text: `Connect this app to ${SUBMITTED_WORKSPACE_ADDRESS}?` });
  await user.click({ testId: "organization-server-confirm" });

  const afterSubmission = await probe.eventually(() => world.egress(), {
    within: SUBMISSION_WINDOW_MS,
    intervalMs: 500,
    label: `a request to the submitted workspace address ${SUBMITTED_HOST}`,
    until: (requests) => requests.some((request) => request.host === SUBMITTED_HOST),
  });
  // The proxy refused the exchange, so activation is still pending: the gate
  // stays up and analytics must still be silent.
  await user.see({ text: ACTIVATION_HEADING });
  await user.screenshot();

  const foreignHosts = [...new Set(afterSubmission.filter((request) => request.host !== SUBMITTED_HOST).map((request) => request.host))];
  expect(afterSubmission.some((request) => request.host === SUBMITTED_HOST), "the submitted workspace address was never contacted").toBe(true);
  expect(foreignHosts, `hosts other than the submitted workspace address were contacted: ${describeEgress(afterSubmission)}`).toEqual([]);
  evidence.recordAssertionEvidence(
    `After a workspace address is submitted, the install contacts only ${SUBMITTED_HOST}`,
    `proxy log: ${describeEgress(afterSubmission)}`,
    foreignHosts.length === 0 && afterSubmission.length > 0,
  );
});

activated("an activated enterprise install still resolves its Den and reports analytics", async ({ world, user, probe, evidence }) => {
  await requireEnterpriseFlavor(world, probe);

  // Same binary, same witness. Activation is complete at boot, so the
  // runtime-config probe for the activated Den happens during bootstrap and
  // the "app_opened" analytics batch flushes within the 10 s interval.
  const requests = await probe.eventually(() => world.egress(), {
    within: 90_000,
    intervalMs: 1_000,
    label: "Den runtime-config probe and analytics flush after activation",
    until: (value) => value.some((request) => request.host === SUBMITTED_HOST)
      && value.some((request) => request.host === ANALYTICS_HOST),
  });
  const rootText = await world.rootText();
  await user.notSee({ text: ACTIVATION_HEADING }, { timeoutMs: 1_000 });
  await user.screenshot();

  expect(rootText, "the activation gate must not be on screen for an activated install").not.toContain(ACTIVATION_HEADING);
  expect(requests.some((request) => request.host === SUBMITTED_HOST), `the activated Den was never contacted: ${describeEgress(requests)}`).toBe(true);
  expect(requests.some((request) => request.host === ANALYTICS_HOST), `analytics never flushed after activation: ${describeEgress(requests)}`).toBe(true);
  evidence.recordAssertionEvidence(
    `An activated enterprise install contacts its Den (${SUBMITTED_HOST}) and flushes analytics (${ANALYTICS_HOST}) without any user action`,
    `proxy log: ${describeEgress(requests)}`,
    requests.some((request) => request.host === SUBMITTED_HOST) && requests.some((request) => request.host === ANALYTICS_HOST),
  );
});

import { denFetch } from "@openwork/behaviors";
import { expect } from "vitest";
import { localMysqlIsRunning, needs, server, test } from "@openwork/testkit";

const appSpecsEnabled = process.env.OPENWORK_EVAL_APP_SPECS === "1";
const localPlacement = process.env.OPENWORK_EVAL_DAYTONA !== "1" && !process.env.OPENWORK_EVAL_DEN_API_URL?.trim();
const mysqlOpen = await localMysqlIsRunning();
const title = !appSpecsEnabled
  ? "shared-domain login rate limit skipped — needs: set OPENWORK_EVAL_APP_SPECS=1"
  : !localPlacement
    ? "shared-domain login rate limit skipped — needs local placement without OPENWORK_EVAL_DEN_API_URL"
    : !mysqlOpen
      ? "shared-domain login rate limit skipped — needs MySQL on 127.0.0.1:3306"
      : "coworkers sharing an email domain keep independent login-option rate limits";

function statusDistribution(statuses: number[]): string {
  const counts = new Map<number, number>();
  for (const status of statuses) counts.set(status, (counts.get(status) ?? 0) + 1);
  return [...counts.entries()]
    .sort(([first], [second]) => first - second)
    .map(([status, count]) => `${status}: ${count}`)
    .join(", ");
}

test.skipIf(!appSpecsEnabled || !localPlacement || !mysqlOpen)(title, async ({ evidence, place }) => {
  needs({ optIn: ["OPENWORK_EVAL_APP_SPECS"] });

  const unique = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const domain = `shared-${unique}.example.test`;
  const singleEmail = `single-${unique}@positive-control.test`;
  const coworkerEmail = (index: number) => `coworker-${index}@${domain}`;
  await using den = await server({
    place,
    org: {
      name: `Shared Domain ${unique}`,
      members: {
        coworker0: { email: coworkerEmail(0) },
        coworker1: { email: coworkerEmail(1) },
        coworker2: { email: coworkerEmail(2) },
        coworker3: { email: coworkerEmail(3) },
        coworker4: { email: coworkerEmail(4) },
        single: { email: singleEmail },
      },
    },
  });
  const coworkerStatuses: number[] = [];

  // These provisioned accounts do not consume the domain-miss bucket; each coworker also gets a stable IP.
  for (let request = 0; request < 25; request += 1) {
    const coworker = request % 5;
    const result = await denFetch(
      den.ref,
      `/v1/auth/login-options?email=${encodeURIComponent(coworkerEmail(coworker))}`,
      { headers: { "x-forwarded-for": `198.51.100.${coworker + 1}` } },
    );
    coworkerStatuses.push(result.response.status);
  }

  expect(coworkerStatuses).not.toContain(429);
  expect(coworkerStatuses.every((status) => status === 200)).toBe(true);
  evidence.fact(
    "Coworkers at one domain do not exhaust a shared domain bucket",
    `Observed 25 requests across 5 provisioned accounts with status distribution ${statusDistribution(coworkerStatuses)}.`,
    !coworkerStatuses.includes(429),
  );

  const singleEmailStatuses: number[] = [];
  // This is also a provisioned account; vary the forwarded address so only the per-email bucket can trigger.
  for (let request = 0; request < 25; request += 1) {
    const result = await denFetch(
      den.ref,
      `/v1/auth/login-options?email=${encodeURIComponent(singleEmail)}`,
      { headers: { "x-forwarded-for": `203.0.113.${request + 1}` } },
    );
    singleEmailStatuses.push(result.response.status);
  }

  expect(singleEmailStatuses).toContain(429);
  evidence.fact(
    "The per-email abuse limiter remains active",
    `Observed 25 requests for one email from distinct forwarded addresses with status distribution ${statusDistribution(singleEmailStatuses)}.`,
    singleEmailStatuses.includes(429),
  );

  const enumerationStatuses: number[] = [];
  // Every probe is a distinct nonexistent address from a distinct forwarded address, isolating the
  // domain-miss bucket (30 per 10 minutes), so exceeding it proves account discovery stays bounded
  // even when an attacker spreads across IP addresses and never repeats an address.
  const enumerationProbes = 40;
  for (let request = 0; request < enumerationProbes; request += 1) {
    const result = await denFetch(
      den.ref,
      `/v1/auth/login-options?email=${encodeURIComponent(`nonexistent-${request}@${domain}`)}`,
      { headers: { "x-forwarded-for": `192.0.2.${request + 1}` } },
    );
    enumerationStatuses.push(result.response.status);
  }

  expect(enumerationStatuses).toContain(429);
  evidence.fact(
    "Distinct nonexistent addresses at one domain are throttled",
    `Observed ${enumerationProbes} nonexistent emails from distinct forwarded addresses with status distribution ${statusDistribution(enumerationStatuses)}.`,
    enumerationStatuses.includes(429),
  );
});

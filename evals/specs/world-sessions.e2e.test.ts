import { expect } from "vitest";
import { listSessions, seedSessions } from "@openwork/behaviors";
import { app, createAdmin, createOrg, needs, server, test } from "@openwork/testkit";

const titles: readonly string[] = ["Q3 report", "Invoice cleanup"];

test("a script world seeds desktop sessions", { timeout: 300_000 }, async ({ evidence, place }) => {
  needs({ optIn: ["OPENWORK_EVAL_WORLD_SESSIONS_E2E"] });

  await using stack = new AsyncDisposableStack();
  const den = stack.use(await server({ place, provision: false, web: true }));
  await createAdmin(den, {});
  stack.use(await createOrg(den, "acme"));
  const desktop = stack.use(await app({ den, place, as: "admin" }));
  await seedSessions(desktop, titles);

  const observed = await listSessions(desktop);
  for (const title of titles) {
    expect(observed.some((session) => session.title === title)).toBe(true);
  }
  evidence.recordAssertionEvidence(
    "The desktop exposes every directly seeded session",
    `Observed the seeded session titles: ${titles.join(", ")}.`,
    true,
  );
});

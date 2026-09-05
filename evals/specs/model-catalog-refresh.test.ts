import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { modelCatalogRefresh } from "../worlds/model-catalog-refresh.ts";

const test = spec.world(modelCatalogRefresh, { timeout: 60_000 });

function catalog(ids: string[]) {
  return {
    "fixture-provider": {
      id: "fixture-provider",
      name: "Fixture provider",
      models: Object.fromEntries(ids.map((id) => [id, {
        id, name: id,
        modalities: { input: ["text"], output: ["text"] },
        limit: { context: 8192, output: 1024 },
      }])),
    },
  };
}

test("catalog refresh replaces retired models, keeps unchanged models, and rejects bad upstream responses", async ({ world, evidence }) => {
  expect(await world.refresh(catalog(["retired", "retained"]))).toBe(true);
  expect(await world.automaticApproval()).toBe(false);
  const next = catalog(["new-model", "retained"]);
  expect(await world.refresh(next)).toBe(true);
  expect(await world.automaticApproval()).toBe(true);
  const saved = await world.snapshot();
  expect(JSON.parse(saved)).toEqual(next);
  expect(saved).not.toContain("retired");
  evidence.recordAssertionEvidence(
    "A valid upstream snapshot adds new models and removes retired models while preserving retained metadata",
    "Two real updater processes fetched successive HTTP catalogs. The saved snapshot equals the second catalog exactly; the retired identifier is absent.", true,
  );
  expect(await world.refresh(next)).toBe(true);
  expect(await world.snapshot()).toBe(saved);
  evidence.recordAssertionEvidence("An unchanged catalog produces no snapshot diff", "A third refresh produced identical bytes.", true);

  for (const [payload, status] of [[{}, 200], [catalog([]), 200], [next, 503], [{ broken: true }, 200]] as const) {
    expect(await world.refresh(payload, status)).toBe(false);
    expect(await world.snapshot()).toBe(saved);
  }
  expect(world.requests()).toBe(7);
  evidence.recordAssertionEvidence(
    "An empty, malformed, or unavailable upstream cannot replace the last valid snapshot",
    "All four rejected responses left the saved catalog byte-for-byte unchanged; all seven attempts reached the HTTP boundary.", true,
  );
  const routingChanges = [
    { ...next, "new-provider": { ...next["fixture-provider"], id: "new-provider" } },
    { "fixture-provider": { ...next["fixture-provider"], api: "https://routing.example.test" } },
    { "fixture-provider": { ...next["fixture-provider"], env: ["FIXTURE_CHANGED_KEY"] } },
    { "fixture-provider": { ...next["fixture-provider"], npm: "fixture-adapter" } },
    { "fixture-provider": { ...next["fixture-provider"], models: {
      ...next["fixture-provider"].models,
      "new-model": { ...next["fixture-provider"].models["new-model"], provider: { api: "https://routing.example.test" } },
    } } },
  ];
  for (const changed of routingChanges) {
    expect(await world.refresh(next)).toBe(true);
    expect(await world.refresh(changed)).toBe(true);
    expect(JSON.parse(await world.snapshot())).toEqual(changed);
    expect(await world.automaticApproval()).toBe(false);
  }
  evidence.recordAssertionEvidence(
    "New providers and changed endpoints, credential mappings, adapters, or model routing require human review",
    "Five structurally valid routing changes produced reviewable snapshots but each emitted safe_to_approve=false. A missing baseline also required review; ordinary model additions and removals emitted true.", true,
  );
});

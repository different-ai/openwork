import assert from "node:assert/strict";
import { test } from "node:test";
import { pickTestModel, sortModelsNewestFirst, type GatewayCatalogModel } from "./gateway-provider-models";

const model = (id: string, config: Record<string, unknown>): GatewayCatalogModel => ({ id, name: id, config });
const catalog = [
  model("alpha-old", { release_date: "2024-10-22" }),
  model("beta-new", { release_date: "2026-10-07" }),
  model("gamma-mid", { release_date: "2026-02" }),
  model("delta-undated", {}),
  model("epsilon-newest-deprecated", { release_date: "2026-10-20", status: "deprecated" }),
  model("zeta-image", { release_date: "2026-10-25", type: "image" }),
];

test("models are listed newest release first, undated last", () => {
  assert.deepEqual(sortModelsNewestFirst(catalog).map((entry) => entry.id), ["zeta-image", "epsilon-newest-deprecated", "beta-new", "gamma-mid", "alpha-old", "delta-undated"]);
});

test("all models: the test uses the newest model that can answer a text prompt", () => {
  assert.equal(pickTestModel(sortModelsNewestFirst(catalog), null), "beta-new");
});

test("only the ones I pick: the newest picked text model, falling back to the first picked", () => {
  const sorted = sortModelsNewestFirst(catalog);
  assert.equal(pickTestModel(sorted, ["alpha-old", "gamma-mid"]), "gamma-mid");
  assert.equal(pickTestModel(sorted, ["zeta-image"]), "zeta-image");
  assert.equal(pickTestModel(sorted, []), null);
});

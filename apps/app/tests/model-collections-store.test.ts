import { describe, expect, test } from "bun:test";

import type { ModelRef } from "../src/app/types";
import {
  MAX_RECENT_MODELS,
  nextFavoriteModel,
  recordRecentModel,
  toggleFavoriteModels,
} from "../src/react-app/domains/session/models/model-collections-store";

const model = (modelID: string): ModelRef => ({ providerID: "provider", modelID });

describe("model collections", () => {
  test("adds and removes favorites without reordering the rest", () => {
    expect(toggleFavoriteModels([model("a")], model("b"))).toEqual([model("a"), model("b")]);
    expect(toggleFavoriteModels([model("a"), model("b")], model("a"))).toEqual([model("b")]);
  });

  test("keeps recent models unique, newest-first, and capped", () => {
    let recent: ModelRef[] = [];
    for (let index = 0; index < MAX_RECENT_MODELS + 2; index += 1) {
      recent = recordRecentModel(recent, model(String(index)));
    }
    recent = recordRecentModel(recent, model("3"));

    expect(recent).toHaveLength(MAX_RECENT_MODELS);
    expect(recent.map((entry) => entry.modelID)).toEqual(["3", "6", "5", "4", "2"]);
  });

  test("cycles favorites, wraps, and selects the first when current is not a favorite", () => {
    const favorites = [model("a"), model("b"), model("c")];

    expect(nextFavoriteModel(favorites, model("a"))).toEqual(model("b"));
    expect(nextFavoriteModel(favorites, model("c"))).toEqual(model("a"));
    expect(nextFavoriteModel(favorites, model("outside"))).toEqual(model("a"));
    expect(nextFavoriteModel([model("a")], model("a"))).toBeNull();
  });
});

import { expect, test } from "bun:test";

import type { ModelOption } from "../src/app/types";
import {
  AUTO_MODEL_ID,
  AUTO_PROVIDER_ID,
  AUTO_ROUTER_GROUP,
  isAutoModel,
  isAutoRouterModel,
  managesOwnBehavior,
  modelGroups,
  modelSource,
  modelSubtitle,
  modelTitle,
  nonDefaultModelSummary,
  publicModelTitle,
} from "../src/react-app/domains/models/model-catalog";

function option(providerID: string, modelID: string, title: string, description: string): ModelOption {
  return { providerID, modelID, title, description, behaviorTitle: "Effort", behaviorLabel: "Default", behaviorDescription: "", behaviorValue: null, isFree: false };
}

const router = option("openwork-auto", "openwork-auto", "Auto", "Auto");
const free = { ...option(AUTO_PROVIDER_ID, AUTO_MODEL_ID, "GPT-6 Luna", "OpenWork Models (Free)"), isFree: true };
const opus = option("anthropic", "opus", "Claude Opus", "Anthropic");

test("Auto is the first entry, in its own group, even when pinned or recent", () => {
  const groups = modelGroups([opus, free, router], [router], [router]);
  expect(groups[0]).toEqual({ value: AUTO_ROUTER_GROUP, items: [router] });
  expect(groups.slice(1).flatMap((group) => group.items).some(isAutoRouterModel)).toBe(false);
});

test("Auto and OpenWork Free are told apart", () => {
  expect(isAutoRouterModel(router)).toBe(true);
  expect(isAutoModel(router)).toBe(false);
  expect(isAutoRouterModel(free)).toBe(false);
  expect(isAutoModel(free)).toBe(true);
  expect(modelTitle(router)).toBe("Auto");
  expect(modelTitle(free)).toBe("OpenWork Free");
  expect(publicModelTitle(free)).toBe("OpenWork Free");
  expect(modelSubtitle(router)).toBe("Picks the best model for each task");
});

test("Auto is an OpenWork Gateway model with no effort of its own", () => {
  expect(modelSource({ ...router, source: "cloud" })).toBe("gateway");
  expect(managesOwnBehavior(router)).toBe(true);
  expect(nonDefaultModelSummary(router, "high", "High")).toBeNull();
  expect(nonDefaultModelSummary(opus, "high", "High")).toBe("High");
});

test("without an Auto Router there is no Auto group", () => {
  expect(modelGroups([opus, free], [], []).some((group) => group.value === AUTO_ROUTER_GROUP)).toBe(false);
});

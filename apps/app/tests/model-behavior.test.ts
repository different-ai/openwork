import { describe, expect, test } from "bun:test";

import type { ProviderListItem } from "../src/app/types";
import {
  getModelBehaviorOptions,
  getModelBehaviorSummary,
  normalizeModelBehaviorValue,
  sanitizeModelBehaviorValue,
  nextModelBehaviorValue,
  previousModelBehaviorValue,
} from "../src/app/lib/model-behavior";

type ProviderModel = ProviderListItem["models"][string];

const model: ProviderModel = {
  id: "test-model",
  providerID: "openai",
  api: {
    id: "test-model",
    url: "https://example.com",
    npm: "@ai-sdk/openai-compatible",
  },
  name: "Test model",
  capabilities: {
    temperature: true,
    reasoning: true,
    attachment: false,
    toolcall: true,
    input: {
      text: true,
      audio: false,
      image: false,
      video: false,
      pdf: false,
    },
    output: {
      text: true,
      audio: false,
      image: false,
      video: false,
      pdf: false,
    },
    interleaved: false,
  },
  cost: {
    input: 0,
    output: 0,
    cache: {
      read: 0,
      write: 0,
    },
  },
  limit: {
    context: 1,
    output: 1,
  },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
  variants: {
    none: {},
    low: {},
    medium: {},
    high: {},
    xhigh: {},
    max: {},
  },
};

describe("model behavior options", () => {
  test("preserves opaque variant IDs through selection and saved-value normalization", () => {
    const custom = { ...model, variants: { CustomExact: {}, default: {}, high: {} } };
    expect(getModelBehaviorOptions("openai", custom).map((option) => option.value)).toEqual([null, "high", "CustomExact", "default"]);
    for (const value of ["CustomExact", "default"]) {
      const restored = normalizeModelBehaviorValue(value);
      expect(restored).toBe(value);
      expect(getModelBehaviorSummary("openai", custom, restored).value).toBe(value);
    }
    expect(normalizeModelBehaviorValue(null)).toBeNull();
    expect(normalizeModelBehaviorValue("")).toBeNull();
  });

  test("uses only the raw effort values reported by the model", () => {
    const options = getModelBehaviorOptions("openai", model);

    expect(options.map(({ value, label }) => ({ value, label }))).toEqual([
      { value: null, label: "Default" },
      { value: "none", label: "None" },
      { value: "low", label: "Low" },
      { value: "medium", label: "Medium" },
      { value: "high", label: "High" },
      { value: "xhigh", label: "Xhigh" },
      { value: "max", label: "Max" },
    ]);
  });

  test("cycles effort values through Default and wraps", () => {
    const options = getModelBehaviorOptions("openai", model);

    expect(nextModelBehaviorValue(options, "low")).toBe("medium");
    expect(nextModelBehaviorValue(options, "max")).toBeNull();
    expect(nextModelBehaviorValue(options, null)).toBe("none");
  });

  test("does not cycle models with fewer than two effort values", () => {
    expect(nextModelBehaviorValue([], null)).toBeNull();
    expect(nextModelBehaviorValue([{ value: "high" }], "high")).toBeNull();
  });

  test("cycles explicit effort values backward and wraps", () => {
    const options = getModelBehaviorOptions("openai", model);

    expect(previousModelBehaviorValue(options, "medium")).toBe("low");
    expect(previousModelBehaviorValue(options, "none")).toBeNull();
    expect(previousModelBehaviorValue(options, null)).toBe("max");
  });

  test("does not cycle backward with fewer than two effort values", () => {
    expect(previousModelBehaviorValue([], null)).toBeNull();
    expect(previousModelBehaviorValue([{ value: "high" }], "high")).toBeNull();
  });

  test("Default is not replaced with a guessed medium effort", () => {
    for (const value of [null, "high", null]) {
      const summary = getModelBehaviorSummary("openwork", model, value);
      expect(summary.value).toBe(value);
      expect(summary.label).toBe(value === null ? "Default" : "High");
      expect(summary.options.filter((option) => option.value === value)).toHaveLength(1);
    }
    const single = getModelBehaviorOptions("openwork", { ...model, variants: { high: {} } });
    expect(nextModelBehaviorValue(single, null)).toBe("high");
    expect(nextModelBehaviorValue(single, "high")).toBeNull();
  });

  test("preserves stale and malformed same-model settings with a visible advisory and Default recovery", () => {
    for (const configuration of [model, { ...model, variants: {} }, undefined]) {
      for (const value of ["retired-effort", " High ", "", "\n"]) {
        const summary = getModelBehaviorSummary("openwork", configuration, value);
        expect(summary.value).toBe(value);
        expect(summary.label).toContain(JSON.stringify(value));
        expect(summary.label).toContain("not in current catalog");
        expect(summary.description).toContain("kept unchanged");
        expect(summary.description).not.toContain("reject");
        expect(summary.options[0]).toMatchObject({ value: null, label: "Default" });
        expect(summary.options.some((option) => option.value === value)).toBe(false);
      }
    }
  });

  test("explicit model switches only carry variants supplied by the target configuration", () => {
    const target = { ...model, variants: { low: {}, CustomEffort: {} } };
    for (const provider of ["openwork", "lpr_custom"]) {
      expect(sanitizeModelBehaviorValue(provider, target, "high")).toBeNull();
      expect(sanitizeModelBehaviorValue(provider, target, null)).toBeNull();
      expect(sanitizeModelBehaviorValue(provider, target, "low")).toBe("low");
      expect(sanitizeModelBehaviorValue(provider, target, "CustomEffort")).toBe("CustomEffort");
      expect(getModelBehaviorOptions(provider, target).map((option) => option.value)).toEqual([null, "low", "CustomEffort"]);
    }
    expect(sanitizeModelBehaviorValue("openwork", { ...model, variants: {} }, "high")).toBeNull();
    expect(getModelBehaviorOptions("openwork", { ...model, id: "future-model", variants: { newEffort: {} } })
      .map((option) => option.value)).toEqual([null, "newEffort"]);
  });
});

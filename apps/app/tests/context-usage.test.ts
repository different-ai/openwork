import { describe, expect, test } from "bun:test";
import type { MessageTokens } from "../src/app/types";
import {
  buildContextUsage,
  compactionCeiling,
  contextLimitFor,
  contextUsagePercent,
  contextUsageTone,
  formatTokens,
  latestMeasuredUsage,
  measuredContextTokens,
  pickMeasuredUsage,
  readCompactionSettings,
} from "../src/react-app/domains/session/surface/composer/context-usage";

const tokens = (input: number, output: number, extra: Partial<MessageTokens> = {}): MessageTokens => ({
  input,
  output,
  reasoning: 0,
  cache: { read: 0, write: 0 },
  ...extra,
});

describe("measuredContextTokens", () => {
  test("v1 uses the provider total as recorded from OpenCode 1.18.30", () => {
    expect(measuredContextTokens(tokens(8583, 12, { total: 8595 }), "v1")).toBe(8595);
  });

  test("v1 without a total sums input, output and cache, and leaves reasoning out", () => {
    expect(measuredContextTokens(tokens(1000, 50, { reasoning: 400, cache: { read: 300, write: 20 } }), "v1")).toBe(1370);
  });

  test("v2 sums every field, as recorded from OpenCode 2.0.26", () => {
    expect(measuredContextTokens(tokens(5596, 12), "v2")).toBe(5608);
    expect(measuredContextTokens(tokens(1000, 50, { reasoning: 400, cache: { read: 300, write: 20 } }), "v2")).toBe(1770);
  });
});

describe("compactionCeiling", () => {
  // The first two rows are the thresholds bracketed against the pinned binaries in M0.
  test("v1 reserves the output limit when the model has no input limit", () => {
    expect(compactionCeiling("v1", { context: 40_000, output: 4_000 })).toBe(36_000);
    expect(compactionCeiling("v1", { context: 100_000, output: 8_000 })).toBe(92_000);
  });

  test("v1 caps the output reserve at 32000 and falls back to it for an unknown output limit", () => {
    expect(compactionCeiling("v1", { context: 1_000_000, output: 131_072 })).toBe(968_000);
    expect(compactionCeiling("v1", { context: 200_000, output: 0 })).toBe(168_000);
  });

  test("v1 with an input limit keeps min(20000, output) free below it, or the configured reserve", () => {
    expect(compactionCeiling("v1", { context: 200_000, input: 190_000, output: 8_000 })).toBe(182_000);
    expect(compactionCeiling("v1", { context: 200_000, input: 190_000, output: 64_000 })).toBe(170_000);
    expect(compactionCeiling("v1", { context: 200_000, input: 190_000, output: 8_000 }, { reserved: 10_000 })).toBe(180_000);
  });

  test("v2 keeps 15% free, at least 16000 for windows of 32000 and more", () => {
    expect(compactionCeiling("v2", { context: 40_000, output: 4_000 })).toBe(24_000);
    expect(compactionCeiling("v2", { context: 200_000, output: 8_000 })).toBe(170_000);
    expect(compactionCeiling("v2", { context: 1_000_000, output: 8_000 })).toBe(850_000);
    expect(compactionCeiling("v2", { context: 20_000, output: 4_000 })).toBe(17_000);
  });

  test("v2 prefers the input limit and an explicit buffer", () => {
    expect(compactionCeiling("v2", { context: 200_000, input: 100_000, output: 8_000 })).toBe(84_000);
    expect(compactionCeiling("v2", { context: 200_000, output: 8_000 }, { buffer: 5_000 })).toBe(195_000);
  });

  test("never compacts with auto-compaction off or an unknown window", () => {
    expect(compactionCeiling("v1", { context: 100_000, output: 8_000 }, { auto: false })).toBeNull();
    expect(compactionCeiling("v2", { context: 100_000, output: 8_000 }, { auto: false })).toBeNull();
    expect(compactionCeiling("v1", { context: 0, output: 8_000 })).toBeNull();
    expect(compactionCeiling("v2", { context: 0, output: 8_000 })).toBeNull();
  });
});

describe("contextUsagePercent", () => {
  test("rounds and clamps to 0..100", () => {
    expect(contextUsagePercent(34_000, 100_000)).toBe(34);
    expect(contextUsagePercent(33_501, 100_000)).toBe(34);
    expect(contextUsagePercent(150_000, 100_000)).toBe(100);
    expect(contextUsagePercent(-5, 100_000)).toBe(0);
  });

  test("has no percentage for an unknown window", () => {
    expect(contextUsagePercent(12_000, 0)).toBeNull();
  });
});

describe("contextUsageTone", () => {
  const window = 100_000;
  const ceiling = 85_000;

  test("is neutral below 70% of the window", () => {
    expect(contextUsageTone({ used: 0, window, ceiling })).toBe("neutral");
    expect(contextUsageTone({ used: 69_999, window, ceiling })).toBe("neutral");
  });

  test("warns from 70% of the window", () => {
    expect(contextUsageTone({ used: 70_000, window, ceiling })).toBe("warning");
    expect(contextUsageTone({ used: 79_999, window, ceiling })).toBe("warning");
  });

  test("turns strong 5% of the window before the compaction ceiling", () => {
    expect(contextUsageTone({ used: 80_000, window, ceiling })).toBe("strong");
    expect(contextUsageTone({ used: 99_000, window, ceiling })).toBe("strong");
  });

  test("follows a low ceiling even before the first step", () => {
    expect(contextUsageTone({ used: 55_000, window, ceiling: 60_000 })).toBe("strong");
  });

  test("without a ceiling only the first step exists", () => {
    expect(contextUsageTone({ used: 69_999, window, ceiling: null })).toBe("neutral");
    expect(contextUsageTone({ used: 99_999, window, ceiling: null })).toBe("warning");
  });

  test("an unknown window is neutral", () => {
    expect(contextUsageTone({ used: 50_000, window: 0, ceiling: null })).toBe("neutral");
  });
});

describe("latestMeasuredUsage", () => {
  test("returns the latest assistant message that reports usage", () => {
    const messages = [
      { info: { id: "u1", role: "user" } },
      { info: { id: "a1", role: "assistant", tokens: tokens(5596, 12) } },
      { info: { id: "u2", role: "user" } },
      { info: { id: "a2", role: "assistant", tokens: tokens(5789, 12) } },
      { info: { id: "u3", role: "user" } },
    ];
    expect(latestMeasuredUsage(messages, "v2")?.messageId).toBe("a2");
  });

  test("skips an unfinished message that still reports zeros", () => {
    const messages = [
      { info: { id: "a1", role: "assistant", tokens: tokens(5596, 12) } },
      { info: { id: "a2", role: "assistant", tokens: tokens(0, 0) } },
    ];
    expect(latestMeasuredUsage(messages, "v1")?.messageId).toBe("a1");
  });

  test("returns null without any measurement", () => {
    expect(latestMeasuredUsage([{ info: { id: "u1", role: "user" } }, { info: { id: "a1", role: "assistant" } }], "v1")).toBeNull();
    expect(latestMeasuredUsage([], "v2")).toBeNull();
  });
});

describe("contextLimitFor", () => {
  const providers = {
    all: [
      { id: "fake", models: { "ctx-model": { limit: { context: 100_000, output: 8_000 } }, unknown: { limit: { context: 0, output: 0 } }, bare: {} } },
      { id: "wide", models: { m: { limit: { context: 200_000, input: 190_000, output: 8_000 } } } },
    ],
  };

  test("reads the window of the selected model", () => {
    expect(contextLimitFor(providers, { providerID: "fake", modelID: "ctx-model" })).toEqual({ context: 100_000, output: 8_000 });
    expect(contextLimitFor(providers, { providerID: "wide", modelID: "m" })).toEqual({ context: 200_000, input: 190_000, output: 8_000 });
  });

  test("is null for a missing catalog, provider, model or a reported window of 0", () => {
    expect(contextLimitFor(null, { providerID: "fake", modelID: "ctx-model" })).toBeNull();
    expect(contextLimitFor(providers, null)).toBeNull();
    expect(contextLimitFor(providers, { providerID: "nope", modelID: "ctx-model" })).toBeNull();
    expect(contextLimitFor(providers, { providerID: "fake", modelID: "missing" })).toBeNull();
    expect(contextLimitFor(providers, { providerID: "fake", modelID: "unknown" })).toBeNull();
    expect(contextLimitFor(providers, { providerID: "fake", modelID: "bare" })).toBeNull();
  });
});

describe("latestMeasuredUsage and compaction", () => {
  test("measures nothing right after a v1 compaction summary, whose usage is the cost of writing it", () => {
    const messages = [
      { info: { id: "a1", role: "assistant", tokens: tokens(38_978, 12, { total: 38_990 }) } },
      { info: { id: "u2", role: "user", summary: { diffs: [] } } },
      { info: { id: "a2", role: "assistant", summary: true, tokens: tokens(30_945, 12, { total: 30_957 }) } },
    ];
    expect(latestMeasuredUsage(messages, "v1")).toBeNull();
  });

  test("measures again with the first reply after the summary", () => {
    const messages = [
      { info: { id: "a2", role: "assistant", summary: true, tokens: tokens(30_945, 12, { total: 30_957 }) } },
      { info: { id: "u3", role: "user" } },
      { info: { id: "a3", role: "assistant", tokens: tokens(8_649, 12, { total: 8_661 }) } },
    ];
    expect(latestMeasuredUsage(messages, "v1")?.messageId).toBe("a3");
  });
});

describe("pickMeasuredUsage", () => {
  const usage = (messageId: string, input = 1000) => ({ messageId, tokens: tokens(input, 12) });
  const ids = ["u1", "a1", "u2", "a2"];

  test("falls back to whichever figure exists", () => {
    expect(pickMeasuredUsage(undefined, usage("a1"), ids)?.messageId).toBe("a1");
    expect(pickMeasuredUsage(usage("a1"), null, ids)?.messageId).toBe("a1");
    expect(pickMeasuredUsage(undefined, null, ids)).toBeNull();
  });

  test("takes the live figure when both describe the same message", () => {
    const live = usage("a2", 5_800);
    expect(pickMeasuredUsage(live, usage("a2", 5_789), ids)).toBe(live);
  });

  test("takes the history figure when it belongs to a later message", () => {
    expect(pickMeasuredUsage(usage("a1"), usage("a2"), ids)?.messageId).toBe("a2");
  });

  test("keeps a live figure for a reply the history does not list yet", () => {
    expect(pickMeasuredUsage(usage("a3"), usage("a2"), ids)?.messageId).toBe("a3");
  });

  test("keeps the live figure when history is older", () => {
    expect(pickMeasuredUsage(usage("a2"), usage("a1"), ids)?.messageId).toBe("a2");
  });
});

describe("readCompactionSettings", () => {
  test("keeps only the keys the ceiling uses, with valid types", () => {
    expect(readCompactionSettings({ auto: false, reserved: 10_000, buffer: 5_000, prune: true })).toEqual({ auto: false, reserved: 10_000, buffer: 5_000 });
    expect(readCompactionSettings({ auto: "no", reserved: -1, buffer: Number.NaN })).toEqual({});
  });

  test("treats a missing or malformed block as the engine default", () => {
    expect(readCompactionSettings(undefined)).toEqual({});
    expect(readCompactionSettings("on")).toEqual({});
    expect(readCompactionSettings(null)).toEqual({});
  });
});

describe("buildContextUsage", () => {
  const window = { context: 100_000, output: 8_000 };
  const measured = (input: number, output = 12) => ({ messageId: "a1", tokens: tokens(input, output) });

  test("shows nothing before a reply was measured", () => {
    expect(buildContextUsage({ measured: null, engine: "v1", limit: window })).toBeNull();
  });

  test("an empty chat still carries the fixed overhead, as recorded in M0 (v1, 100k window)", () => {
    expect(buildContextUsage({ measured: { messageId: "a1", tokens: tokens(8_583, 12, { total: 8_595 }) }, engine: "v1", limit: window })).toEqual({
      used: 8_595,
      window: 100_000,
      percent: 9,
      ceiling: 92_000,
      tone: "neutral",
      hint: null,
    });
  });

  test("warns at 70% and says compaction is near 5% of the window before the ceiling", () => {
    // v1 ceiling for this window is 92,000, so the strong step starts at 87,000.
    expect(buildContextUsage({ measured: measured(70_000), engine: "v1", limit: window })).toMatchObject({ tone: "warning", hint: null });
    // 86,975 + 12 output = 86,987: one token below the strong step.
    expect(buildContextUsage({ measured: measured(86_975), engine: "v1", limit: window })).toMatchObject({ used: 86_987, tone: "warning", hint: null });
    expect(buildContextUsage({ measured: measured(86_988), engine: "v1", limit: window })).toMatchObject({ used: 87_000, tone: "strong", hint: "soon" });
  });

  test("stays in the strong step with the same hint once the ceiling is reached", () => {
    expect(buildContextUsage({ measured: measured(92_000), engine: "v1", limit: window })).toMatchObject({ tone: "strong", hint: "soon" });
  });

  test("uses the v2 formula and ceiling: 100k window compacts at 84,000", () => {
    expect(buildContextUsage({ measured: { messageId: "a1", tokens: tokens(60_000, 12, { reasoning: 40 }) }, engine: "v2", limit: window })).toMatchObject({ used: 60_052, ceiling: 84_000, tone: "neutral" });
    expect(buildContextUsage({ measured: measured(80_000), engine: "v2", limit: window })).toMatchObject({ tone: "strong", hint: "soon" });
  });

  test("an unknown window gives tokens only: no percentage, no tone, no hint", () => {
    expect(buildContextUsage({ measured: measured(95_000), engine: "v1", limit: null })).toEqual({
      used: 95_012,
      window: null,
      percent: null,
      ceiling: null,
      tone: "neutral",
      hint: null,
    });
  });

  test("with auto-compaction off only the 70% step exists", () => {
    expect(buildContextUsage({ measured: measured(99_000), engine: "v1", limit: window, settings: { auto: false } })).toMatchObject({ tone: "warning", hint: null, ceiling: null });
  });
});

describe("formatTokens", () => {
  test("keeps small numbers, and rounds thousands and millions to one decimal", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1_000)).toBe("1k");
    expect(formatTokens(8_595)).toBe("8.6k");
    expect(formatTokens(34_000)).toBe("34k");
    expect(formatTokens(100_000)).toBe("100k");
    expect(formatTokens(999_960)).toBe("1M");
    expect(formatTokens(1_048_576)).toBe("1M");
    expect(formatTokens(1_250_000)).toBe("1.3M");
  });
});

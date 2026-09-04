import { describe, expect, test } from "bun:test";

import {
  resolveRuntimeEnvKeys,
  runtimeEnvKeyText,
} from "../app/(den)/dashboard/_components/runtime-env-key";

describe("resolveRuntimeEnvKeys", () => {
  test("an unsaved catalog provider shows a placeholder tag on every declared name", () => {
    const keys = resolveRuntimeEnvKeys({
      declaredEnvNames: ["AZURE_RESOURCE_NAME", "AZURE_API_KEY"],
      scoped: true,
      saved: false,
      runtimeEnvKeys: [],
    });
    expect(keys.map((key) => key.pending)).toEqual([true, true]);
    expect(keys.map(runtimeEnvKeyText)).toEqual([
      "LPR_·····_AZURE_RESOURCE_NAME",
      "LPR_·····_AZURE_API_KEY",
    ]);
  });

  test("a saved catalog provider shows the tag Den assigned", () => {
    const keys = resolveRuntimeEnvKeys({
      declaredEnvNames: ["OPENAI_API_KEY"],
      scoped: true,
      saved: true,
      runtimeEnvKeys: ["LPR_120JV_OPENAI_API_KEY"],
    });
    expect(keys).toEqual([{ tag: "LPR_120JV", declared: "OPENAI_API_KEY", pending: false }]);
    expect(runtimeEnvKeyText(keys[0]!)).toBe("LPR_120JV_OPENAI_API_KEY");
  });

  test("a Den that predates runtime names, and custom providers, show the declared name as-is", () => {
    expect(
      resolveRuntimeEnvKeys({ declaredEnvNames: ["OPENAI_API_KEY"], scoped: true, saved: true, runtimeEnvKeys: [] }),
    ).toEqual([{ tag: null, declared: "OPENAI_API_KEY", pending: false }]);
    expect(
      resolveRuntimeEnvKeys({ declaredEnvNames: ["LITELLM_API_KEY"], scoped: false, saved: false, runtimeEnvKeys: [] }),
    ).toEqual([{ tag: null, declared: "LITELLM_API_KEY", pending: false }]);
  });
});

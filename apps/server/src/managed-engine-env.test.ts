import { describe, expect, test } from "bun:test";

import { buildManagedEngineEnv, buildPromptDebugControlEnv } from "./managed-engine-env.js";

describe("buildManagedEngineEnv", () => {
  test("builds a non-secret server control snapshot with desktop restart state", () => {
    expect(buildPromptDebugControlEnv({
      OPENWORK_PROMPT_LOG: "off",
      OPENWORK_DESKTOP_DEV_MODE: "stale",
      OPENWORK_DEV_MODE: "1",
      OPENWORK_SERVER_TOKEN: "must-not-copy",
    }, true)).toEqual({
      OPENWORK_PROMPT_LOG: "off",
      OPENWORK_DESKTOP_DEV_MODE: "1",
      OPENWORK_DEV_MODE: "1",
    });
    expect(buildPromptDebugControlEnv({
      OPENWORK_DESKTOP_DEV_MODE: "1",
    }, false)).toEqual({
      OPENWORK_DESKTOP_DEV_MODE: "0",
    });
  });

  test("builds the CLI variant with today's exact truthiness", () => {
    const sourceEnv: NodeJS.ProcessEnv = {
      OPENWORK_DEV_MODE: "0",
      OPENWORK_UI_CONTROL_DISCOVERY: "",
      UNRELATED: "not-forwarded",
    };
    const originalSourceEnv = { ...sourceEnv };

    expect(buildManagedEngineEnv({
      sourceEnv,
      serverUrl: "http://127.0.0.1:8787",
      serverToken: "server-token",
      runtimeConfigPath: "/tmp/openwork/opencode.json",
    })).toEqual({
      OPENWORK_DEV_MODE: "0",
      OPENWORK_SERVER_URL: "http://127.0.0.1:8787",
      OPENWORK_SERVER_TOKEN: "server-token",
      OPENCODE_CONFIG: "/tmp/openwork/opencode.json",
    });
    expect(sourceEnv).toEqual(originalSourceEnv);
  });

  test("builds the embedded variant with its models URL", () => {
    const sourceEnv: NodeJS.ProcessEnv = {
      OPENWORK_DEV_MODE: "1",
      OPENWORK_UI_CONTROL_DISCOVERY: "enabled",
      OPENCODE_MODELS_URL: "source-value-is-not-forwarded",
    };
    const originalSourceEnv = { ...sourceEnv };

    expect(buildManagedEngineEnv({
      sourceEnv,
      serverUrl: "http://127.0.0.1:49152",
      serverToken: "embedded-token",
      runtimeConfigPath: "/var/tmp/openwork/opencode.json",
      opencodeModelsUrl: "http://localhost:8791/models",
    })).toEqual({
      OPENWORK_DEV_MODE: "1",
      OPENWORK_UI_CONTROL_DISCOVERY: "enabled",
      OPENWORK_SERVER_URL: "http://127.0.0.1:49152",
      OPENWORK_SERVER_TOKEN: "embedded-token",
      OPENCODE_CONFIG: "/var/tmp/openwork/opencode.json",
      OPENCODE_MODELS_URL: "http://localhost:8791/models",
    });
    expect(sourceEnv).toEqual(originalSourceEnv);
  });

  test("preserves the actual explicit prompt-log value and provenance for the managed child", () => {
    const base = {
      serverUrl: "http://127.0.0.1:8787",
      serverToken: "server-token",
      runtimeConfigPath: "/tmp/openwork/opencode.json",
    };

    expect(buildManagedEngineEnv({
      ...base,
      sourceEnv: {
        OPENWORK_DEV_MODE: "1",
        OPENWORK_PROMPT_LOG: "off",
      },
    }).OPENWORK_PROMPT_LOG).toBe("off");
    expect(buildManagedEngineEnv({
      ...base,
      sourceEnv: {
        OPENWORK_DEV_MODE: "0",
        OPENWORK_PROMPT_LOG: "yes",
      },
    }).OPENWORK_PROMPT_LOG).toBe("yes");
    expect(buildManagedEngineEnv({
      ...base,
      sourceEnv: {
        OPENWORK_DEV_MODE: "1",
        OPENWORK_PROMPT_LOG: "invalid",
      },
    }).OPENWORK_PROMPT_LOG).toBe("invalid");
    expect(buildManagedEngineEnv({
      ...base,
      sourceEnv: {
        OPENWORK_DEV_MODE: "1",
        OPENWORK_PROMPT_LOG: "   ",
      },
    }).OPENWORK_PROMPT_LOG).toBe("   ");
    expect(buildManagedEngineEnv({
      ...base,
      sourceEnv: {},
    }).OPENWORK_PROMPT_LOG).toBeUndefined();
  });

  test("materializes the desktop preference independently of the explicit override", () => {
    const base = {
      serverUrl: "http://127.0.0.1:8787",
      serverToken: "server-token",
      runtimeConfigPath: "/tmp/openwork/opencode.json",
    };

    expect(buildManagedEngineEnv({
      ...base,
      sourceEnv: {},
      developerModeEnabled: true,
      promptLogEnabled: true,
    }).OPENWORK_DESKTOP_DEV_MODE).toBe("1");
    expect(buildManagedEngineEnv({
      ...base,
      sourceEnv: {},
      developerModeEnabled: false,
      promptLogEnabled: false,
    }).OPENWORK_DESKTOP_DEV_MODE).toBe("0");

    const exactOnly = buildManagedEngineEnv({
      ...base,
      sourceEnv: {},
      developerModeEnabled: false,
      promptLogEnabled: true,
    });
    expect(exactOnly.OPENWORK_DESKTOP_DEV_MODE).toBe("0");
    expect(exactOnly.OPENWORK_DESKTOP_PROMPT_LOG).toBe("1");

    const explicit = buildManagedEngineEnv({
      ...base,
      sourceEnv: { OPENWORK_PROMPT_LOG: "off" },
      developerModeEnabled: true,
      promptLogEnabled: true,
    });
    expect(explicit.OPENWORK_PROMPT_LOG).toBe("off");
    expect(explicit.OPENWORK_DESKTOP_DEV_MODE).toBe("1");
    expect(explicit.OPENWORK_DESKTOP_PROMPT_LOG).toBe("1");
  });
});

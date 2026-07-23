import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveDesktopObservabilityControl } from "./observability-control.mjs";

describe("resolveDesktopObservabilityControl", () => {
  const cases = [
    {
      name: "lets OPENWORK_OBSERVABILITY exact override every lower-precedence input",
      options: { openworkDeveloperMode: false, openworkPromptLog: false },
      env: { OPENWORK_OBSERVABILITY: " EXACT ", OPENWORK_PROMPT_LOG: "0" },
      level: "exact",
      source: "OPENWORK_OBSERVABILITY",
    },
    {
      name: "keeps metadata distinct from exact prompt logging",
      options: { openworkDeveloperMode: true, openworkPromptLog: true },
      env: { OPENWORK_OBSERVABILITY: "metadata", OPENWORK_PROMPT_LOG: "1" },
      level: "metadata",
      source: "OPENWORK_OBSERVABILITY",
    },
    {
      name: "lets OPENWORK_OBSERVABILITY off override enabled desktop preferences",
      options: { openworkDeveloperMode: true, openworkPromptLog: true },
      env: { OPENWORK_OBSERVABILITY: "off" },
      level: "off",
      source: "OPENWORK_OBSERVABILITY",
    },
    {
      name: "fails closed for an invalid OPENWORK_OBSERVABILITY value",
      options: { openworkDeveloperMode: true, openworkPromptLog: true },
      env: { OPENWORK_OBSERVABILITY: "verbose", OPENWORK_PROMPT_LOG: "1" },
      level: "off",
      source: "OPENWORK_OBSERVABILITY_INVALID",
    },
    {
      name: "maps a true legacy prompt-log override to exact",
      options: {},
      env: { OPENWORK_PROMPT_LOG: "yes" },
      level: "exact",
      source: "OPENWORK_PROMPT_LOG",
    },
    {
      name: "lets a false legacy prompt-log override disable desktop preferences",
      options: { openworkDeveloperMode: true, openworkPromptLog: true },
      env: { OPENWORK_PROMPT_LOG: "0" },
      level: "off",
      source: "OPENWORK_PROMPT_LOG",
    },
    {
      name: "fails closed for an invalid legacy prompt-log override",
      options: { openworkDeveloperMode: true, openworkPromptLog: true },
      env: { OPENWORK_PROMPT_LOG: "sometimes" },
      level: "off",
      source: "OPENWORK_PROMPT_LOG_INVALID",
    },
    {
      name: "uses exact when the desktop exact preference is enabled",
      options: { openworkDeveloperMode: true, openworkPromptLog: true },
      env: {},
      level: "exact",
      source: "desktop-option",
    },
    {
      name: "uses metadata for Developer Mode without exact consent",
      options: { openworkDeveloperMode: true, openworkPromptLog: false },
      env: {},
      level: "metadata",
      source: "desktop-option",
    },
    {
      name: "defaults to off",
      options: {},
      env: {},
      level: "off",
      source: "desktop-option",
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      assert.deepEqual(
        resolveDesktopObservabilityControl(testCase.options, testCase.env),
        {
          developerModeRequested: testCase.options.openworkDeveloperMode === true,
          requested: testCase.options.openworkPromptLog === true,
          enabled: testCase.level === "exact",
          consoleEnabled: testCase.level !== "off",
          level: testCase.level,
          source: testCase.source,
        },
      );
    });
  }
});

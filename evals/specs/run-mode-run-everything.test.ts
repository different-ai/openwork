import { expect } from "vitest";
import { test } from "@openwork/testkit";
import { buildOpenworkRuntimeConfigObjectFromSnapshot } from "../../apps/server/src/openwork-runtime-config.js";
import {
  compileRunEverythingPermission,
  DEFAULT_ENGINE_RUN_MODE,
  normalizeEngineRunMode,
} from "../../apps/server/src/run-mode.js";

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

test("run everything auto-approves tools in the engine config while protections stay interactive", ({ evidence }) => {
  const storedExternalDirectory = {
    "/shared/*": "allow",
    "/blocked/*": "deny",
  };

  // Claim: selecting "Run everything" renders an engine config whose
  // permission policy auto-allows every gated tool (bash, edit, webfetch,
  // MCP tools) through the top-level catch-all.
  const rendered = buildOpenworkRuntimeConfigObjectFromSnapshot({
    run_mode: "run-everything",
    permission: { external_directory: storedExternalDirectory },
  });
  const permission = asRecord(rendered.permission);
  expect(permission["*"]).toBe("allow");

  // Protection 1: writes outside the workspace and authorized folders still
  // ask. The ask default is emitted ahead of the explicit folder rules so the
  // engine's last-matching-rule semantics keep the stored grants and denies
  // authoritative for their paths.
  const externalDirectory = asRecord(permission.external_directory);
  expect(Object.keys(externalDirectory)[0]).toBe("*");
  expect(externalDirectory["*"]).toBe("ask");
  expect(externalDirectory["/shared/*"]).toBe("allow");
  expect(externalDirectory["/blocked/*"]).toBe("deny");

  // Protection 2: doom-loop detection keeps prompting.
  expect(permission.doom_loop).toBe("ask");

  // Protection 3: the engine's default .env read rule (ask) is restated so the
  // catch-all allow cannot override it.
  expect(asRecord(permission.read)).toEqual({
    "*": "allow",
    "*.env": "ask",
    "*.env.*": "ask",
    "*.env.example": "allow",
  });

  // Protection 4: the injected agent's explicit skill denies survive; the
  // preset never re-enables an explicitly denied capability.
  const agentSkillPermission = asRecord(
    asRecord(asRecord(asRecord(rendered.agent).openwork).permission).skill,
  );
  expect(agentSkillPermission["customize-opencode"]).toBe("deny");

  // The OpenWork-internal run_mode field never leaks into engine config.
  expect("run_mode" in rendered).toBe(false);

  // Negative half 1: the default mode renders no catch-all allow — the
  // engine keeps its ask-by-default posture and only the stored folder
  // grants appear.
  const defaultRendered = buildOpenworkRuntimeConfigObjectFromSnapshot({
    permission: { external_directory: storedExternalDirectory },
  });
  const defaultPermission = asRecord(defaultRendered.permission);
  expect(defaultPermission["*"]).toBeUndefined();
  expect(defaultPermission.doom_loop).toBeUndefined();
  expect(asRecord(defaultPermission.external_directory)["*"]).toBeUndefined();
  expect(asRecord(defaultPermission.external_directory)["/shared/*"]).toBe("allow");

  // Negative half 2: unknown mode values are rejected before storage, and the
  // default stays the prompting mode.
  expect(normalizeEngineRunMode("yolo")).toBeUndefined();
  expect(normalizeEngineRunMode(true)).toBeUndefined();
  expect(normalizeEngineRunMode(undefined)).toBeUndefined();
  expect(DEFAULT_ENGINE_RUN_MODE).toBe("approve");

  // Negative half 3: the compiler never rewrites stored deny entries — it
  // only upgrades would-be prompts, mirroring the engine's --auto semantics.
  const compiled = compileRunEverythingPermission({
    external_directory: { "/blocked/*": "deny" },
  });
  expect(asRecord(compiled.external_directory)["/blocked/*"]).toBe("deny");

  evidence.recordAssertionEvidence(
    "Run everything stays protected in the rendered file",
    "The run-everything preset compiles a catch-all allow into the engine-visible permission config while outside-workspace writes, doom-loop detection, .env read prompts, stored deny rules, and explicit agent denies all remain in the rendered file; the default mode renders no auto-approval and junk modes are rejected. This spec witnesses the rendered file only; run-mode-engine-effective covers the engine's evaluated ruleset.",
    true,
  );
});

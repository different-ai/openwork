import { expect, test } from "bun:test";
import { composerDiagnosticBlockers, sessionComposerDiagnosticReasons } from "../src/react-app/domains/session/surface/composer/composer-diagnostics";

const ready = { disabled: false, busy: false, canSend: true, submissionPreparing: false };

test("Send diagnostics match the disabled expression for every combination of button inputs", () => {
  for (let mask = 0; mask < 32; mask += 1) {
    const input = {
      disabled: Boolean(mask & 1), busy: Boolean(mask & 2),
      canSend: Boolean(mask & 4), stopping: Boolean(mask & 8),
      submissionPreparing: Boolean(mask & 16),
    };
    const blockers = composerDiagnosticBlockers(input);
    expect(blockers.includes("send_busy_stop_control")).toBe(input.busy);
    const disabledReasons = blockers.filter((reason) => reason !== "send_busy_stop_control");
    expect(disabledReasons.length > 0).toBe(input.disabled || input.stopping || (!input.busy && (!input.canSend || input.submissionPreparing)));
  }
});

test("all parent disable reasons are categorical and a single cleared reason does not imply ready", () => {
  const flags = { archiveStateKnown: false, archiveHeld: true, modelTransitioning: true, modelUnavailable: true, admissionUnknown: true };
  expect(sessionComposerDiagnosticReasons(flags)).toEqual([
    "send_archive_unknown", "send_archive_held", "send_model_transition", "send_model_unavailable", "send_admission_unknown",
  ]);
  expect(sessionComposerDiagnosticReasons({ ...flags, modelUnavailable: false })).not.toContain("send_model_unavailable");
  expect(composerDiagnosticBlockers({ ...ready, disabled: true, disabledReasons: ["send_archive_held"], canSend: false })).toEqual(["send_archive_held", "send_empty"]);
  expect(composerDiagnosticBlockers(ready)).toEqual([]);
});

test("preparation and restoration reasons never assert Den connectivity", () => {
  expect(composerDiagnosticBlockers({
    ...ready, submissionPreparing: true, preparingReasons: ["send_preparing_tools", "send_auto_sending"],
  })).toEqual(["send_preparing_tools", "send_auto_sending"]);
  expect(composerDiagnosticBlockers({
    ...ready, submissionPreparing: true, preparingReasons: ["send_restore_unsent"],
  })).toEqual(["send_restore_unsent"]);
});

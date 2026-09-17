import type { SendDiagnosticReason } from "../../../../../app/lib/connection-diagnostic-history";

export type ComposerDiagnosticInput = {
  disabled: boolean;
  disabledReasons?: readonly SendDiagnosticReason[];
  busy: boolean;
  stopping?: boolean;
  canSend: boolean;
  submissionPreparing: boolean;
  preparingReasons?: readonly SendDiagnosticReason[];
};

export function composerDiagnosticBlockers(input: ComposerDiagnosticInput): SendDiagnosticReason[] {
  const reasons: SendDiagnosticReason[] = input.busy ? ["send_busy_stop_control"] : [];
  if (input.disabled) {
    if (input.disabledReasons?.length) reasons.push(...input.disabledReasons);
    else reasons.push("send_parent_disabled");
  }
  if (input.stopping) reasons.push("send_stopping");
  if (!input.busy && !input.canSend) reasons.push("send_empty");
  if (!input.busy && input.submissionPreparing) {
    if (input.preparingReasons?.length) reasons.push(...input.preparingReasons);
    else reasons.push("send_preparing");
  }
  return reasons;
}

export function sessionComposerDiagnosticReasons(input: {
  archiveStateKnown: boolean;
  archiveHeld: boolean;
  modelTransitioning: boolean;
  modelUnavailable: boolean;
  admissionUnknown: boolean;
}): SendDiagnosticReason[] {
  const reasons: SendDiagnosticReason[] = [];
  if (!input.archiveStateKnown) reasons.push("send_archive_unknown");
  if (input.archiveHeld) reasons.push("send_archive_held");
  if (input.modelTransitioning) reasons.push("send_model_transition");
  if (input.modelUnavailable) reasons.push("send_model_unavailable");
  if (input.admissionUnknown) reasons.push("send_admission_unknown");
  return reasons;
}

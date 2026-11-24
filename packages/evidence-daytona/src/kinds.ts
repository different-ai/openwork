/** `kind` labels on the sandboxes this package creates; cleanup and ownership checks rely on them. */
export const EVIDENCE_KIND = "openwork-daytona-evidence-v1";
/** Temporary forks taken while capturing a checkpoint. */
export const CAPTURE_KIND = "openwork-daytona-checkpoint-capture-v1";
/** Fresh direct web previews launched from an immutable review report. */
export const PREVIEW_KIND = "openwork-daytona-review-v1";
/** Working copies a reviewer opened from a checkpoint. */
export const COPY_KIND = "openwork-daytona-checkpoint-copy-v1";

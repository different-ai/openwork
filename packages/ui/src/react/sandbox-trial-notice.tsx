/** @jsxImportSource react */
type EndedSandboxNoticeProps = {
  state?: "open" | "expired" | "closed" | null;
  className: string;
};

export function EndedSandboxNotice({ state, className }: EndedSandboxNoticeProps) {
  if (state !== "expired" && state !== "closed") return null;

  return (
    <div className={className} role="status" data-testid="ended-sandbox-notice">
      <strong>This sandbox trial has ended.</strong>{" "}
      Ask a platform admin to reopen it to use its included models.
    </div>
  );
}

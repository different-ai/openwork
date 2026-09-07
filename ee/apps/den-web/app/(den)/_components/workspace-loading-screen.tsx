/** One stable surface from server render through session and workspace resolution. */
export function WorkspaceLoadingScreen() {
  return (
    <div
      data-testid="workspace-loading-screen"
      className="flex min-h-screen min-h-dvh w-full items-center justify-center bg-[var(--dls-app-bg)]"
    >
      <div role="status" aria-live="polite" className="flex items-center gap-3 text-sm text-[var(--dls-text-secondary)]">
        <span aria-hidden="true" className="h-4 w-4 shrink-0 rounded-full border-2 border-[var(--dls-border)] border-t-[var(--dls-text-secondary)] motion-safe:animate-spin" />
        <span>Loading OpenWork…</span>
      </div>
    </div>
  );
}

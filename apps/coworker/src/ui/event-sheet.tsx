import { useId, type ReactNode } from "react";
import { Button } from "@/ui/kit";

/** Inline dock content. Escape belongs only to focus inside this panel. */
export function EventSheet({
  title,
  onClose,
  busy = false,
  active = true,
  children,
}: {
  title: string;
  onClose: () => void;
  busy?: boolean;
  active?: boolean;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section
      tabIndex={-1}
      data-event-panel-content="true"
      aria-labelledby={id}
      className="@container/panel flex h-full min-h-0 min-w-0 flex-col outline-none"
      onKeyDown={(event) => {
        if (!active || busy || event.defaultPrevented || event.key !== "Escape")
          return;
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
    >
      <header className="flex min-h-14 shrink-0 items-center justify-between gap-3 border-b border-line px-4 py-3">
        <h2 id={id} className="text-sm font-semibold text-snow">
          {title}
        </h2>
        <Button
          variant="ghost"
          disabled={busy}
          onClick={onClose}
          aria-label="Close event"
        >
          Close
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
    </section>
  );
}

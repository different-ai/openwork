"use client";

import { ArrowLeft, ArrowRight } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

export type RoadmapAudience = { id: string; label: string; blurb: string; productIds: string[] };

type Props = {
  audiences: RoadmapAudience[];
  /** Product id to its short name. */
  labels: Record<string, string>;
  /** Product id to its section: heading, preview, and status columns. */
  panels: Record<string, ReactNode>;
};

/* One product at a time: pick what you care about, then a product. The
 * address keeps the product (#workbot), so a link opens the same view. */
export function RoadmapExplorer({ audiences, labels, panels }: Props) {
  const order = audiences.flatMap((audience) => audience.productIds);
  const [active, setActive] = useState(order[0]);
  /* The product row: a link or Next lands here, so the preview is on screen. */
  const row = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const known = audiences.flatMap((audience) => audience.productIds);
    const fromAddress = () => {
      const id = window.location.hash.slice(1);
      if (!known.includes(id)) return;
      setActive(id);
      row.current?.scrollIntoView({ block: "start" });
    };
    fromAddress();
    window.addEventListener("hashchange", fromAddress);
    return () => window.removeEventListener("hashchange", fromAddress);
  }, [audiences]);

  const select = (id: string, scroll: boolean) => {
    setActive(id);
    window.history.replaceState(null, "", `#${id}`);
    if (scroll) row.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  /* Keep the chosen product in sight when the row scrolls sideways on a phone. */
  useEffect(() => {
    const strip = row.current;
    const chip = strip?.querySelector<HTMLElement>(`[data-product="${active}"]`);
    if (!strip || !chip) return;
    strip.scrollTo({ left: chip.offsetLeft - (strip.clientWidth - chip.offsetWidth) / 2, behavior: "smooth" });
  }, [active]);

  const audience = audiences.find((entry) => entry.productIds.includes(active)) ?? audiences[0];
  const position = order.indexOf(active);
  const previous = order[position - 1];
  const next = order[position + 1];

  return (
    <div data-testid="roadmap-explorer">
      <div role="tablist" aria-label="What you care about" className="grid gap-2 sm:grid-cols-3 sm:gap-3">
        {audiences.map((entry) => {
          const selected = entry.id === audience.id;
          return (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={selected}
              data-audience={entry.id}
              onClick={() => select(entry.productIds[0], false)}
              className={`flex min-h-[48px] flex-col justify-center gap-0.5 rounded-[16px] px-4 py-3 text-left transition-colors sm:min-h-[92px] sm:px-5 ${
                selected
                  ? "bg-white shadow-[inset_0_0_0_1.5px_var(--lp-ink)]"
                  : "bg-[var(--lp-tonal)] hover:bg-white hover:shadow-[inset_0_0_0_1px_var(--lp-border)]"
              }`}
            >
              <span className="text-[15px] font-semibold tracking-[-0.01em] text-[var(--lp-ink)] sm:text-[16px]">{entry.label}</span>
              <span className={`text-[13px] leading-[19px] text-[var(--lp-muted)] sm:block ${selected ? "" : "hidden"}`}>{entry.blurb}</span>
            </button>
          );
        })}
      </div>

      <div
        ref={row}
        role="tablist"
        aria-label="Products"
        className="relative -mx-6 mt-4 flex scroll-mt-20 gap-2 overflow-x-auto px-6 pb-1 [scrollbar-width:none] md:mx-0 md:flex-wrap md:px-0 [&::-webkit-scrollbar]:hidden"
      >
        {audience.productIds.map((id) => {
          const selected = id === active;
          return (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={selected}
              data-product={id}
              onClick={() => select(id, false)}
              className={`inline-flex h-10 shrink-0 items-center rounded-full px-4 text-[14px] transition-colors md:h-9 ${
                selected
                  ? "bg-[var(--lp-ink)] font-medium text-white"
                  : "bg-white text-[var(--lp-ink)] shadow-[inset_0_0_0_1px_var(--lp-border)] hover:bg-[var(--lp-tonal)]"
              }`}
            >
              {labels[id]}
            </button>
          );
        })}
      </div>

      <div role="tabpanel" key={active} id={active} className="mt-12 motion-safe:animate-[fade-up_320ms_ease_both] md:mt-16">
        {panels[active]}
      </div>

      <div className="mt-12 flex items-center justify-between gap-3 border-t border-[var(--lp-border)] pt-5">
        {previous ? (
          <button
            type="button"
            onClick={() => select(previous, true)}
            aria-label={`Back to ${labels[previous]}`}
            className="inline-flex h-11 shrink-0 items-center gap-2 rounded-full px-4 text-[14px] text-[var(--lp-ink)] shadow-[inset_0_0_0_1px_var(--lp-border)] transition-colors hover:bg-[var(--lp-tonal)]"
          >
            <ArrowLeft size={15} strokeWidth={2.2} aria-hidden="true" />
            <span className="sm:hidden">Back</span>
            <span className="hidden sm:inline">{labels[previous]}</span>
          </button>
        ) : (
          <span />
        )}
        <span className="hidden text-[13px] tabular-nums text-[var(--lp-muted)] sm:block">
          {position + 1} of {order.length}
        </span>
        {next ? (
          <button
            type="button"
            data-next
            onClick={() => select(next, true)}
            className="inline-flex h-11 min-w-0 items-center gap-2 rounded-full bg-[var(--lp-ink)] px-5 text-[14px] font-medium text-white transition-opacity hover:opacity-90"
          >
            <span className="truncate">Next: {labels[next]}</span>
            <ArrowRight size={15} strokeWidth={2.2} aria-hidden="true" />
          </button>
        ) : (
          <span />
        )}
      </div>
    </div>
  );
}

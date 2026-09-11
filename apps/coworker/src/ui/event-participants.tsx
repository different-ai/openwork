import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CoworkerSummary } from "@/lib/bridge";
import { CoworkerAvatar } from "@/ui/coworker-avatar";

/** A selected guest list and a search field, sharing the Event's existing roster. */
export function EventParticipants({ coworkers, selected, leadSlug, disabled, onToggle }: {
  coworkers: CoworkerSummary[];
  selected: string[];
  leadSlug: string;
  disabled: boolean;
  onToggle: (slug: string) => void;
}) {
  const id = useId();
  const listId = `${id}-options`;
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [announcement, setAnnouncement] = useState("");
  const [position, setPosition] = useState<{ left: number; top: number; width: number; maxHeight: number } | null>(null);
  const available = coworkers.filter((coworker) => !selected.includes(coworker.slug));
  const matches = available.filter((coworker) => `${coworker.name} ${coworker.role} ${coworker.slug}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const atLimit = selected.length >= 20;
  const options = atLimit ? [] : matches;
  const activeIndex = Math.min(highlight, Math.max(0, options.length - 1));
  const expanded = open && !disabled;

  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  useLayoutEffect(() => {
    if (!expanded || !root.current || !menu.current) return;
    const rect = root.current.getBoundingClientRect();
    const below = window.innerHeight - rect.bottom - 12;
    const above = rect.top - 12;
    const placeBelow = below >= 180 || below >= above;
    const maxHeight = Math.min(224, Math.max(64, placeBelow ? below : above));
    const width = Math.min(rect.width, window.innerWidth - 16);
    setPosition({
      left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
      top: placeBelow ? rect.bottom + 4 : Math.max(8, rect.top - Math.min(menu.current.scrollHeight, maxHeight) - 4),
      width,
      maxHeight,
    });
  }, [expanded, selected.length, options.length, query]);
  useEffect(() => {
    if (!expanded) return;
    const outside = (event: Event) => {
      if (event.target instanceof Node && (root.current?.contains(event.target) || menu.current?.contains(event.target))) return;
      setOpen(false);
    };
    const scroll = (event: Event) => {
      if (event.target instanceof Node && menu.current?.contains(event.target)) return;
      setOpen(false);
    };
    const resize = () => setOpen(false);
    window.addEventListener("pointerdown", outside, true);
    window.addEventListener("focusin", outside);
    window.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", resize);
    return () => {
      window.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("focusin", outside);
      window.removeEventListener("scroll", scroll, true);
      window.removeEventListener("resize", resize);
    };
  }, [expanded]);
  useEffect(() => {
    if (expanded && position) menu.current?.querySelector<HTMLElement>(`[data-option-index="${activeIndex}"]`)?.scrollIntoView({ block: "nearest" });
  }, [expanded, activeIndex, position]);

  function add(coworker: CoworkerSummary) {
    if (disabled || atLimit || selected.includes(coworker.slug)) return;
    onToggle(coworker.slug);
    setQuery("");
    setHighlight(0);
    setAnnouncement(`${coworker.name} added.`);
    input.current?.focus({ preventScroll: true });
  }
  function remove(slug: string) {
    if (disabled) return;
    onToggle(slug);
    const name = coworkers.find((coworker) => coworker.slug === slug)?.name ?? slug;
    setAnnouncement(`${name} removed.${slug === leadSlug ? " Choose another owner before saving." : ""}`);
    input.current?.focus({ preventScroll: true });
  }
  const avatar = (coworker: CoworkerSummary, size: number) => <CoworkerAvatar identity={coworker.slug} name={coworker.name} color={coworker.avatarColor} glasses={coworker.avatarGlasses} size={size} animated={false} gaze={false} motion="quiet" />;

  return (
    <div className="space-y-1.5" data-testid="event-participants">
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={id} className="text-xs font-medium text-mist">Participants</label>
        {selected.length > 0 ? <span className="text-[10px] tabular-nums text-mist">{selected.length} added</span> : null}
      </div>
      <div ref={root} className={`relative flex min-h-11 flex-wrap items-center gap-1.5 rounded-xl border border-line bg-panel/70 p-2 focus-within:border-spark/50 ${disabled ? "opacity-60" : ""}`} onClick={(event) => { if (event.target === event.currentTarget) input.current?.focus(); }}>
        {selected.map((slug) => {
          const coworker = coworkers.find((member) => member.slug === slug);
          const name = coworker?.name ?? slug;
          return (
            <span key={slug} data-testid="event-participant-chip" data-slug={slug} className={`inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-md border py-1 pl-1.5 pr-1 ${coworker ? "border-line/70 bg-white/5 text-snow" : "border-amber/30 bg-amber/5 text-amber"}`}>
              {coworker ? <span className="shrink-0">{avatar(coworker, 18)}</span> : null}
              <span className="min-w-0 truncate text-xs" title={coworker ? name : `${name} is no longer on the team`}>{name}</span>
              {slug === leadSlug ? <span className="shrink-0 text-[9px] text-mist">Owner</span> : null}
              {!coworker ? <span className="shrink-0 text-[9px]">Unavailable</span> : null}
              <button type="button" disabled={disabled} data-participant-remove={slug} aria-label={`Remove ${name} from participants`} className="flex size-5 shrink-0 items-center justify-center rounded text-mist hover:bg-white/8 hover:text-snow focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-spark disabled:cursor-not-allowed" onClick={() => remove(slug)} onKeyDown={(event) => { if (event.key === "Backspace" || event.key === "Delete") { event.preventDefault(); remove(slug); } }}>
                <svg className="size-3" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true"><path d="m5 5 6 6M11 5l-6 6" /></svg>
              </button>
            </span>
          );
        })}
        <input
          ref={input}
          id={id}
          role="combobox"
          aria-autocomplete="list"
          aria-haspopup="listbox"
          aria-expanded={expanded}
          aria-controls={expanded ? listId : undefined}
          aria-activedescendant={expanded && options.length ? `${id}-option-${activeIndex}` : undefined}
          aria-describedby={`${id}-help`}
          autoComplete="off"
          disabled={disabled}
          value={query}
          placeholder={selected.length ? "Add coworkers…" : "Search and add coworkers…"}
          className="h-7 min-w-24 flex-[1_1_120px] bg-transparent px-1 text-sm text-snow outline-none placeholder:text-mist/65"
          onFocus={() => { if (!disabled) { setOpen(true); setHighlight(0); } }}
          onClick={() => setOpen(true)}
          onChange={(event) => { setQuery(event.target.value); setHighlight(0); setOpen(true); }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Escape" && expanded) { event.preventDefault(); event.stopPropagation(); setOpen(false); return; }
            if (event.key === "Tab") { setOpen(false); return; }
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              setOpen(true);
              setHighlight((index) => !expanded ? event.key === "ArrowDown" ? 0 : Math.max(0, options.length - 1) : (index + (event.key === "ArrowDown" ? 1 : -1) + options.length) % Math.max(1, options.length));
              return;
            }
            if (event.key === "Enter") {
              event.preventDefault();
              const option = options[activeIndex];
              if (expanded && option) add(option); else setOpen(true);
              return;
            }
            if ((event.key === "Backspace" || event.key === "ArrowLeft") && !query) {
              const buttons = root.current?.querySelectorAll<HTMLButtonElement>("[data-participant-remove]");
              const last = buttons?.item(buttons.length - 1);
              if (last) { event.preventDefault(); setOpen(false); last.focus(); }
            }
          }}
        />
      </div>
      <p id={`${id}-help`} className="text-[11px] text-mist">{atLimit ? "Twenty coworkers added. Remove someone to add another." : "Add coworkers by name. The owner contributes and concludes the session."}</p>
      <span role="status" className="sr-only">{announcement}</span>
      {expanded ? createPortal(
        <div ref={menu} id={listId} role="listbox" aria-label="Available coworkers" aria-multiselectable="true" className="fixed z-[80] overflow-y-auto rounded-xl border border-line bg-ink p-1 shadow-xl" style={position ?? { visibility: "hidden" }}>
          {options.map((coworker, index) => (
            <button key={coworker.slug} type="button" role="option" tabIndex={-1} aria-selected={false} id={`${id}-option-${index}`} data-option-index={index} className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left ${index === activeIndex ? "bg-white/8" : "hover:bg-white/5"}`} onPointerMove={() => setHighlight(index)} onMouseDown={(event) => event.preventDefault()} onClick={() => add(coworker)}>
              <span className="shrink-0">{avatar(coworker, 26)}</span>
              <span className="min-w-0 flex-1"><span className="block truncate text-xs font-medium text-snow">{coworker.name}</span><span className="block truncate text-[10px] text-mist">{coworker.role}</span></span>
              <span aria-hidden="true" className="text-sm text-mist">+</span>
            </button>
          ))}
          {!options.length ? <p className="px-2 py-3 text-xs text-mist">{atLimit ? "Participant limit reached." : !available.length ? "Everyone on your team is added." : "No matching coworkers."}</p> : null}
        </div>, document.body,
      ) : null}
    </div>
  );
}

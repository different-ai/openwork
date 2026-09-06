import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { AvatarColor, AvatarGlasses, CoworkerSummary, TeamStates } from "@/lib/bridge";
import type { DiscussionMessage } from "@/lib/conversation";
import {
  continueWithReply,
  referralSmallPrint,
  resolveTeamCards,
  suggestionSmallPrint,
  type ReferralCard,
  type SuggestionCard,
  type TeamCard,
} from "@/lib/team";
import { CoworkerAvatar } from "@/ui/coworker-avatar";
import { typingInField } from "@/ui/interactions";

/**
 * A teammate as a card: the way a shared contact reads in Messages. One tile
 * for four places — a proposed teammate in onboarding (editable name), a
 * suggested role on the Add screen (the tile is the button), and after a
 * coworker's bubble when it proposes someone or offers to pass work on (the
 * choices are a pill row under the tile, never buttons inside it).
 */
export type TeammateLook = {
  name: string;
  role: string;
  mission: string;
  avatarColor: AvatarColor;
  avatarGlasses: AvatarGlasses;
};

export type ChoicePill = {
  id: string;
  label: string;
  tone?: "primary" | "default";
  onChoose: () => void;
};

const ACCELERATORS = ["a", "b", "c", "d"] as const;

/** The tile itself: avatar, name plate, role, mission, small print. Same radius and width as a bubble. */
export function TeammateTile({
  look,
  smallPrint,
  nod = false,
  children,
  className = "",
  testId = "teammate-card",
  attributes = {},
}: {
  look: TeammateLook;
  smallPrint: string;
  /** One nod when the teammate joins the team; still under reduced motion. */
  nod?: boolean;
  /** What sits in the name plate's place — an editable name, for example. */
  children?: ReactNode;
  className?: string;
  testId?: string;
  attributes?: Record<string, string>;
}) {
  return (
    <div className={`min-w-0 rounded-[18px] bg-panel-2 px-3.5 py-3 text-left [overflow-wrap:anywhere] ${className}`} data-testid={testId} {...attributes}>
      <div className="flex items-start gap-3">
        <span className={`shrink-0 ${nod ? "teammate-nod" : ""}`} data-testid="teammate-card-avatar">
          <CoworkerAvatar animated gaze={false} color={look.avatarColor} glasses={look.avatarGlasses} name={look.name} size={44} />
        </span>
        <div className="min-w-0 flex-1">
          {children ?? <p className="text-[15px] font-semibold leading-snug text-snow" data-testid="teammate-card-name">{look.name}</p>}
          {look.role ? <p className="mt-0.5 text-[13px] leading-snug text-mist" data-testid="teammate-card-role">{look.role}</p> : null}
          {look.mission ? <p className="mt-1.5 text-[13px] leading-snug text-snow/85" data-testid="teammate-card-mission">{look.mission}</p> : null}
          {smallPrint ? <p className="mt-2 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-mist/80" data-testid="teammate-card-small-print">{smallPrint}</p> : null}
        </div>
      </div>
    </div>
  );
}

/**
 * The right-aligned pill row under a tile: tapping one is the person's answer.
 * Letters A–D and Enter work as accelerators (for the last open row on screen,
 * and never while typing) but are read only by assistive tech, never printed.
 */
export function ChoicePills({ pills, testId = "teammate-choices" }: { pills: ChoicePill[]; testId?: string }) {
  const rowRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (pills.length === 0) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || typingInField(event.target)) return;
      const rows = document.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`);
      if (rows[rows.length - 1] !== rowRef.current) return;
      const key = event.key.toLowerCase();
      const index = key === "enter" ? 0 : ACCELERATORS.indexOf(key as (typeof ACCELERATORS)[number]);
      const pill = index >= 0 ? pills[index] : undefined;
      if (!pill) return;
      event.preventDefault();
      pill.onChoose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [pills, testId]);
  if (pills.length === 0) return null;
  return (
    <div ref={rowRef} className="flex w-full flex-wrap justify-end gap-2" data-testid={testId} role="group" aria-label="Your answer">
      {pills.map((pill, index) => (
        <button
          key={pill.id}
          type="button"
          className={`h-8 rounded-full border px-3.5 text-[14px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-spark/50 ${
            pill.tone === "primary"
              ? "border-spark/50 bg-spark/16 text-[#c5d5ff] hover:bg-spark/26"
              : "border-spark/30 bg-spark/6 text-snow/90 hover:bg-spark/14"
          }`}
          data-testid="teammate-choice"
          data-choice={pill.id}
          onClick={pill.onChoose}
        >
          {pill.label}
          {index < ACCELERATORS.length ? <span className="sr-only"> (press {ACCELERATORS[index]?.toUpperCase()}{index === 0 ? " or Enter" : ""})</span> : null}
        </button>
      ))}
    </div>
  );
}

/** A tile whose name the person can change in place: tap it, type, Enter or blur saves; empty restores the default. */
export function EditableTeammateTile({
  look,
  defaultName,
  smallPrint,
  onNameChange,
  onRemove,
  attributes = {},
}: {
  look: TeammateLook;
  defaultName: string;
  smallPrint: string;
  onNameChange: (name: string) => void;
  onRemove?: () => void;
  attributes?: Record<string, string>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(look.name);
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);
  function commit() {
    const next = draft.trim().slice(0, 40) || defaultName;
    setDraft(next);
    onNameChange(next);
    setEditing(false);
  }
  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      commit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      setDraft(look.name);
      setEditing(false);
    }
  }
  return (
    <div className="relative">
      <TeammateTile look={look} smallPrint={smallPrint} className={onRemove ? "pr-11" : ""} attributes={{ "data-kind": "draft", ...attributes }}>
        {editing ? (
          <input
            ref={inputRef}
            className="w-full max-w-[240px] rounded-lg border border-spark/50 bg-ink px-2 py-0.5 text-[15px] font-semibold text-snow focus:outline-none"
            value={draft}
            maxLength={40}
            aria-label="Name"
            data-testid="teammate-card-name-input"
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={onKeyDown}
          />
        ) : (
          <button
            type="button"
            className="group flex max-w-full items-center gap-1.5 rounded-lg text-left text-[15px] font-semibold leading-tight text-snow hover:text-[#c5d5ff] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-spark/50"
            title="Rename"
            data-testid="teammate-card-name"
            onClick={() => {
              setDraft(look.name);
              setEditing(true);
            }}
          >
            <span className="min-w-0 [overflow-wrap:anywhere]">{look.name}</span>
            <span className="text-[11px] text-mist opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" aria-hidden="true">✎</span>
          </button>
        )}
      </TeammateTile>
      {onRemove ? (
        <button
          type="button"
          className="absolute right-2 top-2 flex size-6 items-center justify-center rounded-full text-mist transition-colors hover:bg-white/8 hover:text-snow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-spark/50"
          aria-label={`Remove ${look.name}`}
          title="Remove"
          data-testid="teammate-card-remove"
          onClick={onRemove}
        >
          <span aria-hidden="true">×</span>
        </button>
      ) : null}
    </div>
  );
}

/** A tile that is itself the button: the Add screen's suggested roles. */
export function PickTeammateTile({ look, smallPrint, onPick, attributes = {} }: { look: TeammateLook; smallPrint: string; onPick: () => void; attributes?: Record<string, string> }) {
  return (
    <button
      type="button"
      className="min-w-0 w-full rounded-[18px] text-left transition-colors hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-spark/50"
      data-testid="teammate-pick"
      onClick={onPick}
      {...attributes}
    >
      <TeammateTile look={look} smallPrint={smallPrint} attributes={{ "data-kind": "pick", ...attributes }} />
    </button>
  );
}

/** What the conversation needs from the coworker's home to answer a tile. */
export type TeamHooks = {
  /** How the person answered each offer so far; refreshed after every tap. */
  states: TeamStates | null;
  coworkers: readonly CoworkerSummary[];
  accept: (card: SuggestionCard) => Promise<void>;
  decline: (card: SuggestionCard) => Promise<void>;
  /** Pass the request to the teammate: records the choice, then switches to them and sends it with a brief built from the recent exchanges. */
  ask: (card: ReferralCard, recent: ReadonlyArray<DiscussionMessage>) => Promise<void>;
  /** Keep this coworker on it: records the choice; the conversation sends the pill's words. */
  continueWith: (card: ReferralCard) => Promise<void>;
  sayHi: (slug: string) => void;
};

function shortDate(at: number): string {
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/**
 * The tiles a coworker's reply ends with, settled from the person's answers
 * and the transcript: a proposed teammate (Add to team / Not now → Say hi), or
 * an offer to pass the request on (Ask <name> / Continue with <coworker>).
 */
export function TeamCardsForTurn({
  cards,
  coworker,
  team,
  laterPersonMessage,
  recent,
  onSendReply,
}: {
  cards: readonly TeamCard[];
  coworker: CoworkerSummary;
  team: TeamHooks;
  /** The person wrote something after this reply: open pills close, the tile stays as a record. */
  laterPersonMessage: boolean;
  /** The visible conversation so far, for the brief a hand-over carries. */
  recent: ReadonlyArray<DiscussionMessage>;
  /** Send words as the person's next message (the Continue pill). */
  onSendReply: (text: string) => void;
}) {
  const [busyId, setBusyId] = useState("");
  const [justAdded, setJustAdded] = useState("");
  const resolved = resolveTeamCards(cards, team.states, laterPersonMessage);
  if (resolved.length === 0) return null;
  const run = async (id: string, work: () => Promise<void>) => {
    if (busyId) return;
    setBusyId(id);
    try {
      await work();
    } finally {
      setBusyId("");
    }
  };
  return (
    <>
      {resolved.map((card) => {
        if (card.kind === "suggestion") {
          const proposer = team.coworkers.find((member) => member.slug === card.by)?.name ?? coworker.name;
          const recorded = team.states?.suggestions.find((entry) => entry.id === card.id);
          const look: TeammateLook = { name: card.name, role: card.role, mission: card.mission, avatarColor: card.avatarColor, avatarGlasses: card.avatarGlasses };
          const smallPrint = card.state === "added"
            ? `Added to your team · ${recorded?.at ? shortDate(recorded.at) : "just now"}`
            : card.state === "declined"
              ? `Not now${recorded?.at ? ` · ${shortDate(recorded.at)}` : ""}`
              : suggestionSmallPrint(card, proposer);
          const pills: ChoicePill[] = card.state === "open"
            ? [
              { id: "add", label: busyId === card.id ? "Adding…" : "Add to team", tone: "primary", onChoose: () => void run(card.id, () => team.accept(card).then(() => setJustAdded(card.id))) },
              { id: "dismiss", label: "Not now", onChoose: () => void run(card.id, () => team.decline(card)) },
            ]
            : card.state === "added" && card.createdSlug
              ? [{ id: "say-hi", label: "Say hi", tone: "primary", onChoose: () => team.sayHi(card.createdSlug) }]
              : [];
          return (
            <div key={card.id} className="flex w-full max-w-[76%] flex-col items-stretch gap-2">
              <TeammateTile
                look={look}
                smallPrint={smallPrint}
                nod={justAdded === card.id}
                attributes={{ "data-kind": "suggestion", "data-state": card.state, "data-suggestion-id": card.id, ...(card.createdSlug ? { "data-slug": card.createdSlug } : {}) }}
              />
              <ChoicePills pills={pills} />
            </div>
          );
        }
        const look: TeammateLook = { name: card.to.name, role: card.to.role, mission: card.to.mission, avatarColor: card.to.avatarColor, avatarGlasses: card.to.avatarGlasses };
        const smallPrint = card.state === "asked"
          ? `Passed to ${card.to.name}`
          : card.state === "continued"
            ? `${coworker.name} kept it`
            : referralSmallPrint(card);
        const pills: ChoicePill[] = card.state === "open"
          ? [
            { id: "ask", label: busyId === card.id ? `Asking ${card.to.name}…` : `Ask ${card.to.name}`, tone: "primary", onChoose: () => void run(card.id, () => team.ask(card, recent)) },
            {
              id: "continue",
              label: `Continue with ${coworker.name}`,
              onChoose: () => void run(card.id, async () => {
                await team.continueWith(card);
                onSendReply(continueWithReply(coworker.name));
              }),
            },
          ]
          : [];
        return (
          <div key={card.id} className="flex w-full max-w-[76%] flex-col items-stretch gap-2">
            <TeammateTile look={look} smallPrint={smallPrint} attributes={{ "data-kind": "referral", "data-state": card.state, "data-slug": card.to.slug, "data-referral-id": card.id }} />
            <ChoicePills pills={pills} />
          </div>
        );
      })}
    </>
  );
}

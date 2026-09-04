/**
 * What one turn of a discussion is doing, as one value.
 *
 * The view, the header status, the rail line, Activity's Now card, and the
 * journeys all read this instead of piecing it together from a pending flag,
 * an engine status, and an error string. It is derived from facts only — the
 * turn in flight, what the engine reports, the reply it holds, and the wait
 * budget — so every transition can be tested without a component.
 *
 *   working        the coworker is on it
 *   slow           the wait budget passed while the engine is still busy — not a failure
 *   retrying       the AI model could not be reached; the next attempt is scheduled
 *   waiting-on-you a permission or a question is waiting for the person
 *   stopped-by-you the person pressed Stop
 *   cut-off        the app closed (or the AI service stopped) before the reply arrived
 *   failed         the turn ended without a reply and needs the person
 *   replied        the reply landed
 */
import { describeTurnFailure } from "./turn-failure.ts";
import { describeWait } from "./turn-retry.ts";
import { STALE_RETRY_MS, stalledRetry } from "./threads.ts";

export type TurnOutcomeKind = "working" | "slow" | "retrying" | "waiting-on-you" | "stopped-by-you" | "cut-off" | "failed" | "replied";

export type TurnChoiceId = "retry" | "use-model" | "choose-model" | "connect-provider" | "continue-with-openwork" | "refresh-providers" | "stop" | "continue" | "discard";

export type TurnChoice = {
  id: TurnChoiceId;
  label: string;
  /** Set on a failure's lettered choices; quiet lines carry plain inline actions. */
  letter?: "A" | "B" | "C";
};

/**
 * A choice that opens another screen — Coworker settings, OpenWork's account
 * or AI models — rather than acting on the turn. The failure's card stays
 * ready for when the person comes back; only a choice that acts on the turn
 * (retry, another model, a refresh, continue, discard) holds it busy until
 * the outcome moves on.
 */
export function choiceNavigates(id: TurnChoiceId): boolean {
  return id === "choose-model" || id === "connect-provider" || id === "continue-with-openwork";
}

export type TurnOutcome = {
  kind: TurnOutcomeKind;
  messageId: string;
  prompt: string;
  /** When this state began: the send, the stop, the failure. */
  since: number;
  /** The words in the conversation: a quiet line, the live row's softened phrase, or a failure's headline. */
  line: string;
  /** One line of explanation under a failure headline; empty otherwise. */
  detail: string;
  /** The raw text behind Technical details; empty when there is none worth showing. */
  technical: string;
  /** The word the header, the rail, and Activity share: Working, Still working, Retrying, Needs you, Reply failed, Stopped. */
  label: string;
  /** How that word reads: spark while the coworker works, amber when the person is needed, mist once settled. */
  tone: "spark" | "amber" | "mist";
  /** What the person can do, primary first. Failures letter theirs; there are never more than three. */
  choices: TurnChoice[];
  /** While retrying: the attempt that is coming, when, whose retry it is, and the engine's reason when it gave one. */
  retry: { attempt: number; nextAt: number; by: "engine" | "app"; reason: string | null } | null;
  /** Whether a different AI model is the likely way out. */
  modelRelated: boolean;
};

export type TurnEngineStatus =
  | { type: "idle" }
  | { type: "busy" }
  /** `reason` is the engine's own word for why, when it gives one: `free_tier_limit` for the free model's shared limit. */
  | { type: "retry"; attempt: number; message: string; next: number; reason: string | null }
  | { type: "unknown" };

/** The engine's reason for a retry that means the free model's shared limit, not a hiccup. */
export const FREE_MODEL_LIMIT_REASON = "free_tier_limit";

export type TurnReplyState = {
  /** `none`: no reply yet; `writing`: the engine has not closed it; `complete`: it finished; `error`: it carries an error. */
  state: "none" | "writing" | "complete" | "error";
  error: string;
  retryable: boolean | null;
  /** The error is the engine's own abort, not the provider's refusal. */
  aborted: boolean;
};

export type TurnFacts = {
  coworkerName: string;
  now: number;
  /** The turn in flight or left unresolved. `recovered`: it was read back from disk after a quit or reload. */
  turn: { messageId: string; prompt: string; startedAt: number; stoppedAt: number | null; recovered: boolean } | null;
  engine: TurnEngineStatus;
  reply: TurnReplyState;
  /** A permission or a question is waiting for the person. */
  needsYou: boolean;
  /** A failure the app met itself: a model not connected, a refused send, a far-off retry it cancelled. */
  failure: string;
  /** An automatic attempt the app scheduled after a transient failure. */
  appRetry: { attempt: number; nextAt: number } | null;
  /** The view is still classifying this attempt; do not expose its raw terminal message yet. */
  attemptActive: boolean;
  /** How long the coworker may work before "still working" is said out loud. */
  waitBudgetMs: number;
  signedIn: boolean;
  /** The plain label of a different tool-capable model that is connected; empty when there is none. */
  recommendedModel: string;
};

/** How long a freshly sent turn may wait before "still working" is worth saying. */
export const WAIT_BUDGET_MS = 120_000;

export const NO_REPLY: TurnReplyState = { state: "none", error: "", retryable: null, aborted: false };

const STOP: TurnChoice = { id: "stop", label: "Stop" };
const RETRY: TurnChoice = { id: "retry", label: "Retry" };
const CONNECT_PROVIDER: TurnChoice = { id: "connect-provider", label: "Connect an AI provider" };

export const RETRY_LINE = "Couldn't reach the AI model.";
export const FREE_MODEL_RETRY_LINE = "The free model is busy.";
export const STOPPED_LINE = "Stopped.";

export function cutOffLine(coworkerName: string): string {
  return `Stopped when the app closed before ${coworkerName} replied.`;
}

export function stillWorkingLine(coworkerName: string): string {
  return `${coworkerName} is still working on it…`;
}

/**
 * "Couldn't reach the AI model. Trying again in 6 s…" — the count is live, so the caller re-derives each
 * second. When the engine says the free model's shared limit is the reason, the line says that instead,
 * in the app's words, never the engine's own remedy copy.
 */
export function retryLine(nextAt: number, now: number, reason: string | null = null): string {
  const wait = nextAt - now;
  return wait > 500 ? `${retryCause(reason)} Trying again in ${describeWait(wait)}…` : retrySummary(reason);
}

/** The cause a retry line opens with: the free model's limit when the engine says so, else the model out of reach. */
export function retryCause(reason: string | null): string {
  return reason === FREE_MODEL_LIMIT_REASON ? FREE_MODEL_RETRY_LINE : RETRY_LINE;
}

/** The retry line without its live count — for the rail and Activity, which do not tick. */
export function retrySummary(reason: string | null): string {
  return `${retryCause(reason)} Trying again…`;
}

/**
 * The lettered ways out of a failure, at most three: the primary first — a
 * connected model that can take over, otherwise Retry — then another AI
 * model, then the account step that fits (signed out: Continue with OpenWork;
 * signed in with a model problem: Refresh providers). When the free model's
 * shared limit is the cause, the third way is the one that actually helps:
 * connecting the person's own AI provider.
 */
export function failureChoices(input: { modelRelated: boolean; recommendedModel: string; signedIn: boolean; freeModelLimit?: boolean }): TurnChoice[] {
  const primary: TurnChoice = input.modelRelated && input.recommendedModel
    ? { id: "use-model", label: `Use ${input.recommendedModel}`, letter: "A" }
    : { ...RETRY, letter: "A" };
  const choices: TurnChoice[] = [primary, { id: "choose-model", label: "Choose AI model", letter: "B" }];
  if (input.freeModelLimit) {
    choices.push({ ...CONNECT_PROVIDER, letter: "C" });
  } else if (input.modelRelated) {
    choices.push(input.signedIn
      ? { id: "refresh-providers", label: "Refresh providers", letter: "C" }
      : { id: "continue-with-openwork", label: "Continue with OpenWork", letter: "C" });
  }
  return choices;
}

function failed(facts: TurnFacts, turn: NonNullable<TurnFacts["turn"]>, raw: string, retryable: boolean | null): TurnOutcome {
  const failure = describeTurnFailure(raw, facts.coworkerName, retryable);
  return {
    kind: "failed",
    messageId: turn.messageId,
    prompt: turn.prompt,
    since: turn.startedAt,
    line: failure.headline,
    detail: failure.detail,
    technical: failure.technical,
    label: "Reply failed",
    tone: "amber",
    choices: failureChoices({ modelRelated: failure.modelRelated, recommendedModel: facts.recommendedModel, signedIn: facts.signedIn, freeModelLimit: failure.freeModelLimit }),
    retry: null,
    modelRelated: failure.modelRelated,
  };
}

/**
 * Derive the outcome. Returns null when there is nothing to say: no turn is
 * in flight or left unresolved, and nobody is waiting on the person.
 */
export function deriveTurnOutcome(facts: TurnFacts): TurnOutcome | null {
  const { turn, now } = facts;
  if (facts.needsYou) {
    return {
      kind: "waiting-on-you",
      messageId: turn?.messageId ?? "",
      prompt: turn?.prompt ?? "",
      since: now,
      line: "",
      detail: "",
      technical: "",
      label: "Needs you",
      tone: "amber",
      choices: [],
      retry: null,
      modelRelated: false,
    };
  }
  if (!turn) return null;
  const base = { messageId: turn.messageId, prompt: turn.prompt, detail: "", technical: "", retry: null, modelRelated: false } as const;

  if (facts.appRetry) {
    return {
      ...base,
      kind: "retrying",
      since: turn.startedAt,
      line: retryLine(facts.appRetry.nextAt, now),
      label: "Retrying",
      tone: "amber",
      choices: [STOP],
      retry: { attempt: facts.appRetry.attempt, nextAt: facts.appRetry.nextAt, by: "app", reason: null },
    };
  }
  // The person's stop outranks whatever the wait itself reported on the way out.
  if (turn.stoppedAt !== null) {
    return { ...base, kind: "stopped-by-you", since: turn.stoppedAt, line: STOPPED_LINE, label: "Stopped", tone: "mist", choices: [RETRY] };
  }
  if (facts.failure) return failed(facts, turn, facts.failure, null);

  // The engine's own retry: a stale one (its moment long past) is over; a far-off one is a stall the
  // person hears about as a failure with the provider's words; anything else is trying again, live.
  let engine = facts.engine;
  if (engine.type === "retry") {
    if (now - engine.next > STALE_RETRY_MS) engine = { type: "idle" };
    else {
      const freeModelLimit = engine.reason === FREE_MODEL_LIMIT_REASON;
      const stalled = stalledRetry({ next: engine.next, message: engine.message }, now);
      // A far-off retry on the free model's limit is that limit, named: the engine's reason rides along so the
      // failure reads as the free model's, whatever the engine's own line says.
      if (stalled) return failed(facts, turn, freeModelLimit ? `${stalled} (${FREE_MODEL_LIMIT_REASON})` : stalled, false);
      return {
        ...base,
        kind: "retrying",
        since: turn.startedAt,
        line: retryLine(engine.next, now, engine.reason),
        label: "Retrying",
        tone: "amber",
        choices: freeModelLimit ? [STOP, CONNECT_PROVIDER] : [STOP],
        retry: { attempt: engine.attempt, nextAt: engine.next, by: "engine", reason: engine.reason },
        modelRelated: freeModelLimit,
      };
    }
  }

  const reply = facts.reply;
  if (reply.state === "error" && !facts.attemptActive) {
    if (reply.aborted) {
      if (turn.recovered) return { ...base, kind: "cut-off", since: turn.startedAt, line: cutOffLine(facts.coworkerName), label: "Stopped", tone: "mist", choices: [{ id: "continue", label: "Continue" }, { id: "discard", label: "Discard" }] };
      return failed(facts, turn, "The model stopped before producing a response.", false);
    }
    return failed(facts, turn, reply.error, reply.retryable);
  }
  if (reply.state === "complete" && engine.type !== "busy") {
    return { ...base, kind: "replied", since: turn.startedAt, line: "", label: "Ready", tone: "mist", choices: [] };
  }
  const running = engine.type === "busy";
  if (!running && turn.recovered) {
    // Read back after a quit or reload with the engine idle and no finished reply: the turn was cut off.
    return { ...base, kind: "cut-off", since: turn.startedAt, line: cutOffLine(facts.coworkerName), label: "Stopped", tone: "mist", choices: [{ id: "continue", label: "Continue" }, { id: "discard", label: "Discard" }] };
  }
  if (now - turn.startedAt >= facts.waitBudgetMs) {
    return { ...base, kind: "slow", since: turn.startedAt, line: stillWorkingLine(facts.coworkerName), label: "Still working", tone: "spark", choices: [STOP] };
  }
  return { ...base, kind: "working", since: turn.startedAt, line: "", label: "Working", tone: "spark", choices: [STOP] };
}

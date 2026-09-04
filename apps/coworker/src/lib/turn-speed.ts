/**
 * How fast a reply came, in words a person reads: when the first words
 * appeared after they pressed Send, how long the whole reply took, and how much
 * the model thought (when it says). Shown only in a reply's tooltip and the live
 * row's small print — never in the transcript itself. Nothing here is guessed:
 * a fact that is missing drops its clause.
 */
export type TurnSpeedFacts = {
  /** When the person pressed Send. */
  sentAt: number | null;
  /** When the first words of the reply reached the screen (client clock). */
  firstWordsAt: number | null;
  /** When the engine closed the reply. */
  completedAt: number | null;
  /** Reasoning tokens the model reported for this reply; 0 or null when it reports none. */
  reasoningTokens: number | null;
};

/** Under this many milliseconds a span reads as "under a second". */
export const UNDER_A_SECOND_MS = 950;

/** "1.8 s", "12 s", "1 min 5 s", "under a second". */
export function describeSpan(ms: number): string {
  if (ms < UNDER_A_SECOND_MS) return "under a second";
  if (ms < 10_000) return `${(Math.round(ms / 100) / 10).toFixed(1).replace(/\.0$/, "")} s`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes} min ${rest} s` : `${minutes} min`;
}

/** The moments first words arrived, by the person's message id, kept for the profile so a reload keeps the speed line. */
export const FIRST_WORDS_KEY = "open-coworker.first-words.v1";
/** How many replies' moments are kept; the oldest go first. */
export const FIRST_WORDS_CAP = 200;

type MomentStorage = Pick<Storage, "getItem" | "setItem">;

function readMoments(storage: MomentStorage | null): Array<[string, number]> {
  if (!storage) return [];
  try {
    const parsed: unknown = JSON.parse(storage.getItem(FIRST_WORDS_KEY) ?? "");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is [string, number] => Array.isArray(entry) && typeof entry[0] === "string" && typeof entry[1] === "number");
  } catch {
    return [];
  }
}

/** Remember when the first words of the reply to `messageId` appeared; an earlier moment for the same reply stands. */
export function rememberFirstWords(storage: MomentStorage | null, messageId: string, at: number): void {
  if (!storage || !messageId) return;
  const moments = readMoments(storage);
  if (moments.some(([id]) => id === messageId)) return;
  const next = [...moments, [messageId, at] as [string, number]].slice(-FIRST_WORDS_CAP);
  try {
    storage.setItem(FIRST_WORDS_KEY, JSON.stringify(next));
  } catch {
    // Storage full or unavailable: the speed line simply has no first-words clause.
  }
}

export function firstWordsFor(storage: MomentStorage | null, messageId: string): number | null {
  return readMoments(storage).find(([id]) => id === messageId)?.[1] ?? null;
}

/**
 * "first words in 1.8 s · 6.3 s in all · 320 words of thinking". Each clause
 * appears only when its facts exist; the whole thing is empty when none do.
 * "Words of thinking" is the person's phrase for reasoning tokens.
 */
export function describeSpeed(facts: TurnSpeedFacts): string {
  const clauses: string[] = [];
  if (facts.sentAt !== null && facts.firstWordsAt !== null && facts.firstWordsAt >= facts.sentAt) {
    clauses.push(`first words in ${describeSpan(facts.firstWordsAt - facts.sentAt)}`);
  }
  if (facts.sentAt !== null && facts.completedAt !== null && facts.completedAt >= facts.sentAt) {
    clauses.push(`${describeSpan(facts.completedAt - facts.sentAt)} in all`);
  }
  if (typeof facts.reasoningTokens === "number" && facts.reasoningTokens > 0) {
    clauses.push(`${facts.reasoningTokens.toLocaleString("en-US")} words of thinking`);
  }
  return clauses.join(" · ");
}

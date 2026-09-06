import { setTimeout as delay } from "node:timers/promises";
import type { Target } from "@openwork/cdp";

export interface TypingProfile {
  focusMs: number;
  characterMs: number;
  cadenceMs: readonly number[];
  wordMs: number;
  punctuationMs: number;
  finishMs: number;
}

export const readableTyping: TypingProfile = {
  focusMs: 180,
  characterMs: 65,
  cadenceMs: [0, -8, 4, 10, -4],
  wordMs: 100,
  punctuationMs: 140,
  finishMs: 250,
};

export interface FieldTypingOptions {
  typing?: TypingProfile;
  replace?: boolean;
  sensitive?: boolean;
  verify?: boolean;
}

interface FieldUser {
  type(
    target: Target,
    text: string,
    options?: FieldTypingOptions,
  ): Promise<void>;
}

/** A complete field at a time: focus once, replace, type, then verify its value. */
export async function typeField(
  user: FieldUser,
  target: Target,
  value: string,
  options: FieldTypingOptions = {},
): Promise<void> {
  await user.type(target, value, {
    typing: readableTyping,
    replace: true,
    ...options,
    verify: true,
  });
}

export function typingPlan(text: string, profile: TypingProfile) {
  const durations = [
    profile.focusMs,
    profile.characterMs,
    profile.wordMs,
    profile.punctuationMs,
    profile.finishMs,
  ];
  if (
    durations.some((ms) => !Number.isFinite(ms) || ms < 0) ||
    profile.cadenceMs.length === 0 ||
    profile.cadenceMs.some((ms) => !Number.isFinite(ms))
  ) {
    throw new Error(
      "Typing durations must be finite and nonnegative; cadence must be nonempty.",
    );
  }
  const graphemes = Array.from(
    new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text),
    (part) => part.segment,
  );
  return graphemes.map((text, index) => ({
    text,
    pauseMs:
      Math.max(
        0,
        profile.characterMs +
          profile.cadenceMs[index % profile.cadenceMs.length],
      ) +
      (/\s/u.test(text)
        ? profile.wordMs
        : /[.,!?;:]/u.test(text)
          ? profile.punctuationMs
          : 0),
  }));
}

/** Deterministic pacing, with graphemes kept intact and no text in event metadata. */
export async function typeWithCadence(
  text: string,
  profile: TypingProfile,
  insert: (text: string) => Promise<void>,
  wait: (ms: number) => Promise<void> = delay,
): Promise<void> {
  const plan = typingPlan(text, profile);
  await wait(profile.focusMs);
  for (const character of plan) {
    await insert(character.text);
    await wait(character.pauseMs);
  }
  await wait(profile.finishMs);
}

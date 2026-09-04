/**
 * Turns a raw model/provider failure into one human headline, an optional
 * plain-language detail, and the untouched technical text for a disclosure.
 * The person needs an outcome and a next step, not a provider stack trace.
 */
import { classifyFailure } from "./turn-retry.ts";

export type TurnFailure = {
  headline: string;
  /** Short plain-language explanation; empty when the headline says enough. */
  detail: string;
  /** The exact upstream message, shown only under "Technical details". */
  technical: string;
  /** Whether choosing a different AI model is the likely fix. */
  modelRelated: boolean;
  /** Whether simply trying again may clear it (network, a busy or rate-limited provider, a 5xx). */
  transient: boolean;
  /** The free model's shared limit was reached: waiting or the person's own AI provider is the way out. */
  freeModelLimit: boolean;
};

/**
 * The engine's error as one line of raw text: its name, the provider's own
 * error type when the engine relayed one ("APIError · FreeUsageLimitError: …"),
 * then the message. `describeTurnFailure`, the retry decision, and Technical
 * details all read this same line, so the cause is never lost between them.
 */
export function failureText(error: { name: string; message: string; providerError: string | null }): string {
  const name = error.providerError && error.providerError !== error.name ? `${error.name} · ${error.providerError}` : error.name;
  return `${name}: ${error.message}`;
}

const SAVED_MODEL = /^The saved model "([^"]+)"/;
/** The engine's names for the free model's shared limit: the provider's error type, its retry reason, its own retry line. */
export const FREE_MODEL_LIMIT = /FreeUsageLimitError|free_tier_limit|free usage exceeded/i;

export const FREE_MODEL_LIMIT_HEADLINE = "The free model is busy right now.";

export function freeModelLimitDetail(coworkerName: string): string {
  return `Too many people are using the free model at once. Wait a few minutes and try again, or connect your own AI provider so ${coworkerName} can keep working.`;
}

export function describeTurnFailure(raw: string, coworkerName: string, retryable: boolean | null = null): TurnFailure {
  const message = raw.trim();
  const transient = classifyFailure(message, retryable) === "transient";
  const saved = SAVED_MODEL.exec(message);
  if (saved) {
    return {
      headline: `${coworkerName}'s AI model is not available.`,
      detail: message,
      technical: "",
      modelRelated: true,
      transient: false,
      freeModelLimit: false,
    };
  }
  if (/^No connected AI model can use tools\./.test(message)) {
    return {
      headline: "No connected AI model can use tools.",
      detail: "Connect an AI provider in OpenWork, or choose an AI model in Coworker settings.",
      technical: "",
      modelRelated: true,
      transient: false,
      freeModelLimit: false,
    };
  }
  if (/no endpoints found that support tool use/i.test(message) || /does not support tool/i.test(message)) {
    return {
      headline: `${coworkerName}'s AI model cannot use the tools enabled for this coworker.`,
      detail: "Choose an AI model that supports tools, or retry once the provider is available again.",
      technical: message,
      modelRelated: true,
      transient: false,
      freeModelLimit: false,
    };
  }
  if (!message || /stopped before producing a response/i.test(message)) {
    return {
      headline: `${coworkerName} stopped before replying.`,
      detail: "",
      technical: message,
      modelRelated: false,
      transient: false,
      freeModelLimit: false,
    };
  }
  if (FREE_MODEL_LIMIT.test(message)) {
    return {
      headline: FREE_MODEL_LIMIT_HEADLINE,
      detail: freeModelLimitDetail(coworkerName),
      technical: message,
      modelRelated: true,
      transient: false,
      freeModelLimit: true,
    };
  }
  if (transient) {
    return {
      headline: `${coworkerName} couldn't reach the AI model.`,
      detail: "The AI provider didn't answer. This usually clears up by itself; you can also try another AI model.",
      technical: message,
      modelRelated: true,
      transient: true,
      freeModelLimit: false,
    };
  }
  if (/model|provider|endpoint|api ?key|unauthorized|401|403|quota|rate limit|429|usage exceeded|free usage|subscribe/i.test(message)) {
    return {
      headline: `${coworkerName}'s AI model could not answer.`,
      detail: "The AI provider rejected the request. Choose another AI model or check your account.",
      technical: message,
      modelRelated: true,
      transient: false,
      freeModelLimit: false,
    };
  }
  return {
    headline: `${coworkerName} could not reply.`,
    detail: "",
    technical: message,
    modelRelated: false,
    transient: false,
    freeModelLimit: false,
  };
}

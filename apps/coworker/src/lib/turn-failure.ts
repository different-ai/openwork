/**
 * Turns a raw model/provider failure into one human headline, an optional
 * plain-language detail, and the untouched technical text for a disclosure.
 * The person needs an outcome and a next step, not a provider stack trace.
 */
export type TurnFailure = {
  headline: string;
  /** Short plain-language explanation; empty when the headline says enough. */
  detail: string;
  /** The exact upstream message, shown only under "Technical details". */
  technical: string;
  /** Whether choosing a different AI model is the likely fix. */
  modelRelated: boolean;
};

const SAVED_MODEL = /^The saved model "([^"]+)"/;

export function describeTurnFailure(raw: string, coworkerName: string): TurnFailure {
  const message = raw.trim();
  const saved = SAVED_MODEL.exec(message);
  if (saved) {
    return {
      headline: `${coworkerName}'s AI model is not available.`,
      detail: message,
      technical: "",
      modelRelated: true,
    };
  }
  if (/^No connected AI model can use tools\./.test(message)) {
    return {
      headline: "No connected AI model can use tools.",
      detail: "Connect an AI provider in OpenWork, or choose an AI model in Coworker settings.",
      technical: "",
      modelRelated: true,
    };
  }
  if (/no endpoints found that support tool use/i.test(message) || /does not support tool/i.test(message)) {
    return {
      headline: `${coworkerName}'s AI model cannot use the tools enabled for this coworker.`,
      detail: "Choose an AI model that supports tools, or retry once the provider is available again.",
      technical: message,
      modelRelated: true,
    };
  }
  if (!message || /stopped before producing a response/i.test(message)) {
    return {
      headline: `${coworkerName} stopped before replying.`,
      detail: "",
      technical: message,
      modelRelated: false,
    };
  }
  if (/model|provider|endpoint|api ?key|unauthorized|401|403|quota|rate limit|429|usage exceeded|free usage|subscribe/i.test(message)) {
    return {
      headline: `${coworkerName}'s AI model could not answer.`,
      detail: "The AI provider rejected the request. Choose another AI model or check your account.",
      technical: message,
      modelRelated: true,
    };
  }
  return {
    headline: `${coworkerName} could not reply.`,
    detail: "",
    technical: message,
    modelRelated: false,
  };
}

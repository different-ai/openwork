// What the engine is about to send to a model, or keep in a conversation, passes through here and comes back with
// every private value this app holds replaced. Nothing is done while the store is empty or the feature was never
// on. Once it has been on while a value was held it stays on until the app quits: the values are held that long.

/**
 * @param {{
 *   secrets: { holding(): boolean, redactText(text: string): string },
 *   enabled: () => Promise<boolean>,
 * }} input
 * @returns {(texts: string[] | null) => Promise<{ held: boolean, texts?: string[] }>} Null asks only whether anything is held.
 */
export function createPrivateTextFilter({ secrets, enabled }) {
  let on = false;
  return async (texts) => {
    if (!secrets.holding()) return { held: false };
    if (!on && !(await enabled())) return { held: false };
    on = true;
    return texts ? { held: true, texts: texts.map((text) => secrets.redactText(text)) } : { held: true };
  };
}

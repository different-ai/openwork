import type { Place, Seed } from "@openwork/env";
import { browserScript } from "@openwork/cdp";
import { workbotContinuity } from "./workbot-continuity.ts";

/** Real Workbot UI; only browser recognition events and signed-in API replies
 * are fixtures. This proves streaming/edit/send behavior, not acoustic accuracy. */
export async function nativeDictation(seed: Seed, options: { place: Place }) {
  const base = await workbotContinuity(seed, options);
  return {
    ...base,
    installSpeech: () => seed.evalIn(base.web, browserScript(() => {
      let latest: Speech | null = null;
      class Speech {
        lang = "";
        continuous = false;
        interimResults = false;
        onstart: (() => void) | null = null;
        onend: (() => void) | null = null;
        onerror: ((event: { error: string }) => void) | null = null;
        onresult: ((event: { results: Array<Array<{ transcript: string }>> }) => void) | null = null;
        constructor() { latest = this; }
        start() { this.onstart?.(); }
        stop() { this.onend?.(); }
        abort() { this.onend?.(); }
      }
      Reflect.set(window, "SpeechRecognition", Speech);
      Reflect.set(window, "__dictationFixture", {
        words(text: string) { latest?.onresult?.({ results: [[{ transcript: text }]] }); },
      });
    }, [])),
    recognize: (text: string) => seed.evalIn(base.web, browserScript((words: string) => {
      const fixture: unknown = Reflect.get(window, "__dictationFixture");
      if (typeof fixture !== "object" || fixture === null || !("words" in fixture) || typeof fixture.words !== "function") throw new Error("Speech fixture is missing");
      fixture.words(words);
    }, [text])),
    async [Symbol.asyncDispose]() { await base[Symbol.asyncDispose](); },
  };
}

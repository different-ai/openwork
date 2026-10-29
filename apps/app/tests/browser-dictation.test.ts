import { expect, test } from "bun:test";
import { createBrowserDictation, type BrowserSpeechRecognition } from "../../../packages/ui/src/react/browser-dictation";

class Recognition implements BrowserSpeechRecognition {
  lang = "";
  continuous = false;
  interimResults = false;
  onstart: BrowserSpeechRecognition["onstart"] = null;
  onend: BrowserSpeechRecognition["onend"] = null;
  onerror: BrowserSpeechRecognition["onerror"] = null;
  onresult: BrowserSpeechRecognition["onresult"] = null;
  aborted = 0;
  start() { this.onstart?.() }
  stop() {}
  abort() { this.aborted++; this.onend?.() }
  words(...transcripts: string[]) { this.onresult?.({ results: transcripts.map(transcript => [{ transcript }]) }) }
}

test("interim speech replaces a selection and revisions never duplicate earlier words", () => {
  const recognition = new Recognition();
  let text = "Ask about Friday tomorrow";
  const owner = createBrowserDictation({ recognition, text, selection: { start: 10, end: 16 }, language: "en-US", onText: value => { text = value }, onState: () => {}, onError: () => {} });
  owner.start();
  recognition.words("Monday");
  expect(text).toBe("Ask about Monday tomorrow");
  recognition.words("Monday ", "and Tuesday");
  expect(text).toBe("Ask about Monday and Tuesday tomorrow");
  recognition.words("Monday", "and Wednesday");
  expect(text).toBe("Ask about Monday and Wednesday tomorrow");
  recognition.words();
  expect(text).toBe("Ask about Friday tomorrow");
  expect(recognition.interimResults).toBe(true);
  expect(recognition.lang).toBe("en-US");
  owner.commit();
});

test("Send commits the latest interim words immediately and late speech cannot refill the next draft", () => {
  const recognition = new Recognition();
  let text = "";
  const owner = createBrowserDictation({ recognition, text, selection: { start: 0, end: 0 }, language: "en-US", onText: value => { text = value }, onState: () => {}, onError: () => {} });
  owner.start();
  recognition.words("Prepare my week");
  expect(owner.commit()).toBe("Prepare my week");
  text = "";
  recognition.words("Unexpected late result");
  expect(text).toBe("");
  expect(recognition.aborted).toBe(1);
});

test("Stop accepts the final refinement without sending, and permission errors keep existing words", () => {
  const recognition = new Recognition();
  let text = "";
  let error = "";
  let state = "";
  const owner = createBrowserDictation({ recognition, text, selection: { start: 0, end: 0 }, language: "en-US", onText: value => { text = value }, onState: value => { state = value }, onError: value => { error = value } });
  owner.start();
  recognition.words("Plan the weak");
  owner.stop();
  recognition.words("Plan the week");
  recognition.onend?.();
  expect(text).toBe("Plan the week");
  expect(state).toBe("idle");
  recognition.onerror?.({ error: "not-allowed" });
  expect(error).toBe("");
  const retry = new Recognition();
  const next = createBrowserDictation({ recognition: retry, text, selection: { start: text.length, end: text.length }, language: "en-US", onText: value => { text = value }, onState: () => {}, onError: value => { error = value } });
  next.start();
  retry.onerror?.({ error: "not-allowed" });
  expect(error).toBe("Allow microphone access in your browser.");
  expect(text).toBe("Plan the week");
});

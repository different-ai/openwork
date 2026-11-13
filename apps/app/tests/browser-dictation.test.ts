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
  onstatus: BrowserSpeechRecognition["onstatus"] = null;
  aborted = 0;
  start() { this.onstart?.() }
  stop() {}
  abort() { this.aborted++; this.onend?.() }
  words(...transcripts: string[]) { this.onresult?.({ results: transcripts.map(transcript => [{ transcript }]) }) }
}

test("live dictation replaces a selection and preserves the final correction", () => {
  const recognition = new Recognition();
  const changes: string[] = [];
  const owner = createBrowserDictation({ recognition, text: "Ask Friday tomorrow", selection: { start: 4, end: 10 },
    language: "en-US", onText: text => changes.push(text), onState: () => {}, onError: () => {} });
  owner.start();
  recognition.words("the weak");
  expect(changes).toEqual(["Ask the weak tomorrow"]);
  expect(owner.text()).toBe("Ask the weak tomorrow");
  owner.stop();
  recognition.words("the week.");
  expect(changes.at(-1)).toBe("Ask the week. tomorrow");
  recognition.onend?.();
  expect(changes.at(-1)).toBe("Ask the week. tomorrow");
  recognition.words("late words");
  expect(changes).toHaveLength(2);
});

test("cancel retains displayed words and fences late results", () => {
  const recognition = new Recognition();
  const changes: string[] = [];
  const owner = createBrowserDictation({ recognition, text: "Keep this", selection: { start: 9, end: 9 },
    language: "en-US", onText: text => changes.push(text), onState: () => {}, onError: () => {} });
  owner.start();
  recognition.words("captured words");
  owner.cancel();
  recognition.words("late words");
  recognition.onend?.();
  expect(changes).toEqual(["Keep this captured words"]);
  expect(recognition.aborted).toBe(1);
});

test("model setup remains cancellable and download failures explain recovery", () => {
  const recognition = new Recognition();
  const statuses: string[] = [];
  const errors: string[] = [];
  const owner = createBrowserDictation({ recognition, text: "Draft", selection: { start: 5, end: 5 }, language: "en-US",
    onText: () => {}, onState: () => {}, onStatus: status => statuses.push(status), onError: error => errors.push(error) });
  owner.start();
  recognition.onstatus?.("installing");
  expect(statuses).toEqual(["installing"]);
  recognition.onerror?.({ error: "model-unavailable" });
  expect(errors[0]).toContain("local speech model couldn’t download");
  recognition.onstatus?.("installing");
  expect(statuses).toHaveLength(1);
});

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

test("finish waits for the last correction and returns it once recognition ends", async () => {
  const recognition = new Recognition();
  let text = "";
  const owner = createBrowserDictation({ recognition, text, selection: { start: 0, end: 0 }, language: "en-US",
    onText: value => { text = value }, onState: () => {}, onError: () => {} });
  owner.start();
  recognition.words("Plan the weak");
  let settled = false;
  const finishing = owner.finish().then(value => { settled = true; return value });
  await Promise.resolve();
  expect(settled).toBe(false);
  recognition.words("Plan the week.");
  recognition.onend?.();
  expect(await finishing).toBe("Plan the week.");
  text = "";
  recognition.words("late");
  expect(text).toBe("");
});

test.each(["cancel", "network", "finalization-timeout"])("finish does not authorize submission after %s", async reason => {
  const recognition = new Recognition();
  const owner = createBrowserDictation({ recognition, text: "", selection: { start: 0, end: 0 }, language: "en-US",
    onText: () => {}, onState: () => {}, onError: () => {} });
  owner.start();
  recognition.words("Partial words");
  const finishing = owner.finish();
  if (reason === "cancel") owner.cancel();
  else recognition.onerror?.({ error: reason });
  expect(await finishing).toBeNull();
});

function frames() {
  let now = 0;
  let id = 0;
  const callbacks = new Map<number, (time: number) => void>();
  return {
    now: () => now,
    request(callback: (time: number) => void) { callbacks.set(++id, callback); return id; },
    cancel(key: number) { callbacks.delete(key); },
    pending: () => callbacks.size,
    advance(ms: number) { now += ms; const pending = [...callbacks.values()]; callbacks.clear(); pending.forEach(callback => callback(now)); },
  };
}

function streamedDictation() {
  const recognition = new Recognition();
  const changes: string[] = [];
  const clock = frames();
  const owner = createBrowserDictation({ recognition, text: "", selection: { start: 0, end: 0 }, language: "en-US",
    resultFrames: clock, onText: text => changes.push(text), onState: () => {}, onError: () => {} });
  owner.start();
  recognition.words("Plan");
  return { recognition, changes, clock, owner };
}

test("speech bursts reveal on frames and reach the newest text within 100 ms without a growing queue", () => {
  const { recognition, changes, clock, owner } = streamedDictation();
  recognition.words("Plan the next week and review the changes.");
  expect(changes).toEqual(["Plan"]);
  clock.advance(25);
  expect((changes.at(-1) ?? "").length).toBeGreaterThan(4);
  expect((changes.at(-1) ?? "").length).toBeLessThan(42);
  for (let i = 0; i < 100; i++) recognition.words(`Plan the next week and review all ${i} changes.`);
  expect(clock.pending()).toBe(1);
  clock.advance(75);
  expect(owner.text()).toBe("Plan the next week and review all 99 changes.");
  expect(clock.pending()).toBe(0);
  expect(changes).toHaveLength(3);
  owner.cancel();
});

test("streamed corrections apply immediately and Send flushes all latest words", async () => {
  const { recognition, changes, clock, owner } = streamedDictation();
  recognition.words("Plan the weak");
  clock.advance(100);
  recognition.words("Plan the week.");
  expect(changes.at(-1)).toBe("Plan the week.");
  recognition.words("Plan the week. Include the final word.");
  const finished = owner.finish();
  recognition.onend?.();
  expect(await finished).toBe("Plan the week. Include the final word.");
  expect(owner.text()).toBe("Plan the week. Include the final word.");
  expect(clock.pending()).toBe(0);
});

test("cancel fences queued frames and streaming never splits grapheme clusters", () => {
  const { recognition, clock, owner } = streamedDictation();
  const target = "Plan 👩🏽‍💻 café tomorrow";
  recognition.words(target);
  const validPrefixes = new Set(["Plan", ...Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(target), part => target.slice(0, part.index + part.segment.length))]);
  clock.advance(35);
  expect(validPrefixes.has(owner.text())).toBe(true);
  expect(owner.text()).not.toBe(target);
  expect(clock.pending()).toBe(1);
  const visible = owner.text();
  owner.cancel();
  clock.advance(100);
  recognition.words("late replacement");
  expect(owner.text()).toBe(visible);
  expect(clock.pending()).toBe(0);
});

test("revising words not yet displayed never retracts an already visible prefix", () => {
  const { recognition, clock, owner } = streamedDictation();
  recognition.words("Plan the week and review all of the release notes before Friday.");
  clock.advance(60);
  const visible = owner.text();
  const corrected = visible + " tomorrow.";
  recognition.words(corrected);
  clock.advance(10);
  expect(owner.text().startsWith(visible)).toBe(true);
  clock.advance(30);
  expect(owner.text()).toBe(corrected);
  expect(clock.pending()).toBe(0);
});

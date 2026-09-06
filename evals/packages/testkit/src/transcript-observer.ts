import type { Probe } from "./spec/types.ts";

/** Observe rendered transcript text across frames, including gaps between eventual assertions. */
export async function observeTranscript(probe: Probe, entries: readonly { role: "user" | "assistant"; text: string }[]) {
  const key = `transcript-observer-${crypto.randomUUID()}`;
  await probe.eval(`(key, entriesJson) => {
    const entries = JSON.parse(entriesJson);
    const state = { frames: 0, seen: entries.map(() => false), violations: [], stopped: false };
    let frame;
    const started = performance.now();
    const sample = () => {
      state.frames++;
      entries.forEach((entry, index) => {
        const nodes = [...document.querySelectorAll('[data-message-role="' + entry.role + '"]')]
          .filter(node => node.getClientRects().length && getComputedStyle(node).visibility !== "hidden");
        const count = nodes.reduce((sum, node) => sum + ((node.innerText ?? "").split(entry.text).length - 1), 0);
        if (count > 0) state.seen[index] = true;
        if (state.seen[index] && count !== 1 && state.violations.length < 30)
          state.violations.push({ index, count, atMs: Math.round(performance.now() - started) });
      });
      frame = requestAnimationFrame(sample);
    };
    frame = requestAnimationFrame(sample);
    const timer = setTimeout(() => { cancelAnimationFrame(frame); state.stopped = true; }, 180000);
    window[key] = { state, stop() { clearTimeout(timer); cancelAnimationFrame(frame); } };
  }`, { args: [key, JSON.stringify(entries)] });
  return {
    read() {
      return probe.eval(`(key) => {
        const observer = window[key];
        if (!observer) throw new Error("Transcript observer was lost before verification");
        return observer.state;
      }`, { args: [key] });
    },
    async finish() {
      const result = await probe.eval(`(key) => {
        const observer = window[key];
        if (!observer) throw new Error("Transcript observer was lost before verification");
        observer.stop(); delete window[key]; return observer.state;
      }`, { args: [key] });
      return result;
    },
    async [Symbol.asyncDispose]() {
      await probe.eval(`(key) => { window[key]?.stop(); delete window[key]; }`, { args: [key] });
    },
  };
}

/** Read visible messages in display order without depending on engine payloads. */
export async function readTranscriptMessages(probe: Probe, role: "user" | "assistant" | "system"): Promise<string[]> {
  const result = await probe.eval(`(role) => [...document.querySelectorAll('[data-message-role="' + role + '"]')]
    .filter(node => node.getClientRects().length && getComputedStyle(node).visibility !== "hidden")
    .map(node => node.innerText ?? "")`, { args: [role] });
  if (!Array.isArray(result) || !result.every((text): text is string => typeof text === "string")) {
    throw new Error("Rendered transcript was unavailable");
  }
  return result;
}

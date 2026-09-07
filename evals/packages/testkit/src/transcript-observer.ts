import { browserScript } from "@openwork/cdp";
import type { Probe } from "./spec/types.ts";

/** Observe rendered transcript text across frames, including gaps between eventual assertions. */
export async function observeTranscript(probe: Probe, entries: readonly { role: "user" | "assistant"; text: string }[]) {
  const key: `transcript-observer-${string}` = `transcript-observer-${crypto.randomUUID()}`;
  await probe.eval(browserScript((key: `transcript-observer-${string}`, entries) => {
    const state: { frames: number; seen: boolean[]; violations: { index: number; count: number; atMs: number }[]; stopped: boolean } = { frames: 0, seen: entries.map(() => false), violations: [], stopped: false };
    let frame = 0;
    const started = performance.now();
    const sample = () => {
      state.frames++;
      entries.forEach((entry, index) => {
        const nodes = [...document.querySelectorAll<HTMLElement>('[data-message-role="' + entry.role + '"]')]
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
  }, [key, entries]));
  return {
    read() {
      return probe.eval(browserScript((key: `transcript-observer-${string}`) => {
        const observer = window[key];
        if (!observer) throw new Error("Transcript observer was lost before verification");
        return observer.state;
      }, [key]));
    },
    async finish() {
      const result = await probe.eval(browserScript((key: `transcript-observer-${string}`) => {
        const observer = window[key];
        if (!observer) throw new Error("Transcript observer was lost before verification");
        observer.stop(); delete window[key]; return observer.state;
      }, [key]));
      return result;
    },
    async [Symbol.asyncDispose]() {
      await probe.eval(browserScript((key: `transcript-observer-${string}`) => { window[key]?.stop(); delete window[key]; }, [key]));
    },
  };
}

/** Read visible messages in display order without depending on engine payloads. */
export async function readTranscriptMessages(probe: Probe, role: "user" | "assistant" | "system"): Promise<string[]> {
  const result = await probe.eval(browserScript((role) => [...document.querySelectorAll<HTMLElement>('[data-message-role="' + role + '"]')]
    .filter(node => node.getClientRects().length && getComputedStyle(node).visibility !== "hidden")
    .map(node => node.innerText ?? ""), [role]));
  if (!Array.isArray(result) || !result.every((text): text is string => typeof text === "string")) {
    throw new Error("Rendered transcript was unavailable");
  }
  return result;
}

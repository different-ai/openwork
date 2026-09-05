import type { Probe } from "./spec/types.ts";

/** Observe rendered transcript text across frames, including gaps between eventual assertions. */
export async function observeTranscript(probe: Probe, entries: readonly { role: "user" | "assistant"; text: string }[]) {
  const key = `transcript-observer-${crypto.randomUUID()}`;
  await probe.eval(`(() => {
    const entries = ${JSON.stringify(entries)};
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
    window[${JSON.stringify(key)}] = { state, stop() { clearTimeout(timer); cancelAnimationFrame(frame); } };
  })()`);
  return {
    async finish() {
      const result = await probe.eval(`(() => {
        const observer = window[${JSON.stringify(key)}];
        if (!observer) throw new Error("Transcript observer was lost before verification");
        observer.stop(); delete window[${JSON.stringify(key)}]; return observer.state;
      })()`);
      return result;
    },
    async [Symbol.asyncDispose]() {
      await probe.eval(`(() => { window[${JSON.stringify(key)}]?.stop(); delete window[${JSON.stringify(key)}]; })()`);
    },
  };
}

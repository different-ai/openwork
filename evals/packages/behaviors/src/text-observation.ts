import { callFunctionOnSurface } from "@openwork/cdp";
import type { Surface } from "@openwork/cdp";

/** Record changes, including empty frames, without modifying the renderer's fetch or event handlers. */
export async function observeText(surface: Surface, selector: string, options: { ignoreExistingMessages?: boolean } = {}) {
  const key: `text-observation-${string}` = `text-observation-${crypto.randomUUID()}`;
  await callFunctionOnSurface(surface, (key: `text-observation-${string}`, selector, ignoreExisting) => {
    const previous = new Set(ignoreExisting ? [...document.querySelectorAll<HTMLElement>(selector)].map(node => node.closest('[data-message-id]')?.getAttribute('data-message-id')) : []);
    const state: { samples: string[]; frames: number; expired: boolean; overflow: boolean } = { samples: [], frames: 0, expired: false, overflow: false };
    let frame = 0;
    const sample = () => {
      const text = [...document.querySelectorAll<HTMLElement>(selector)]
        .filter(node => node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden')
        .filter(node => !previous.has(node.closest('[data-message-id]')?.getAttribute('data-message-id')))
        .map(node => (node.innerText ?? node.textContent ?? '').trim()).join('\n');
      state.frames++;
      if (state.samples.at(-1) !== text) {
        if (state.samples.length < 2048) state.samples.push(text);
        else state.overflow = true;
      }
      frame = requestAnimationFrame(sample);
    };
    sample();
    const timer = setTimeout(() => { cancelAnimationFrame(frame); state.expired = true; }, 180000);
    window[key] = { state, stop() { clearTimeout(timer); cancelAnimationFrame(frame); } };
  }, [key, selector, options.ignoreExistingMessages === true]);
  return {
    async finish(): Promise<string[]> {
      const value = await callFunctionOnSurface(surface, (key: `text-observation-${string}`) => {
        const observer = window[key];
        if (!observer) throw new Error('Text observation was lost');
        observer.stop(); delete window[key]; return observer.state;
      }, [key]);
      if (!value || typeof value !== "object" || !("samples" in value) || !Array.isArray(value.samples)
        || !value.samples.every((item): item is string => typeof item === "string")
        || !("frames" in value) || typeof value.frames !== "number" || value.frames < 2
        || !("expired" in value) || value.expired !== false || !("overflow" in value) || value.overflow !== false)
        throw new Error("Text observation was incomplete or malformed");
      return value.samples;
    },
    async [Symbol.asyncDispose]() {
      await callFunctionOnSurface(surface, (key: `text-observation-${string}`) => { window[key]?.stop(); delete window[key]; }, [key]);
    },
  };
}

/** Once text appears, every subsequent frame must extend it toward the independent expected answer. */
export function textProgressFailures(samples: readonly string[], expected: string): string[] {
  const failures: string[] = [];
  let previous = "";
  for (const text of samples) {
    if (!expected.startsWith(text)) failures.push(`Unexpected answer: ${JSON.stringify(text)}`);
    if (!text.startsWith(previous)) failures.push(`Text disappeared or shrank: ${JSON.stringify(previous)} -> ${JSON.stringify(text)}`);
    previous = text;
  }
  if (!expected || previous !== expected) failures.push("The complete expected answer was not observed");
  return failures;
}

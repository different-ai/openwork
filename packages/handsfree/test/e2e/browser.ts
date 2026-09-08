import { evaluate } from "../../../../evals/packages/cdp/src/cdp.ts";
import type { CdpClient } from "../../../../evals/packages/cdp/src/cdp.ts";

declare global {
  interface Window {
    __events: Array<{ t: number } & ({ type: "click"; id: string } | { type: "check"; checked: boolean })>;
  }
}

/** Independent, type-checked browser observations for the computer-use benchmark. */
export function groundTruth(client: CdpClient) {
  return {
    resetEvents: () => evaluate(client, () => { window.__events = []; }),
    eventCount: () => evaluate(client, () => window.__events.length),
    lastClickedId: () => evaluate(client, () => {
      const event = window.__events.at(-1);
      return event?.type === "click" ? event.id : undefined;
    }),
    resetField: () => evaluate(client, () => {
      const field = document.querySelector<HTMLInputElement>("#field");
      if (!field) throw new Error("Benchmark field is missing");
      field.value = "";
      field.focus();
    }),
    fieldValue: () => evaluate(client, () => {
      const field = document.querySelector<HTMLInputElement>("#field");
      if (!field) throw new Error("Benchmark field is missing");
      return field.value;
    }),
    focusField: () => evaluate(client, () => {
      const field = document.querySelector<HTMLInputElement>("#field");
      if (!field) throw new Error("Benchmark field is missing");
      field.focus();
    }),
  };
}

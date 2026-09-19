import { afterAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { QueuedComposerItem } from "../src/react-app/domains/session/surface/composer-state-store";
import { QueuedMessagesPanel } from "../src/react-app/domains/session/modals/queued-messages-panel";

const registeredDom = typeof globalThis.document === "undefined";
if (registeredDom) GlobalRegistrator.register({ url: "http://localhost/" });
afterAll(async () => {
  if (registeredDom) await GlobalRegistrator.unregister();
});

test.each(["initial", "first", "second"])("queued Send now stays clickable while %s is sending", async (sendingId) => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const items: QueuedComposerItem[] = ["first", "second"].map((id) => ({
    id, draft: { mode: "prompt", text: id, parts: [{ type: "text", text: id }], attachments: [] },
  }));
  const onSendNow = mock((_id: string) => {});
  const render = () => root.render(<QueuedMessagesPanel items={items} sending sendingId={sendingId}
    onSendNow={onSendNow} onRemove={() => {}} onEdit={() => {}} onReorder={() => {}} />);
  try {
    await act(async () => render());
    for (const item of items) {
      const row = container.querySelector(`[data-queued-item-id="${item.id}"]`);
      const button = row?.querySelector<HTMLButtonElement>('button[aria-label="Send now"], button[aria-label="Sending..."]');
      expect(button).not.toBeNull();
      expect(button?.disabled).toBe(false);
      await act(async () => { button?.click(); button?.click(); });
      expect(onSendNow.mock.calls.filter(([id]) => id === item.id)).toHaveLength(2);
      expect(row?.querySelector('[role="status"]')?.textContent ?? null).toBe(item.id === sendingId ? "Sending..." : null);
    }
    const first = items[0];
    if (!first) throw new Error("Expected the first queued item");
    items[0] = { ...first, steer: { owner: "owner", generation: 0, agent: null, order: 1 } };
    await act(async () => render());
    expect(container.querySelector('[data-queued-item-id="first"] [role="status"]')?.textContent).toBe(sendingId === "first" ? "Sending..." : "Send requested");
    expect(container.querySelector<HTMLButtonElement>('[data-queued-item-id="first"] button[aria-label="Send now"], [data-queued-item-id="first"] button[aria-label="Sending..."]')?.disabled).toBe(false);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

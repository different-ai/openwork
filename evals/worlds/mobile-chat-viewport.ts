import { browserScript, evalIn } from "@openwork/testkit";
import type { Surface } from "@openwork/cdp";

/** Simulates keyboard viewport geometry only; this is not a native iOS keyboard. */
export async function simulateKeyboardViewport(app: Surface, height: number, top: number) {
  await evalIn(app, browserScript((height, top) => {
    const viewport = window.visualViewport;
    if (!viewport) throw new Error("VisualViewport unavailable");
    Object.defineProperties(viewport, {
      height: { configurable: true, get: () => height },
      offsetTop: { configurable: true, get: () => top },
      scale: { configurable: true, get: () => 1 },
    });
    viewport.dispatchEvent(new Event("resize"));
    viewport.dispatchEvent(new Event("scroll"));
  }, [height, top]));
}

export async function mobileChatGeometry(app: Surface) {
  return evalIn(app, () => {
    const rect = (element: Element | null) => {
      const bounds = element?.getBoundingClientRect();
      return bounds ? { top: bounds.top, bottom: bounds.bottom, left: bounds.left, right: bounds.right, height: bounds.height, width: bounds.width } : null;
    };
    const visible = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)].find((node) => node.getClientRects().length > 0) ?? null;
    const editor = visible('[contenteditable="true"]');
    const thread = visible("[data-thread-scroll]");
    const users = [...(thread?.querySelectorAll('[data-message-role="user"]') ?? [])];
    const latest = users.at(-1) ?? null;
    const toolbar = visible("[data-composer-toolbar]");
    return {
      shell: rect(visible("[data-chat-viewport]")),
      editor: rect(editor), toolbar: rect(toolbar), send: rect(visible('button[aria-label="Run task"], button[aria-label="Stop"]')),
      thread: rect(thread), latestUser: rect(latest), scrollTop: thread?.scrollTop ?? 0,
      pageScroll: document.scrollingElement?.scrollTop ?? 0,
      viewport: { height: window.visualViewport?.height ?? 0, top: window.visualViewport?.offsetTop ?? 0 },
      editorFontSize: editor ? parseFloat(getComputedStyle(editor).fontSize) : 0,
      editorFocused: editor === document.activeElement,
      userCount: users.length,
      greetingVisible: Boolean(visible("[data-empty-greeting]")),
      suggestionsVisible: Boolean(visible("[data-empty-suggestions]")),
      headerTitleVisible: Boolean(visible("[data-session-header-title]")),
      headerWorkspaceVisible: Boolean(visible("[data-session-header-workspace]")),
      headerVisible: Boolean(visible("[data-session-header]")),
      navigation: rect(visible("[data-mobile-chat-navigation]")),
      navigationCount: [...document.querySelectorAll('[data-session-pane] [data-sidebar="trigger"]')].filter((node) => node.getClientRects().length > 0).length,
      overflowVisible: Boolean(visible('[data-session-pane] button[aria-label="More actions"]')),
    };
  });
}

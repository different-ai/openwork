import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { coworkerBridge, type BrowserCommand, type BrowserSnapshot, type BrowserThumbnail } from "@/lib/bridge";

/** Presentation observes one native discussion. Unmounting or hiding the workspace
 * detaches presentation, not the work or its human-only handoff. */
export function useDiscussionBrowser(slug: string, threadId: string, active: boolean) {
  const [snapshot, setSnapshot] = useState<BrowserSnapshot | null>(null);
  const [image, setImage] = useState<BrowserThumbnail | null>(null);
  const [viewId, setViewId] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [readError, setReadError] = useState("");
  const [actionError, setActionError] = useState("");
  const [busy, setBusy] = useState(false);
  const [visible, setVisible] = useState(!document.hidden);
  const [now, setNow] = useState(Date.now());
  const binding = useRef("");
  const changing = useRef(false);
  const tab = snapshot?.tabs.find((item) => item.id === snapshot.activeTabId);
  const handoff = snapshot?.control.state === "human" ? snapshot.control : null;
  const mode = snapshot?.presentation.mode ?? "hidden";
  const expanded = mode === "side" || mode === "fullscreen";
  const captureSize = expanded ? "watch" : "thumbnail";
  const accept = (next: BrowserSnapshot) => setSnapshot((prior) => prior && prior.revision >= next.revision ? prior : next);
  const bindingLost = (cause: unknown) => cause instanceof Error && cause.message === "This browser panel is no longer selected.";
  const releasePresentation = () => {
    // Drop only the stale renderer presentation. Native work and paused access
    // keep their original owner; reconnecting must never imply Resume.
    binding.current = ""; changing.current = false;
    setViewId(""); setSnapshot(null); setImage(null); setBusy(false);
    setReadError("Browser view disconnected. Reopen Browser to reconnect; your work has not been resumed.");
  };

  useLayoutEffect(() => {
    setSnapshot(null); setImage(null); setViewId(""); setReadError(""); setActionError("");
    changing.current = false; setBusy(false);
    if (!active) return;
    const id = crypto.randomUUID();
    binding.current = id;
    let disposed = false;
    let reading = false;
    let timer = 0;
    const visibility = () => setVisible(!document.hidden);
    visibility();
    document.addEventListener("visibilitychange", visibility);
    void coworkerBridge.browser.bind(slug, threadId, id).then((next) => {
      if (disposed) return;
      setViewId(id); accept(next);
      timer = window.setInterval(() => {
        if (reading || changing.current || binding.current !== id) return;
        reading = true;
        void coworkerBridge.browser.read(id).then((value) => {
          if (!disposed && binding.current === id && !changing.current) { accept(value); setReadError(""); }
        }).catch((cause: unknown) => {
          if (!disposed && binding.current === id) {
            if (bindingLost(cause)) { window.clearInterval(timer); releasePresentation(); }
            else { setImage(null); setReadError(cause instanceof Error ? cause.message : String(cause)); }
          }
        }).finally(() => { reading = false; });
      }, 500);
    }).catch((cause: unknown) => { if (!disposed) setReadError(cause instanceof Error ? cause.message : String(cause)); });
    return () => {
      disposed = true; binding.current = ""; window.clearInterval(timer);
      document.removeEventListener("visibilitychange", visibility);
      void coworkerBridge.browser.detach(id).catch(() => undefined);
    };
  }, [slug, threadId, active, attempt]);

  useEffect(() => {
    setImage(null);
    if (!active || !visible || !viewId || !tab || tab.status !== "ready" || handoff || mode === "hidden" || readError) return;
    let disposed = false;
    let timer = 0;
    // Completion-driven polling gives backpressure even on slow or stalled capture.
    const capture = async () => {
      try {
        const next = await coworkerBridge.browser.thumbnail(viewId, tab.id, captureSize);
        if (!disposed) { setImage(next); setNow(Date.now()); }
      } catch { if (!disposed) setImage(null); }
      finally { if (!disposed) timer = window.setTimeout(() => void capture(), captureSize === "watch" ? 350 : 3_000); }
    };
    void capture();
    const clock = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => { disposed = true; window.clearTimeout(timer); window.clearInterval(clock); };
  }, [active, visible, viewId, tab?.id, tab?.url, tab?.status, Boolean(handoff), mode === "hidden", captureSize, readError]);

  async function command(input: BrowserCommand) {
    if (!viewId || changing.current || !active) return;
    const id = viewId;
    changing.current = true; setBusy(true); setActionError("");
    if (input.action === "takeover" || input.action === "present") setImage(null);
    try {
      const next = await coworkerBridge.browser.command(id, input);
      if (binding.current === id) accept(next);
    } catch (cause) {
      if (binding.current === id) {
        if (bindingLost(cause)) releasePresentation();
        else setActionError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      if (binding.current === id) { changing.current = false; setBusy(false); }
    }
  }

  return { snapshot, tab, handoff, mode, expanded, image: handoff || !visible || readError ? null : image, imageAge: image ? Math.max(0, now - image.capturedAt) : null, viewId, busy, error: actionError || readError, readError, command, retry: () => setAttempt((value) => value + 1) };
}

/** Own modal is not an occluder; its nested dialogs and menus still are. The
 * native broker enforces watch-only vs human input independently of this effect. */
export function useBrowserViewport(viewId: string, viewport: HTMLDivElement | null, expanded: boolean, active: boolean, tabId: string | undefined, humanPhase: string | undefined, mode: string) {
  useLayoutEffect(() => {
    if (!viewport || !viewId || !expanded || !active) return;
    let frame = 0;
    let last = "";
    let disposed = false;
    const update = () => {
      frame = 0;
      const rect = viewport.getBoundingClientRect();
      const ownModal = viewport.closest('[data-testid="coworker-browser-modal"]');
      const overlay = [...document.querySelectorAll('dialog[open], [role="dialog"], [role="alertdialog"], [role="menu"], [role="tooltip"], [data-testid="context-panel"][data-overlay="true"]')]
        .some((node) => node !== ownModal && node.getClientRects().length > 0 && node.getAttribute("aria-hidden") !== "true");
      const hidden = document.hidden || overlay || rect.width < 1 || rect.height < 1;
      const input: BrowserCommand = hidden ? { action: "hide" } : { action: "bounds", bounds: { x: Math.max(0, rect.x), y: Math.max(0, rect.y), width: Math.max(0, Math.min(rect.right, window.innerWidth) - Math.max(0, rect.x)), height: Math.max(0, Math.min(rect.bottom, window.innerHeight) - Math.max(0, rect.y)) } };
      const key = JSON.stringify(input);
      if (key === last) return;
      last = key;
      void coworkerBridge.browser.command(viewId, input).catch(() => { if (!disposed) last = ""; });
    };
    const schedule = () => { if (!frame) frame = window.requestAnimationFrame(update); };
    const resize = new ResizeObserver(schedule);
    resize.observe(viewport);
    const mutations = new MutationObserver(schedule);
    mutations.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["class", "style", "open", "aria-hidden", "data-active"] });
    window.addEventListener("resize", schedule);
    document.addEventListener("scroll", schedule, true);
    document.addEventListener("visibilitychange", schedule);
    schedule();
    return () => {
      disposed = true; window.cancelAnimationFrame(frame); resize.disconnect(); mutations.disconnect();
      window.removeEventListener("resize", schedule); document.removeEventListener("scroll", schedule, true); document.removeEventListener("visibilitychange", schedule);
      void coworkerBridge.browser.command(viewId, { action: "hide" }).catch(() => undefined);
    };
  }, [viewId, viewport, expanded, active, tabId, humanPhase, mode]);
}

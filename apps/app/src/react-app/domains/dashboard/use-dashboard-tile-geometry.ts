import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  readDashboardTileGeometry,
  writeDashboardTileGeometry,
  type DashboardTileGeometry,
} from "./dashboard-tile-geometry";

type TileSize = { contentWidth: number; outerHeight: number; reserved: boolean };

function visibleStyle(node: HTMLDivElement): CSSStyleDeclaration | null {
  if (!node.isConnected || document.hidden) return null;
  const style = getComputedStyle(node);
  return style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" ? null : style;
}

function readSize(node: HTMLDivElement, entry?: ResizeObserverEntry): TileSize | null {
  const style = visibleStyle(node);
  if (!style) return null;
  const horizontal = [style.paddingLeft, style.paddingRight, style.borderLeftWidth, style.borderRightWidth]
    .reduce((sum, value) => sum + (parseFloat(value) || 0), 0);
  const vertical = [style.paddingTop, style.paddingBottom, style.borderTopWidth, style.borderBottomWidth]
    .reduce((sum, value) => sum + (parseFloat(value) || 0), 0);
  const rect = entry?.contentRect ?? node.getBoundingClientRect();
  const contentWidth = Math.round(rect.width - (entry ? 0 : horizontal));
  const outerHeight = entry ? entry.borderBoxSize[0]?.blockSize ?? rect.height + vertical : rect.height;
  const minimum = parseFloat(style.minHeight) || 0;
  const reserved = minimum > 0 && outerHeight <= minimum + (style.boxSizing === "border-box" ? 0 : vertical);
  return Number.isFinite(contentWidth) && contentWidth > 0 && contentWidth <= 10_000
    && Number.isFinite(outerHeight) && outerHeight > 0 && outerHeight <= 10_000
    ? { contentWidth, outerHeight, reserved } : null;
}

function sameGeometry(left: DashboardTileGeometry | null, right: DashboardTileGeometry | null): boolean {
  return left?.contentWidth === right?.contentWidth
    && left?.frameHeight === right?.frameHeight
    && left?.outerHeight === right?.outerHeight;
}

export function useDashboardTileGeometry(scopeKey: string, entryId: string, workspaceId: string) {
  const ref = useRef<HTMLDivElement>(null);
  const identity = useMemo(() => ({
    scopeKey,
    entryId,
    workspaceId,
    estimate: scopeKey.trim() && entryId.trim() && workspaceId.trim()
      ? readDashboardTileGeometry(scopeKey, entryId, workspaceId) : null,
  }), [scopeKey, entryId, workspaceId]);
  const [snapshot, setSnapshot] = useState(() => ({ identity, geometry: identity.estimate }));
  const recorder = useRef<{ identity: typeof identity; record: (height: number) => void } | null>(null);
  const geometry = snapshot.identity === identity ? snapshot.geometry : identity.estimate;

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || !scopeKey.trim() || !entryId.trim() || !workspaceId.trim()) return;
    let disposed = false;
    let frame: number | null = null;
    let contentWidth: number | null = null;
    let reported: { contentWidth: number; frameHeight: number } | null = null;
    let written: DashboardTileGeometry | null = null;
    let pendingSize: TileSize | null = null;
    let needsRead = false;
    const publish = (next: DashboardTileGeometry | null) => {
      setSnapshot((previous) => previous.identity === identity && sameGeometry(previous.geometry, next)
        ? previous : { identity, geometry: next });
    };
    const checkWidth = (width: number) => {
      if (contentWidth === width) return;
      contentWidth = width;
      if (reported?.contentWidth !== width) reported = null;
      publish(readDashboardTileGeometry(scopeKey, entryId, workspaceId, width) ?? written ?? identity.estimate);
    };
    const flush = () => {
      frame = null;
      const measurement = reported;
      if (disposed) return;
      const size = needsRead ? readSize(node) : visibleStyle(node) ? pendingSize : null;
      pendingSize = null;
      needsRead = false;
      if (!size) { reported = null; return; }
      checkWidth(size.contentWidth);
      if (!measurement || measurement.contentWidth !== size.contentWidth || size.outerHeight < measurement.frameHeight) {
        reported = null;
        return;
      }
      if (size.reserved) return;
      reported = null;
      const next = { contentWidth: size.contentWidth, outerHeight: size.outerHeight, workspaceId, frameHeight: measurement.frameHeight, measuredAt: Date.now() };
      if (sameGeometry(written, next)) return;
      written = next;
      publish(next);
      writeDashboardTileGeometry(scopeKey, entryId, next);
    };
    const schedule = () => { frame ??= requestAnimationFrame(flush); };
    const initialSize = readSize(node);
    if (initialSize) checkWidth(initialSize.contentWidth);
    recorder.current = {
      identity,
      record: (height) => {
        if (disposed || !Number.isFinite(height) || height <= 0) return;
        const size = readSize(node);
        if (!size) return;
        checkWidth(size.contentWidth);
        reported = { contentWidth: size.contentWidth, frameHeight: Math.min(800, Math.max(1, Math.ceil(height))) };
        needsRead = true;
        schedule();
      },
    };
    const observer = new ResizeObserver((entries) => {
      if (disposed) return;
      const entry = entries.find((entry) => entry.target === node);
      if (!entry) return;
      const size = readSize(node, entry);
      if (!size) { reported = null; pendingSize = null; return; }
      pendingSize = size;
      schedule();
    });
    observer.observe(node);
    return () => {
      disposed = true;
      observer.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
      if (recorder.current?.identity === identity) recorder.current = null;
    };
  }, [identity, scopeKey, entryId, workspaceId]);

  const recordHeight = useCallback((height: number) => {
    if (recorder.current?.identity === identity) recorder.current.record(height);
  }, [identity]);
  return { ref, initialHeight: geometry?.frameHeight, reservedHeight: geometry?.outerHeight, recordHeight };
}

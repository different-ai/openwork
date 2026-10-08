export type BrowserBounds = { x: number; y: number; width: number; height: number };

function validRect(rect: DOMRect) {
  return [rect.left, rect.top, rect.right, rect.bottom, rect.width, rect.height].every(Number.isFinite)
    && rect.width >= 0 && rect.height >= 0;
}

// A native WebContentsView is not a DOM child: CSS overflow/visibility cannot
// clip it. Only give it the visible rectangle owned by this mounted container.
export function computeBrowserBounds(el: HTMLElement): BrowserBounds | null {
  const win = el.ownerDocument.defaultView;
  if (!el.isConnected || !win || ![win.innerWidth, win.innerHeight].every(Number.isFinite)
    || win.innerWidth <= 0 || win.innerHeight <= 0) return null;
  const rect = el.getBoundingClientRect();
  if (!validRect(rect)) return null;
  let left = Math.max(0, rect.left);
  let top = Math.max(0, rect.top);
  let right = Math.min(win.innerWidth, rect.right);
  let bottom = Math.min(win.innerHeight, rect.bottom);

  for (let node: HTMLElement | null = el; node; node = node.parentElement) {
    const style = win.getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return null;
    if (style.display === "contents") {
      if (node === el) return null;
      continue;
    }
    if (style.opacity === "0" || style.contentVisibility === "hidden") return null;
    const paintClip = style.contentVisibility === "auto" || /\b(paint|strict|content)\b/.test(style.contain);
    const clipX = paintClip || /^(hidden|clip|scroll|auto|overlay)$/.test(style.overflowX);
    const clipY = paintClip || /^(hidden|clip|scroll|auto|overlay)$/.test(style.overflowY);
    if (node === el || (!clipX && !clipY)) continue;
    const parent = node.getBoundingClientRect();
    if (!validRect(parent)
      || (clipX && ![node.offsetWidth, node.clientLeft, node.clientWidth].every(value => Number.isFinite(value) && value >= 0))
      || (clipY && ![node.offsetHeight, node.clientTop, node.clientHeight].every(value => Number.isFinite(value) && value >= 0))) return null;
    // Client bounds exclude borders/scrollbars; the ratios account for CSS
    // scaling. Electron zoom is applied later, exactly once, by the host.
    const scaleX = node.offsetWidth > 0 ? parent.width / node.offsetWidth : 1;
    const scaleY = node.offsetHeight > 0 ? parent.height / node.offsetHeight : 1;
    if (clipX) {
      const x = parent.left + node.clientLeft * scaleX;
      left = Math.max(left, x);
      right = Math.min(right, x + node.clientWidth * scaleX);
    }
    if (clipY) {
      const y = parent.top + node.clientTop * scaleY;
      top = Math.max(top, y);
      bottom = Math.min(bottom, y + node.clientHeight * scaleY);
    }
  }
  if (![left, top, right, bottom].every(Number.isFinite) || right <= left || bottom <= top) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

type BrowserBoundsBridge = {
  show?: (bounds: BrowserBounds, sessionId: string) => Promise<boolean | void>;
  setBounds?: (bounds: BrowserBounds) => Promise<boolean | void>;
  hide?: () => Promise<void>;
};

type Geometry = { bounds: BrowserBounds; pixelRatio: number };

export function createBrowserBoundsSync(
  browser: BrowserBoundsBridge,
  sessionId: string,
  onError: (error: unknown) => void,
) {
  let disposed = false;
  let shown = false;
  let visibleIntent = false;
  let showInFlight: Geometry | null = null;
  let lastGeometry: Geometry | null = null;
  let failedShow: Geometry | null = null;

  function sameGeometry(geometry: Geometry | null, bounds: BrowserBounds, pixelRatio: number) {
    return geometry !== null && geometry.pixelRatio === pixelRatio
      && geometry.bounds.x === bounds.x && geometry.bounds.y === bounds.y
      && geometry.bounds.width === bounds.width && geometry.bounds.height === bounds.height;
  }

  async function send(geometry: Geometry, show: boolean) {
    if (show) showInFlight = geometry;
    try {
      const accepted = await (show
        ? browser.show?.(geometry.bounds, sessionId)
        : browser.setBounds?.(geometry.bounds));
      if (disposed || lastGeometry !== geometry) return;
      if (accepted === false) {
        lastGeometry = null;
        if (show) failedShow = geometry;
      } else if (show) {
        shown = true;
        failedShow = null;
      }
    } catch (error) {
      if (disposed || lastGeometry !== geometry) return;
      lastGeometry = null;
      if (show) {
        failedShow = geometry;
        onError(error);
      }
    } finally {
      if (show) showInFlight = null;
    }
  }

  return {
    sync(bounds: BrowserBounds | null, pixelRatio: number, occluded: boolean) {
      if (disposed) return;
      if (!bounds || ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)
        || bounds.width < 1 || bounds.height < 1 || occluded
        || (showInFlight && visibleIntent && !sameGeometry(showInFlight, bounds, pixelRatio))) {
        if (visibleIntent) void browser.hide?.();
        visibleIntent = false;
        shown = false;
        lastGeometry = null;
        failedShow = null;
        return;
      }
      // DPR is only a zoom-change hint for fast local dedup, never a scale factor.
      // Preload still stamps the actual webFrame zoom alongside the CSS bounds.
      if (showInFlight || sameGeometry(lastGeometry, bounds, pixelRatio)
        || (!shown && sameGeometry(failedShow, bounds, pixelRatio))) return;
      const geometry = { bounds, pixelRatio };
      lastGeometry = geometry;
      visibleIntent = true;
      void send(geometry, !shown);
    },
    invalidate() {
      lastGeometry = null;
      failedShow = null;
    },
    dispose() {
      disposed = true;
      lastGeometry = null;
      void browser.hide?.();
    },
  };
}

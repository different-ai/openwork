export type BrowserBounds = { x: number; y: number; width: number; height: number };

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
  let showInFlight = false;
  let lastGeometry: Geometry | null = null;
  let failedShow: Geometry | null = null;

  function sameGeometry(geometry: Geometry | null, bounds: BrowserBounds, pixelRatio: number) {
    return geometry !== null && geometry.pixelRatio === pixelRatio
      && geometry.bounds.x === bounds.x && geometry.bounds.y === bounds.y
      && geometry.bounds.width === bounds.width && geometry.bounds.height === bounds.height;
  }

  async function send(geometry: Geometry, show: boolean) {
    if (show) showInFlight = true;
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
      if (show) showInFlight = false;
    }
  }

  return {
    sync(bounds: BrowserBounds, pixelRatio: number, occluded: boolean) {
      if (disposed) return;
      if (bounds.width < 1 || bounds.height < 1 || occluded) {
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

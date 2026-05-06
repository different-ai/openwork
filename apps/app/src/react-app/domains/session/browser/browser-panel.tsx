/** @jsxImportSource react */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Globe,
  Loader2,
  RotateCw,
  X,
} from "lucide-react";
import { isElectronRuntime } from "../../../../app/utils";

type BrowserState = {
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  isLoading: boolean;
};

type BrowserPanelProps = {
  onClose: () => void;
};

const EMPTY_STATE: BrowserState = {
  url: "",
  title: "",
  canGoBack: false,
  canGoForward: false,
  isLoading: false,
};

function getElectronBrowser() {
  if (!isElectronRuntime()) return null;
  return (window as Window).__OPENWORK_ELECTRON__?.browser ?? null;
}

export function BrowserPanel({ onClose }: BrowserPanelProps) {
  const [state, setState] = useState<BrowserState>(EMPTY_STATE);
  const [urlInput, setUrlInput] = useState("");
  const [urlFocused, setUrlFocused] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const urlInputRef = useRef<HTMLInputElement>(null);

  // Subscribe to state changes from the main process
  useEffect(() => {
    const browser = getElectronBrowser();
    if (!browser) return;

    const unsub = browser.onStateChange((newState: BrowserState) => {
      setState(newState);
      if (!urlFocused) {
        setUrlInput(newState.url);
      }
    });

    // Get initial state
    browser.getState().then((initial: BrowserState | null) => {
      if (initial) {
        setState(initial);
        setUrlInput(initial.url);
      }
    });

    return unsub;
  }, [urlFocused]);

  // Show the browser view when the panel mounts, hide on unmount.
  // Also update bounds when the panel resizes.
  useEffect(() => {
    const browser = getElectronBrowser();
    if (!browser || !panelRef.current) return;

    const updateBounds = () => {
      if (!panelRef.current) return;
      const rect = panelRef.current.getBoundingClientRect();
      // The toolbar is ~44px, leave space at top for it
      const toolbarHeight = 44;
      const bounds = {
        x: Math.round(rect.x),
        y: Math.round(rect.y + toolbarHeight),
        width: Math.round(rect.width),
        height: Math.round(rect.height - toolbarHeight),
      };
      browser.setBounds(bounds);
    };

    // Show with initial bounds
    const rect = panelRef.current.getBoundingClientRect();
    const toolbarHeight = 44;
    browser.show({
      x: Math.round(rect.x),
      y: Math.round(rect.y + toolbarHeight),
      width: Math.round(rect.width),
      height: Math.round(rect.height - toolbarHeight),
    });

    // Observe resize
    const observer = new ResizeObserver(updateBounds);
    observer.observe(panelRef.current);

    // Also update on window resize
    window.addEventListener("resize", updateBounds);

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updateBounds);
      browser.hide();
    };
  }, []);

  const navigate = useCallback(
    (url?: string) => {
      const browser = getElectronBrowser();
      if (!browser) return;
      browser.navigate(url ?? urlInput);
    },
    [urlInput],
  );

  const handleUrlKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        navigate();
        urlInputRef.current?.blur();
      }
    },
    [navigate],
  );

  const browser = getElectronBrowser();

  if (!isElectronRuntime() || !browser) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-center text-dls-secondary">
        <p className="text-sm">Browser panel is only available in the desktop app.</p>
      </div>
    );
  }

  return (
    <div ref={panelRef} className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="flex h-[44px] shrink-0 items-center gap-1 border-b border-dls-border px-2">
        {/* Navigation buttons */}
        <button
          type="button"
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text disabled:opacity-40"
          onClick={() => browser.back()}
          disabled={!state.canGoBack}
          title="Back"
          aria-label="Go back"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <button
          type="button"
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text disabled:opacity-40"
          onClick={() => browser.forward()}
          disabled={!state.canGoForward}
          title="Forward"
          aria-label="Go forward"
        >
          <ArrowRight className="h-4 w-4" />
        </button>
        <button
          type="button"
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text"
          onClick={() => browser.reload()}
          title="Reload"
          aria-label="Reload page"
        >
          {state.isLoading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <RotateCw className="h-4 w-4" />
          )}
        </button>

        {/* URL bar */}
        <div className="relative mx-1 flex min-w-0 flex-1 items-center">
          <Globe className="absolute left-2 h-3.5 w-3.5 text-dls-secondary" />
          <input
            ref={urlInputRef}
            type="text"
            className="h-7 w-full rounded-md border border-dls-border bg-dls-background-secondary pl-7 pr-2 text-[12px] text-dls-text placeholder:text-dls-secondary focus:border-dls-accent focus:outline-none"
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            onKeyDown={handleUrlKeyDown}
            onFocus={() => {
              setUrlFocused(true);
              urlInputRef.current?.select();
            }}
            onBlur={() => setUrlFocused(false)}
            placeholder="Enter URL..."
            spellCheck={false}
            autoComplete="off"
          />
        </div>

        {/* Close button */}
        <button
          type="button"
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text"
          onClick={onClose}
          title="Close browser"
          aria-label="Close browser panel"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* WebContentsView renders in this area (managed by Electron main process) */}
      <div className="min-h-0 flex-1" />
    </div>
  );
}

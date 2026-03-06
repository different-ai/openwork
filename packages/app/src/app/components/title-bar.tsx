import { createEffect, createSignal, onCleanup, Show } from "solid-js";
import { isTauriRuntime } from "../utils";
import {
  windowMinimize,
  windowClose,
  windowToggleMaximize,
  windowIsMaximized,
} from "../lib/tauri";

type TitleBarProps = {
  title?: string;
};

export default function TitleBar(props: TitleBarProps) {
  const isTauri = isTauriRuntime();

  const [isMaximized, setIsMaximized] = createSignal(false);

  // On mount: remove native title bar via JS API + poll maximized state
  createEffect(() => {
    if (!isTauri) return;

    const init = async () => {
      try {
        // setDecorations(false) is the most reliable way to hide native titlebar on Windows
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const win = getCurrentWindow();
        await win.setDecorations(false);

        // Initial maximized state
        setIsMaximized(await windowIsMaximized());

        // Poll every second to keep the maximize/restore icon accurate
        const interval = window.setInterval(async () => {
          try {
            setIsMaximized(await windowIsMaximized());
          } catch { /* ignore */ }
        }, 1000);

        onCleanup(() => window.clearInterval(interval));
      } catch { /* ignore — non-Tauri context */ }
    };

    void init();
  });

  // Use our custom Rust commands (registered in lib.rs) for window controls
  const handleClose = () => {
    windowClose().catch(() => {});
  };

  const handleMinimize = () => {
    windowMinimize().catch(() => {});
  };

  const handleMaximize = async () => {
    try {
      await windowToggleMaximize();
      setIsMaximized(await windowIsMaximized());
    } catch { /* ignore */ }
  };

  return (
    <Show when={isTauri}>
      {/* data-tauri-drag-region enables native window drag on this element */}
      <div
        id="title-bar"
        class="title-bar"
        data-tauri-drag-region
        onDblClick={handleMaximize}
      >
        {/* Window control buttons */}
        <div class="title-bar-controls">
          {/* Minimize — yellow */}
          <button
            id="title-bar-minimize"
            type="button"
            class="traffic-btn traffic-minimize"
            title="Minimize"
            aria-label="Minimize window"
            onClick={handleMinimize}
          >
            <svg class="traffic-icon" viewBox="0 0 10 10" fill="none">
              <path d="M2 5H8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            </svg>
          </button>

          {/* Maximize / Restore — green */}
          <button
            id="title-bar-maximize"
            type="button"
            class="traffic-btn traffic-maximize"
            title={isMaximized() ? "Restore" : "Maximize"}
            aria-label={isMaximized() ? "Restore window" : "Maximize window"}
            onClick={handleMaximize}
          >
            <Show
              when={isMaximized()}
              fallback={
                <svg class="traffic-icon" viewBox="0 0 10 10" fill="none">
                  <path d="M2 6.5V8H3.5M8 3.5V2H6.5M3.5 8H2V6.5M6.5 2H8V3.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
              }
            >
              <svg class="traffic-icon" viewBox="0 0 10 10" fill="none">
                <path d="M3 7V3.5H6.5M7 3H3.5V6.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </Show>
          </button>

          {/* Close — red */}
          <button
            id="title-bar-close"
            type="button"
            class="traffic-btn traffic-close"
            title="Close"
            aria-label="Close window"
            onClick={handleClose}
          >
            <svg class="traffic-icon" viewBox="0 0 10 10" fill="none">
              <path d="M2.5 2.5L7.5 7.5M7.5 2.5L2.5 7.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            </svg>
          </button>
        </div>

        {/* Centered title */}
        <div class="title-bar-title" data-tauri-drag-region>
          <span data-tauri-drag-region>{props.title ?? "OpenWork"}</span>
        </div>

        {/* Right spacer to balance the layout */}
        <div class="title-bar-spacer" data-tauri-drag-region />
      </div>
    </Show>
  );
}

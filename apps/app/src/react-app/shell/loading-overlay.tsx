/** @jsxImportSource react */
import { useBootState, useBootOverlayVisible } from "./boot-state";

/**
 * Quiet, flat boot overlay. Follows the design language rule "structure before
 * effects": no card, no border, no shadow, no glass. Just the canvas, a small
 * typographic beat, and a minimal progress indicator. Fades out once boot +
 * route-first-load are both ready.
 */
export function LoadingOverlay() {
  const visible = useBootOverlayVisible();
  const { phase, message, detail, error } = useBootState();

  if (!visible) return null;

  const fading = phase === "ready";

  return (
    <div
      className={`pointer-events-auto fixed inset-0 z-[1000] flex items-center justify-center bg-dls-canvas transition-opacity duration-[160ms] ${
        fading ? "opacity-0" : "opacity-100"
      }`}
      aria-live="polite"
      aria-busy={!fading}
      role="status"
    >
      <div className="flex w-full max-w-[380px] flex-col items-center gap-5 px-6 text-center">
        <ProgressGlyph />
        <div className="flex flex-col gap-1.5">
          <div className="text-[13px] font-medium leading-5 text-dls-text">
            {message || "Loading OpenWork"}
          </div>
          <div className="text-[12px] leading-5 text-dls-secondary">
            {detail ?? defaultDetailForPhase(message)}
          </div>
        </div>
        {error ? (
          <div className="text-[12px] leading-5 text-red-11">{error}</div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Minimal progress indicator: a short horizontal hairline that slides across
 * a track. No icons, no bordered frames — just motion and rhythm consistent
 * with the rest of OpenWork's surfaces.
 */
function ProgressGlyph() {
  return (
    <div className="relative h-px w-28 overflow-hidden bg-[rgba(var(--dls-secondary-rgb,120,120,120),0.18)]">
      <div className="absolute inset-y-0 left-0 w-10 animate-[ow-bootslide_1.2s_ease-in-out_infinite] bg-[rgba(var(--dls-accent-rgb),0.85)]" />
      <style>{`
        @keyframes ow-bootslide {
          0%   { transform: translateX(-100%); }
          50%  { transform: translateX(180%); }
          100% { transform: translateX(360%); }
        }
      `}</style>
    </div>
  );
}

function defaultDetailForPhase(message: string): string {
  if (!message) return "One moment";
  return "";
}

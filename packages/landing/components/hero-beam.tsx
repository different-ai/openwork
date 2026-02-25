"use client";

import React, { forwardRef, useRef } from "react";
import { cn } from "@/lib/utils";
import { AnimatedBeam } from "@/components/magicui/animated-beam";

const Circle = forwardRef<
  HTMLDivElement,
  { className?: string; children?: React.ReactNode }
>(({ className, children }, ref) => {
  return (
    <div
      ref={ref}
      className={cn(
        "z-10 flex size-12 items-center justify-center rounded-full border-2 bg-white p-3 shadow-[0_0_20px_-12px_rgba(0,0,0,0.8)]",
        className,
      )}
    >
      {children}
    </div>
  );
});

Circle.displayName = "Circle";

export function HeroBeam() {
  const containerRef = useRef<HTMLDivElement>(null);

  // Left side refs (inputs)
  const userRef = useRef<HTMLDivElement>(null);
  const docsRef = useRef<HTMLDivElement>(null);
  const browserRef = useRef<HTMLDivElement>(null);

  // Center ref
  const aikaRef = useRef<HTMLDivElement>(null);

  // Right side refs (outputs)
  const claudeRef = useRef<HTMLDivElement>(null);
  const openaiRef = useRef<HTMLDivElement>(null);
  const ollamaRef = useRef<HTMLDivElement>(null);

  return (
    <div className="w-full rounded-2xl border border-gray-100 bg-white p-6 shadow-2xl ring-1 ring-black/5 sm:p-10">
      {/* Tagline */}
      <p className="mb-8 text-center text-[14px] font-medium leading-relaxed text-gray-500 sm:text-[15px]">
        AikaOS conecta todas tus herramientas con inteligencia artificial.
        <br className="hidden sm:block" />
        Sé productivo hoy y estate a la vanguardia de la tecnología de los
        próximos 5-10 años.
      </p>

      <div
        ref={containerRef}
        className="relative flex h-[300px] w-full items-center justify-center overflow-hidden py-6 sm:py-10"
      >
        <div className="flex size-full max-h-[200px] max-w-lg flex-col items-stretch justify-between gap-10">
          {/* Top row */}
          <div className="flex flex-row items-center justify-between">
            <Circle ref={userRef} className="border-gray-200">
              <Icons.user />
            </Circle>
            <Circle ref={claudeRef}>
              <Icons.anthropic />
            </Circle>
          </div>

          {/* Middle row */}
          <div className="flex flex-row items-center justify-between">
            <Circle ref={docsRef}>
              <Icons.docs />
            </Circle>
            <Circle
              ref={aikaRef}
              className="size-16 border-aika-teal bg-teal-50 shadow-[0_0_30px_-8px_rgba(0,200,180,0.4)]"
            >
              <span className="text-[15px] font-bold text-aika-teal">
                {">_"}
              </span>
            </Circle>
            <Circle ref={openaiRef}>
              <Icons.openai />
            </Circle>
          </div>

          {/* Bottom row */}
          <div className="flex flex-row items-center justify-between">
            <Circle ref={browserRef}>
              <Icons.browser />
            </Circle>
            <Circle ref={ollamaRef}>
              <Icons.ollama />
            </Circle>
          </div>
        </div>

        {/* Beams: left side -> AikaOS */}
        <AnimatedBeam
          containerRef={containerRef}
          fromRef={userRef}
          toRef={aikaRef}
          curvature={-75}
          endYOffset={-10}
          duration={3}
          gradientStartColor="#6b7280"
          gradientStopColor="#00C8B4"
        />
        <AnimatedBeam
          containerRef={containerRef}
          fromRef={docsRef}
          toRef={aikaRef}
          duration={3}
          gradientStartColor="#f59e0b"
          gradientStopColor="#00C8B4"
        />
        <AnimatedBeam
          containerRef={containerRef}
          fromRef={browserRef}
          toRef={aikaRef}
          curvature={75}
          endYOffset={10}
          duration={3}
          gradientStartColor="#3b82f6"
          gradientStopColor="#00C8B4"
        />

        {/* Beams: AikaOS -> right side */}
        <AnimatedBeam
          containerRef={containerRef}
          fromRef={claudeRef}
          toRef={aikaRef}
          curvature={-75}
          endYOffset={-10}
          reverse
          duration={3}
          gradientStartColor="#00C8B4"
          gradientStopColor="#9c40ff"
        />
        <AnimatedBeam
          containerRef={containerRef}
          fromRef={openaiRef}
          toRef={aikaRef}
          reverse
          duration={3}
          gradientStartColor="#00C8B4"
          gradientStopColor="#10a37f"
        />
        <AnimatedBeam
          containerRef={containerRef}
          fromRef={ollamaRef}
          toRef={aikaRef}
          curvature={75}
          endYOffset={10}
          reverse
          duration={3}
          gradientStartColor="#00C8B4"
          gradientStopColor="#333333"
        />
      </div>

      {/* Labels */}
      <div className="mt-2 flex flex-row items-center justify-between text-[11px] text-gray-400">
        <div className="flex flex-col items-center gap-1">
          <span>Tú</span>
          <span>Documentos</span>
          <span>Navegador</span>
        </div>
        <span className="text-[11px] font-bold text-aika-teal">AikaOS</span>
        <div className="flex flex-col items-center gap-1">
          <span>Claude</span>
          <span>GPT-4</span>
          <span>Ollama</span>
        </div>
      </div>
    </div>
  );
}

/* ── Icons ── */
const Icons = {
  user: () => (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  ),
  anthropic: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="#191919">
      <path d="M17.304 3.541h-3.483l6.15 16.918h3.483l-6.15-16.918Zm-10.608 0L.546 20.459H4.15l1.262-3.474h6.47l1.263 3.474h3.604L10.6 3.541H6.696Zm.533 10.64 2.118-5.828 2.118 5.828H7.229Z" />
    </svg>
  ),
  openai: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="#191919">
      <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" />
    </svg>
  ),
  ollama: () => (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="#191919"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="10" r="6" />
      <circle cx="10" cy="9" r="1" fill="#191919" stroke="none" />
      <circle cx="14" cy="9" r="1" fill="#191919" stroke="none" />
      <path d="M10 12c0 1 .9 1.5 2 1.5s2-.5 2-1.5" />
      <path d="M8 18c0 2 1.8 3 4 3s4-1 4-3" />
    </svg>
  ),
  docs: () => (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="#f59e0b"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="16" y1="13" x2="8" y2="13" />
      <line x1="16" y1="17" x2="8" y2="17" />
    </svg>
  ),
  browser: () => (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="#3b82f6"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="10" />
      <line x1="2" y1="12" x2="22" y2="12" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </svg>
  ),
};

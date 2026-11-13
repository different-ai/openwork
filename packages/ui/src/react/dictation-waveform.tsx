"use client"

import { useEffect, useRef, useState } from "react"

// Two offset crests make a quiet, recognizable signal at composer size.
const heights = [3, 5, 9, 17, 22, 14, 7, 4, 8, 15, 20, 11, 5, 3]
export const dictationMeterSamples = 24

/** Host levels render a microphone meter. Without them, text changes drive a
 * dictation-mode indicator; the browser/OS owns the microphone state. */
export function DictationWaveform({ text, levels, preparing = false, className }: { text: string; levels?: readonly number[]; preparing?: boolean; className?: string }) {
  const previous = useRef(text)
  const [active, setActive] = useState(false)
  useEffect(() => {
    if (previous.current === text) return
    previous.current = text
    setActive(true)
    const timer = setTimeout(() => setActive(false), 450)
    return () => clearTimeout(timer)
  }, [text])

  if (levels) return <span role="img" aria-label={preparing ? "Starting dictation" : "Microphone level"}
    data-dictation-waveform data-dictation-preparing={preparing || undefined} className={className}>
    <svg viewBox="0 0 240 32" preserveAspectRatio="none" width="100%" height="100%" aria-hidden="true">
      {Array.from({ length: dictationMeterSamples }, (_, index) => {
        const level = levels[index - (dictationMeterSamples - levels.length)] ?? 0
        const height = 2 + Math.max(0, Math.min(1, level)) * 28
        return <rect key={index} x={3 + index * 10} y="2" width="3" height="28" rx="1.5" fill="currentColor"
          style={{ transformBox: "fill-box", transformOrigin: "center", transform: `scaleY(${height / 28})`,
            animationDelay: preparing ? `${-index * 45}ms` : undefined }} />
      })}
    </svg>
  </span>

  return <span role="img" aria-label="Dictation mode" title="Dictation mode. Your system controls the microphone."
    data-dictation-waveform data-text-active={active} className={className}>
    <svg viewBox="0 0 72 24" width="100%" height="100%" aria-hidden="true">
      {heights.map((height, index) => <rect key={index} x={2 + index * 5} y={12 - height / 2} width="2" height={height} rx="1"
        fill="currentColor" style={{ transformBox: "fill-box", transformOrigin: "center", transform: `scaleY(${active ? 1 : 0.55})` }} />)}
    </svg>
  </span>
}

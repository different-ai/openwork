"use client"

import { useEffect, useRef, useState } from "react"

// Two offset crests make a quiet, recognizable signal at composer size.
const heights = [3, 5, 9, 17, 22, 14, 7, 4, 8, 15, 20, 11, 5, 3]

/** A dictation-mode indicator, not a microphone meter. It responds only to
 * changes in the editable draft; the OS does not expose its listening state. */
export function DictationWaveform({ text, className }: { text: string; className?: string }) {
  const previous = useRef(text)
  const [active, setActive] = useState(false)
  useEffect(() => {
    if (previous.current === text) return
    previous.current = text
    setActive(true)
    const timer = setTimeout(() => setActive(false), 450)
    return () => clearTimeout(timer)
  }, [text])

  return <span role="img" aria-label="Dictation mode" title="Dictation mode. Your system controls the microphone."
    data-dictation-waveform data-text-active={active} className={className}>
    <svg viewBox="0 0 72 24" width="100%" height="100%" aria-hidden="true">
      {heights.map((height, index) => <rect key={index} x={2 + index * 5} y={12 - height / 2} width="2" height={height} rx="1"
        fill="currentColor" style={{ transformBox: "fill-box", transformOrigin: "center", transform: `scaleY(${active ? 1 : 0.55})` }} />)}
    </svg>
  </span>
}

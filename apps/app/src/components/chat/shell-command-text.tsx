"use client"

import { useEffect, useState } from "react"
import { codeToHtml } from "shiki"

/**
 * One-line shell command with real syntax highlighting instead of
 * monochrome blue. Highlighting is async (Shiki), so the plain command
 * renders first and upgrades in place; results are cached so repeated
 * commands and re-renders never flash.
 */
const highlightCache = new Map<string, string>()

type ShellCommandTextProps = {
  command: string
  className?: string
}

export function ShellCommandText({ command, className }: ShellCommandTextProps) {
  const [html, setHtml] = useState<string | null>(() => highlightCache.get(command) ?? null)

  useEffect(() => {
    const cached = highlightCache.get(command)
    if (cached !== undefined) {
      setHtml(cached)
      return
    }
    let cancelled = false
    codeToHtml(command, {
      lang: "shellscript",
      structure: "inline",
      themes: { light: "github-light", dark: "github-dark" },
    })
      .then((highlighted) => {
        highlightCache.set(command, highlighted)
        if (!cancelled) setHtml(highlighted)
      })
      .catch(() => {
        // Highlighting is progressive enhancement; the plain text stays.
      })
    return () => {
      cancelled = true
    }
  }, [command])

  if (html === null) {
    return <code className={className}>{command}</code>
  }

  return (
    <code
      className={className}
      data-shell-command-highlighted=""
      // Shiki escapes the command text; only its own span markup is injected.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

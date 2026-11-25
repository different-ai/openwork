"use client"

import { useEffect, useState } from "react"
import { codeToHtml } from "shiki"

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
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

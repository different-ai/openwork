"use client"

import { Tool } from "@/components/ui/tool"
import type { TodoWriteToolPart } from "@/lib/build-in-tools"

interface TodoWriteToolProps {
  part: TodoWriteToolPart
}

function getTodoWriteToolTitle(part: TodoWriteToolPart): string | null {
  const count = part.input.todos.length

  if (part.state === "output-error") {
    return "Update todo list attempted"
  }

  if (part.state !== "output-available") {
    return null
  }

  return count > 0 ? `Update todo list (${count})` : "Update todo list"
}

export function TodoWriteTool({ part }: TodoWriteToolProps) {
  return (
    <Tool toolPart={part} title={getTodoWriteToolTitle(part) ?? "todowrite"} />
  )
}

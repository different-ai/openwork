import { useEffect } from "react"

import { desktopBridge } from "@/app/lib/desktop"
import { useDesktopFeature } from "./use-desktop-feature"

/**
 * Reports the `agentQuestions` feature to the desktop, once per window and on
 * every route: the engine offers agents a question that does not stop their
 * work only while it is on.
 */
export function AgentQuestionsBridge() {
  const enabled = useDesktopFeature("agentQuestions")
  useEffect(() => {
    void desktopBridge.agentQuestionsSetEnabled(enabled).catch(() => {})
  }, [enabled])
  return null
}

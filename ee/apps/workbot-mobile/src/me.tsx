import type { WorkbotMe } from "@openwork-ee/workbot-client"
import { createContext, useContext } from "react"

export const MeContext = createContext<WorkbotMe | null>(null)

/** Who is signed in and what is on for them; screens inside the signed-in app only. */
export function useMe(): WorkbotMe {
  const me = useContext(MeContext)
  if (!me) throw new Error("useMe needs the signed-in layout.")
  return me
}

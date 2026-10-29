import { createRoot } from "react-dom/client"
import { ComputerControl } from "../src/react-app/domains/session/computer/computer-control"
import { FloatingSlotProvider, SessionFloatingLayer } from "../src/react-app/domains/session/panel/floating-slot"
import { TooltipProvider } from "../src/components/ui/tooltip"
import "../src/app/index.css"

// The isolated world serves the real broker and adapter behind this IPC boundary.
async function invoke(command: string, ...args: unknown[]) {
  const input = command === "computerPresentation" ? { visible: args[1] } : args[0]
  const route = command === "computerPresentation" ? "presentation" : command === "computerInteract" ? "decision" : command === "computerSnapshot" ? "snapshot" : "stop"
  const response = await fetch(`/fixture/${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) })
  if (!response.ok) throw new Error("Computer control was not confirmed")
  const result: unknown = await response.json()
  if (command === "computerHalt") output.textContent = "Current work stopped"
  return result
}
Reflect.set(window, "__OPENWORK_ELECTRON__", { invokeDesktop: invoke })
const output = document.createElement("output")
output.setAttribute("role", "status")
output.textContent = "Computer use enabled"
document.body.append(output)
const root = document.createElement("div")
document.body.append(root)
createRoot(root).render(<TooltipProvider><FloatingSlotProvider><main style={{ position: "relative", width: "min(800px,100vw)", height: 600 }}><ComputerControl sessionId="fixture-chat" /><SessionFloatingLayer /></main></FloatingSlotProvider></TooltipProvider>)

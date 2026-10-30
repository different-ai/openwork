import { useState } from "react"
import { createRoot } from "react-dom/client"
import { MessageList } from "../src/components/chat/message-list"
import { MessageListProvider } from "../src/components/chat/message-list-provider"
import { useComputerSessionHistoryStore } from "../src/components/chat/computer-session-history-store"
import { Button } from "../src/components/ui/button"
import { TooltipProvider } from "../src/components/ui/tooltip"
import { PlatformProvider, createDefaultPlatform } from "../src/react-app/kernel/platform"
import { computerHistoryMessages } from "./computer-session-history-data"
import "../src/app/index.css"

// Deterministic raster captures: no desktop, external service, or recording.
function capture(stage: number): string {
  const canvas = document.createElement("canvas")
  canvas.width = 640; canvas.height = 380
  const ctx = canvas.getContext("2d")
  if (!ctx) throw new Error("The fixture needs a canvas")
  ctx.fillStyle = "#f8f7f3"; ctx.fillRect(0, 0, 640, 380)
  ctx.fillStyle = "#e9e8e4"; ctx.fillRect(0, 0, 640, 34)
  ctx.fillStyle = "#5e6266"; ctx.font = "13px sans-serif"; ctx.fillText("Landscape — drawing canvas", 18, 22)
  ctx.lineWidth = 4; ctx.lineCap = "round"; ctx.strokeStyle = "#343e42"
  ctx.beginPath(); ctx.moveTo(145, 270); ctx.quadraticCurveTo(310, -20, 468, 270); ctx.stroke()
  ctx.strokeStyle = "#b96e42"; ctx.beginPath(); ctx.arc(310, 145, 22, 0, Math.PI * 2); ctx.stroke()
  ctx.strokeStyle = "#4c829d"; ctx.beginPath(); ctx.moveTo(90, 250); ctx.bezierCurveTo(270, 170, 370, 320, 555, 230); ctx.stroke()
  ctx.beginPath(); ctx.moveTo(165, 304); ctx.bezierCurveTo(270, 220, 340, 330, 450, 285); ctx.stroke()
  ctx.strokeStyle = "#b96e42"
  if (stage > 0) { ctx.beginPath(); ctx.moveTo(100, 150); ctx.lineTo(120, 140); ctx.lineTo(130, 156); ctx.lineTo(146, 130); ctx.lineTo(158, 146); ctx.stroke() }
  if (stage > 1) { ctx.beginPath(); ctx.moveTo(435, 139); ctx.lineTo(452, 130); ctx.lineTo(470, 143); ctx.lineTo(493, 139); ctx.lineTo(508, 151); ctx.stroke() }
  return canvas.toDataURL("image/png")
}

const messages = computerHistoryMessages([capture(0), capture(1), capture(2)])

function Fixture() {
  const [enabled, setEnabled] = useState(false)
  return <PlatformProvider value={createDefaultPlatform()}><TooltipProvider>
    <main className="mx-auto max-w-3xl space-y-6 p-4 text-foreground">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-3">
        <span className="text-sm font-medium">Computer session history preview</span>
        <Button variant="outline" size="sm" aria-pressed={enabled} onClick={() => {
          useComputerSessionHistoryStore.getState().setEnabled(!enabled)
          setEnabled(!enabled)
        }}>Group computer history</Button>
      </div>
      <MessageListProvider workspaceId="fixture-workspace" sessionId="fixture-session"
        showThinking={false} developerMode={false} displaySuggestions={false} providerConnectedCount={0}
        dispatchAction={() => {}} setPrompt={() => {}} onRevertToUserMessage={() => {}} onEditUserMessage={() => {}}
        onMcpReconnect={async () => { throw new Error("This fixture has no connections") }} onMcpReopenAuthorization={async () => {}}
      ><MessageList messages={messages} status="ready" activityStatus="idle" /></MessageListProvider>
    </main>
  </TooltipProvider></PlatformProvider>
}

const root = document.getElementById("root")
if (!root) throw new Error("Fixture root missing")
createRoot(root).render(<Fixture />)

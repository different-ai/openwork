import type { DynamicToolUIPart, UIMessage } from "ai"
import { withToolAttachmentOwner } from "../src/react-app/domains/session/sync/parse-tool-parts"

export function computerHistoryMessages(images: string[]): UIMessage[] {
  const call = (id: string, name: string, intent: string, time: number): DynamicToolUIPart => ({
    type: "dynamic-tool", toolName: name, toolCallId: id, state: "output-available",
    input: { intent }, output: '{"ok":true}',
    callProviderMetadata: { openwork: { toolStartedAt: 1000 + time, toolCompletedAt: 2000 + time } },
  })
  const view = (image: string, id: string) => withToolAttachmentOwner([{ type: "file", mediaType: "image/png", url: image }], id)
  return [
    { id: "request", role: "user", parts: [{ type: "text", text: "Draw an abstract landscape." }] },
    { id: "start", role: "assistant", parts: [{ type: "text", text: "I’ll draw directly on the canvas." }] },
    { id: "drawing", role: "assistant", parts: [
      call("open", "computer_open", "Opened the canvas", 0),
      call("landscape", "computer_act", "Drew the landscape", 1000), ...view(images[0]!, "landscape"),
      { type: "text", text: "I’m adding the clouds." },
      call("cloud", "computer_act", "Added the first cloud", 2000), ...view(images[1]!, "cloud"),
    ] },
    { id: "finish", role: "assistant", parts: [
      call("clouds", "computer_act", "Added the second cloud", 3000), ...view(images[2]!, "clouds"),
      { type: "text", text: "The drawing is open. It hasn’t been saved yet." },
    ] },
  ]
}

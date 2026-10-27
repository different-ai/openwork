export const nativeProtocols = [
  { providerID: "ipr_managednative", npm: "@ai-sdk/openai-compatible", modelID: "gwm_live", protocol: "openai" },
  { providerID: "ipr_managedanthropic", npm: "@ai-sdk/anthropic", modelID: "gwm_anthropic", protocol: "anthropic" },
  { providerID: "ipr_managedgoogle", npm: "@ai-sdk/google", modelID: "gwm_google", protocol: "google" },
];

export function nativeProtocolResponse(protocol: string, model: string, text: string): string {
  if (protocol === "anthropic") {
    const event = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    return event("message_start", { type: "message_start", message: { id: "msg_native_fixture", type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } })
      + event("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })
      + event("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })
      + event("content_block_stop", { type: "content_block_stop", index: 0 })
      + event("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } })
      + event("message_stop", { type: "message_stop" });
  }
  if (protocol === "google") return `data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP", index: 0 }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 }, modelVersion: model })}\n\n`;
  const frame = (delta: unknown, finish: string | null) => `data: ${JSON.stringify({ id: "chatcmpl_native_fixture", object: "chat.completion.chunk", model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  return frame({ role: "assistant", content: text }, null) + frame({}, "stop") + "data: [DONE]\n\n";
}

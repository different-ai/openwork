import { createServer } from "node:http";
import type { MockMcpTool } from "./mock-mcp.ts";

/** Mirror the public discovery/execute boundary, including an allocated connection
 * namespace and a tool name requiring bracket notation. No real cloud account. */
export const voiceCapabilityTools: MockMcpTool[] = [
  { name: "search_capabilities", description: "Discover connected tools and computer task capabilities.",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    result: { content: [{ type: "text", text: JSON.stringify({ items: [
      { name: "mcp:voice-notes:list-notes", scriptPath: 'tools.project_notes_2["list-notes"]' },
      { name: "remote-session:create" },
    ] }) }] } },
  { name: "execute_capability_script", description: "Run a script using exact discovered connection paths.",
    inputSchema: { type: "object", properties: { code: { type: "string" } }, required: ["code"] },
    result: { content: [{ type: "text", text: JSON.stringify({ ok: true, value: { notes: ["Project brief", "Release checklist"] } }) }] } },
  { name: "execute_capability", description: "Start a task on the selected computer.",
    inputSchema: { type: "object", properties: { name: { type: "string" }, body: { type: "object", properties: { target: { type: "string" }, prompt: { type: "string" } }, required: ["target", "prompt"] } }, required: ["name", "body"] },
    result: { content: [{ type: "text", text: JSON.stringify({ state: "queued", commandId: "voice-task-witness" }) }] } },
];

/** Deterministic model witness; execution still goes through the real engine's bash tool. */
export async function voiceTaskProvider() {
  const requests: { user: string; model: unknown; tools: string[] }[] = [];
  const discoveredPath = (value: unknown): string | undefined => {
    if (typeof value === "string") { try { return discoveredPath(JSON.parse(value)); } catch { return undefined; } }
    if (!value || typeof value !== "object") return undefined;
    if ("scriptPath" in value && typeof value.scriptPath === "string") return value.scriptPath;
    for (const entry of Object.values(value)) { const path = discoveredPath(entry); if (path) return path; }
    return undefined;
  };
  const server = createServer(async (request, response) => {
    response.setHeader("access-control-allow-origin", "*");
    if (request.url === "/__facts") { response.setHeader("content-type", "application/json"); response.end(JSON.stringify(requests)); return; }
    if (request.url === "/v1/models") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ data: [{ id: "voice-task-model", object: "model" }] }));
      return;
    }
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    const messages = body.messages ?? [];
    const lastUser = messages.findLastIndex((m: { role?: string }) => m.role === "user");
    const content = messages[lastUser]?.content;
    const user = typeof content === "string" ? content : Array.isArray(content) ? content.map((p) => p.text ?? "").join("\n") : "";
    const tools: string[] = (body.tools ?? []).map((t: { function?: { name?: string } }) => t.function?.name ?? "");
    const main = tools.length > 0;
    if (main) requests.push({ user, model: body.model, tools });
    const afterUser = messages.slice(lastUser + 1);
    const toolCompleted = afterUser.some((m: { role?: string }) => m.role === "tool");
    const delayed = user.toLowerCase().includes("slow");
    const updated = user.toLowerCase().includes("change");
    const contents = updated ? "updated by follow-up" : "created by spoken request";
    const routed = user.match(/\[The user selected @(cloud|desktop):/);
    const connected = user.includes("connected project notes app");
    const plain = user.includes("person@cloud");
    let text = !main ? "Voice task" : routed ? "The task request is queued. Its completion has not been confirmed." : connected ? "The connected app returned Project brief and Release checklist." : plain ? "That address is ordinary text." : delayed ? "The slow operation finished." : updated ? "The note now contains the updated text." : "The note was created in this workspace.";
    let call: { name: string; arguments: Record<string, unknown> } | undefined;
    const results = afterUser.filter((m: { role?: string }) => m.role === "tool");
    if (main && (routed || connected)) {
      // Discover names from the model's actual tool schemas and result. Voice
      // must not strip a prefix, allocate a namespace, or invent a script path.
      const tool = (suffix: string) => tools.find(name => name === "voice_cloud_" + suffix);
      if (!results.length) {
        const name = tool("search_capabilities");
        if (name) call = { name, arguments: { query: routed ? "remote-session:create" : "project notes" } };
      } else if (results.length === 1) {
        if (routed) {
          const name = tool("execute_capability");
          const prompt = user.replace(/\[The user selected @(?:cloud|desktop):[^\]]*\]/g, "").replace(/@(cloud|desktop)\b/g, "").trim();
          if (name) call = { name, arguments: { name: "remote-session:create", body: { target: routed[1], prompt } } };
        } else {
          const path = discoveredPath(results);
          const name = tool("execute_capability_script");
          if (name && path) call = { name, arguments: { code: `return await ${path}({});` } };
          else text = "The connected capability path was unavailable.";
        }
      }
    } else if (main && !toolCompleted && !plain && tools.includes("bash")) {
      call = { name: "bash", arguments: {
        command: delayed ? "sleep 30; printf 'finished' > voice-slow.txt" : `printf '%s' '${contents}' > voice-note.txt`,
        description: delayed ? "Create the slow note" : "Write the requested note",
      } };
    }
    const delta = call ? { tool_calls: [{ index: 0, id: `call_${requests.length}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] } : { content: text };
    response.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (delta: unknown, finish_reason: string | null) => `data: ${JSON.stringify({ id: `chatcmpl-${requests.length}`, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    response.write(chunk({ role: "assistant" }, null));
    response.write(chunk(delta, null));
    response.write(chunk({}, "tool_calls" in delta ? "tool_calls" : "stop"));
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Voice model witness did not bind");
  return {
    url: `http://127.0.0.1:${address.port}`, requests,
    async [Symbol.asyncDispose]() { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); },
  };
}

/** Installed only in the isolated test renderer. No production injection hook.
 * Real MediaStream/AudioContext lifecycle, synthetic silence, simulated WebRTC
 * signalling/transcription/playback events. Does not verify acoustic or model quality.
 */
export const voiceAudioFixtureSource = String.raw`(() => {
  const peers = [];
  const tracks = [];
  const events = [];
  const originalFetch = window.fetch.bind(window);
  let sequence = 0;
  let deny = false;
  let delayCapture = false;
  let pendingCapture = null;
  let context;
  const media = navigator.mediaDevices;
  const gum = media.getUserMedia.bind(media);
  const enumerate = media.enumerateDevices.bind(media);
  const originalPeer = window.RTCPeerConnection;
  window.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url ?? input.toString();
    if (url === "https://api.openai.com/v1/realtime/calls") return new Response("fixture-answer");
    if (url.endsWith("/voice/realtime/session")) return Response.json({ ok: true, clientSecret: "fixture-ephemeral", model: "fixture-realtime", transcriptionModel: "fixture-transcription", tools: [], expiresAt: null });
    return originalFetch(input, init);
  };
  media.getUserMedia = async () => {
    if (deny) throw new DOMException("Fixture permission denied", "NotAllowedError");
    context ??= new AudioContext();
    const stream = context.createMediaStreamDestination().stream;
    for (const track of stream.getAudioTracks()) {
      track.getSettings = () => ({ echoCancellation: true });
      tracks.push(track);
    }
    if (delayCapture) await new Promise((resolve) => { pendingCapture = resolve; });
    return stream;
  };
  media.enumerateDevices = async () => [{ deviceId: "fixture-mic", kind: "audioinput", label: "Controlled microphone" }];
  class Channel extends EventTarget {
    readyState = "connecting";
    emit(event) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(event) })); }
    send(raw) {
      const event = JSON.parse(raw); events.push(event);
      if (event.type === "session.update") queueMicrotask(() => this.emit({ type: "session.updated", session: event.session }));
      if (event.type === "response.create") {
        const responseId = "response-" + (++sequence);
        this.responseId = responseId;
        this.emit({ type: "response.created", response: { id: responseId } });
        this.emit({ type: "output_audio_buffer.started", response_id: responseId });
        this.emit({ type: "response.output_audio_transcript.delta", response_id: responseId, delta: event.response.input[0].content[0].text });
        this.emit({ type: "response.done", response: { id: responseId, status: "completed" } });
      }
      if (event.type === "response.cancel") this.emit({ type: "response.done", response: { id: this.responseId, status: "cancelled" } });
      if (event.type === "output_audio_buffer.clear") this.emit({ type: "output_audio_buffer.cleared", response_id: this.responseId });
    }
    close() { this.readyState = "closed"; this.dispatchEvent(new Event("close")); }
  }
  window.RTCPeerConnection = class extends EventTarget {
    connectionState = "new";
    channel = new Channel();
    constructor() { super(); peers.push(this); }
    createDataChannel() { return this.channel; }
    addTrack(track) { return { replaceTrack: async (replacement) => { this.track = replacement; } }; }
    createOffer() { return Promise.resolve({ type: "offer", sdp: "fixture-offer" }); }
    setLocalDescription() { return Promise.resolve(); }
    async setRemoteDescription() { this.channel.readyState = "open"; this.channel.dispatchEvent(new Event("open")); this.connectionState = "connected"; }
    close() { this.connectionState = "closed"; }
  };
  const current = () => peers.at(-1)?.channel;
  window.__voiceFixture = {
    say(text, id = "utterance-" + (++sequence), confidence = -0.05, peerIndex = peers.length - 1) {
      const channel = peers[peerIndex].channel;
      channel.emit({ type: "input_audio_buffer.speech_started", item_id: id });
      channel.emit({ type: "input_audio_buffer.speech_stopped", item_id: id });
      channel.emit({ type: "conversation.item.input_audio_transcription.completed", item_id: id, transcript: text, logprobs: [{ logprob: confidence }] });
      return id;
    },
    finish() { current().emit({ type: "output_audio_buffer.stopped", response_id: current().responseId }); },
    disconnect() { current().close(); },
    deny(value) { deny = value; },
    delay(value) { delayCapture = value; },
    release() { pendingCapture?.(); pendingCapture = null; delayCapture = false; },
    fail() { current().emit({ type: "error", error: { message: "fixture provider failure" } }); },
    endTrack() { tracks.at(-1).dispatchEvent(new Event("ended")); },
    malicious() { current().emit({ type: "response.function_call_arguments.done", call_id: "untrusted-call", name: "openwork_execute_action", arguments: JSON.stringify({ actionId: "composer.send" }) }); },
    facts() { return { liveTracks: tracks.filter(t => t.readyState === "live").length, activeTracks: tracks.filter(t => t.readyState === "live" && t.enabled).length, peers: peers.length, events, audioElements: document.querySelectorAll("audio[hidden]").length }; },
  };
  return true;
})()`;

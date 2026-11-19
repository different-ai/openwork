// Fault-injecting OpenAI-compatible provider for reproducing model errors.
// The requested model id picks the behaviour; PORT defaults to 55600.
//   ok | reset | mid-stream-reset | stall | http-429 | http-500 | http-503 | http-401 | http-402
import http from "node:http";

const port = Number(process.env.PORT || 55600);
const log = (...a) => console.log(new Date().toISOString(), ...a);

http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let model = "";
    try { model = JSON.parse(body).model || ""; } catch {}
    log(req.method, req.url, "model=" + model);
    const json = (status, obj, headers = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(obj));
    };
    switch (model) {
      case "reset":
        req.socket.destroy();
        return;
      case "http-429":
        return json(429, { error: { message: "Rate limit exceeded", type: "rate_limit_error" } }, { "retry-after": "5" });
      case "http-500":
        return json(500, { error: { message: "Internal server error", type: "server_error" } });
      case "http-503":
        return json(503, { error: { message: "Service unavailable", type: "overloaded_error" } });
      case "http-401":
        return json(401, { error: { message: "Invalid API key", type: "authentication_error" } });
      case "http-402":
        return json(402, { error: { message: "Insufficient credits", type: "billing_error" } });
      case "stall":
        return; // never respond
      case "mid-stream-reset": {
        res.writeHead(200, { "content-type": "text/event-stream" });
        const chunk = { id: "x", object: "chat.completion.chunk", created: 0, model, choices: [{ index: 0, delta: { role: "assistant", content: "Starting a reply that will be cut " }, finish_reason: null }] };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        setTimeout(() => req.socket.destroy(), 800);
        return;
      }
      default: {
        res.writeHead(200, { "content-type": "text/event-stream" });
        const mk = (delta, finish = null) => ({ id: "x", object: "chat.completion.chunk", created: 0, model, choices: [{ index: 0, delta, finish_reason: finish }] });
        res.write(`data: ${JSON.stringify(mk({ role: "assistant", content: "Fault lab OK." }))}\n\n`);
        res.write(`data: ${JSON.stringify(mk({}, "stop"))}\n\n`);
        res.end("data: [DONE]\n\n");
      }
    }
  });
}).listen(port, "127.0.0.1", () => log("fault server on", port));

import { createServer } from "node:http";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

// This process runs only in the disposable guest. The engine receives its loopback address.
export function createModelRelay({ key, model }, request = fetch) {
  const routes = new Set(["/v1/chat/completions", "/v1/responses"]);
  return createServer(async (req, res) => {
    const stop = (status) => { res.writeHead(status).end(); };
    const port = req.socket.localPort;
    if (req.headers.host !== `127.0.0.1:${port}` || req.headers.origin || req.method !== "POST" || !routes.has(req.url)) return stop(403);
    const abort = new AbortController();
    res.on("close", () => abort.abort());
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 32 * 1024 * 1024) return stop(413);
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks);
      let payload;
      try { payload = JSON.parse(body); } catch { return stop(400); }
      if (payload?.model !== model) return stop(403);
      const upstream = await request(new URL(req.url, "https://ai-gateway.vercel.sh"), {
        method: "POST", redirect: "error", signal: abort.signal, body,
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      });
      if (!upstream.ok || !upstream.body) {
        await upstream.body?.cancel();
        return stop(upstream.status);
      }
      res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json", "cache-control": "no-store" });
      await pipeline(Readable.fromWeb(upstream.body), res);
    } catch {
      if (!res.headersSent && !res.destroyed) stop(502);
      else res.destroy();
    }
  });
}

if (import.meta.main) {
  const input = new URL("./credential", import.meta.url);
  const settings = JSON.parse(await readFile(input, "utf8"));
  await unlink(input);
  const server = createModelRelay(settings);
  server.listen(0, "127.0.0.1", async () => {
    await writeFile(new URL("./port", import.meta.url), String(server.address().port), { mode: 0o600 });
  });
}

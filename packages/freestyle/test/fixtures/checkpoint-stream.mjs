// Synthetic M0 fixture, NOT an OpenWork journey or a model-quality test.
// Two processes keep one loopback HTTP stream alive. Nothing reconstructs state
// after a restart: boot IDs, received chunks and session names exist only in RAM.
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export async function startProducer(port = 19341) {
  const bootId = randomUUID();
  const sessions = Array.from({ length: 10 }, (_, i) => `Session ${i + 1}`);
  let connections = 0;
  let response;
  const server = createServer((req, res) => {
    if (req.url === "/stream") {
      connections++;
      response = res;
      res.writeHead(200, { "content-type": "text/plain" });
      res.write("one\ntwo\nthree\n");
    } else if (req.url === "/continue" && req.method === "POST") {
      if (!response || response.destroyed || response.writableEnded) {
        res.writeHead(409).end();
        return;
      }
      response.end("four\nfive\nsix\n");
      res.end("continued");
    } else if (req.url === "/state") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ bootId, connections, sessions }));
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return server;
}

export async function startConsumer(producerPort = 19341, port = 19342) {
  const bootId = randomUUID();
  let text = "";
  let completed = false;
  let failed = false;
  const abort = new AbortController();
  const server = createServer((req, res) => {
    if (req.url !== "/state") { res.writeHead(404).end(); return; }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ bootId, text, completed, failed }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const stream = (async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${producerPort}/stream`, { signal: abort.signal });
      if (!response.ok || !response.body) throw new Error("Stream unavailable");
      const decoder = new TextDecoder();
      for await (const chunk of response.body) text += decoder.decode(chunk, { stream: true });
      text += decoder.decode();
      completed = true;
    } catch { failed = true; }
  })();
  return { server, async close() { abort.abort(); await stream; server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const command = process.argv[2];
  if (command === "producer") await startProducer();
  else if (command === "consumer") await startConsumer();
  else if (command === "ready") {
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      try { if ((await fetch("http://127.0.0.1:19341/state", { signal: AbortSignal.timeout(1_000) })).ok) { ready = true; break; } } catch { /* startup */ }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!ready) throw new Error("Producer did not start");
  } else if (command === "inspect") {
    const [producer, consumer, disk] = await Promise.all([
      fetch("http://127.0.0.1:19341/state").then((r) => r.json()),
      fetch("http://127.0.0.1:19342/state").then((r) => r.json()),
      readFile("/opt/openwork-checkpoint-probe/disk.txt", "utf8"),
    ]);
    console.log(JSON.stringify({ producer, consumer, disk }));
  } else if (command === "continue") {
    const response = await fetch("http://127.0.0.1:19341/continue", { method: "POST" });
    if (!response.ok) throw new Error("Cannot continue the original stream");
  } else if (command === "mutate") {
    await writeFile("/opt/openwork-checkpoint-probe/disk.txt", "fork-only");
  } else throw new Error("Unknown probe command");
}

/** Real keyboard events over the private noVNC RFB transport (not renderer injection). */
export async function typeThroughWorkshopViewer(viewer: string, text: string): Promise<void> {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(text)) throw new Error("Viewer proof text must be a short non-sensitive ASCII marker.");
  const endpoint = new URL("/websockify", viewer); endpoint.protocol = "wss:";
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(endpoint, ["binary"]); socket.binaryType = "arraybuffer";
    let buffer = new Uint8Array(), stage = "version", count = 0, finished = false;
    const timeout = setTimeout(() => finish(new Error("Interactive private viewer handshake timed out")), 20_000);
    function finish(error?: Error) { if (finished) return; finished = true; clearTimeout(timeout); socket.close(); error ? reject(error) : resolve(); }
    function consume(n: number) { const part = buffer.slice(0, n); buffer = buffer.slice(n); return part; }
    function key(value: number, down: boolean) { const packet = new Uint8Array(8); packet[0] = 4; packet[1] = down ? 1 : 0; new DataView(packet.buffer).setUint32(4, value); socket.send(packet); }
    socket.onerror = () => finish(new Error("Interactive private viewer WebSocket failed"));
    socket.onclose = () => { if (!finished) finish(new Error("Interactive private viewer closed before input proof")); };
    socket.onmessage = (event) => {
      try {
        if (!(event.data instanceof ArrayBuffer)) throw new Error("Unexpected RFB frame encoding");
        const joined = new Uint8Array(buffer.length + event.data.byteLength); joined.set(buffer); joined.set(new Uint8Array(event.data), buffer.length); buffer = joined;
        for (;;) {
          if (stage === "version") {
            if (buffer.length < 12) return;
            const version = new TextDecoder().decode(consume(12)); if (!version.startsWith("RFB 003.")) throw new Error("Invalid RFB version");
            socket.send(new TextEncoder().encode("RFB 003.008\n")); stage = "security-count";
          } else if (stage === "security-count") {
            if (!buffer.length) return; count = consume(1)[0] ?? 0; if (!count) throw new Error("RFB security negotiation refused"); stage = "security-types";
          } else if (stage === "security-types") {
            if (buffer.length < count) return; if (!consume(count).includes(1)) throw new Error("Viewer requires unexpected OS credentials");
            socket.send(new Uint8Array([1])); stage = "security-result";
          } else if (stage === "security-result") {
            if (buffer.length < 4) return; if (new DataView(consume(4).buffer).getUint32(0) !== 0) throw new Error("RFB security failed");
            socket.send(new Uint8Array([1])); stage = "server-init";
          } else if (stage === "server-init") {
            if (buffer.length < 24) return; const length = new DataView(buffer.buffer, buffer.byteOffset).getUint32(20);
            if (buffer.length < 24 + length) return; consume(24 + length);
            // Replace the focused, empty composer draft without sending a model request.
            key(0xffe3, true); key(0x61, true); key(0x61, false); key(0xffe3, false);
            for (const character of text) { const code = character.codePointAt(0); if (code === undefined) continue; key(code, true); key(code, false); }
            stage = "done"; setTimeout(() => finish(), 750); return;
          } else return;
        }
      } catch (error) { finish(error instanceof Error ? error : new Error("Private viewer input proof failed")); }
    };
  });
}

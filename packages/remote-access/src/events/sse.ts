import { BridgeError } from "../contract/index.js";
export interface SSERecord {
  event: string;
  id: string | null;
  data: string;
}
export class SSEParser {
  private decoder = new TextDecoder();
  private buffer = "";
  constructor(private maxBytes = 1024 * 1024) {}
  push(bytes: Uint8Array): SSERecord[] {
    this.buffer = (
      this.buffer + this.decoder.decode(bytes, { stream: true })
    ).replace(/\r\n/g, "\n");
    const records: SSERecord[] = [];
    let i: number;
    while ((i = this.buffer.indexOf("\n\n")) >= 0) {
      const frame = this.buffer.slice(0, i);
      this.buffer = this.buffer.slice(i + 2);
      if (Buffer.byteLength(frame) > this.maxBytes)
        throw new BridgeError("EVENT_TOO_LARGE", 413);
      let event = "message",
        id: string | null = null;
      const data: string[] = [];
      for (const l of frame.split("\n")) {
        const n = l.indexOf(":");
        const field = n < 0 ? l : l.slice(0, n),
          value = n < 0 ? "" : l.slice(n + 1).replace(/^ /, "");
        if (field === "event") event = value;
        else if (field === "id" && !value.includes("\0")) id = value;
        else if (field === "data") data.push(value);
      }
      if (data.length) records.push({ event, id, data: data.join("\n") });
    }
    if (Buffer.byteLength(this.buffer) > this.maxBytes)
      throw new BridgeError("EVENT_TOO_LARGE", 413);
    return records;
  }
}

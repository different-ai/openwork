import { Transform } from "node:stream";
import { StringDecoder } from "node:string_decoder";

// All warm services use these internal virtual origins. Only the authenticated
// edge translates them to a clone's public origins; no process needs restarting.
const templateId = "0".repeat(32);
export const templateOrigins = Object.fromEntries(
  Object.entries({ app: "ow", den: "den", api: "api", engine: "engine", gateway: "gateway" })
    .map(([service, prefix]) => [service, `https://${prefix}-${templateId}.preview.openwork.software`]),
);

export function originReplacements(from, to) {
  if (!from || !to) return [];
  return Object.entries(from).flatMap(([name, origin]) =>
    typeof to[name] === "string" ? [[new URL(origin).hostname, new URL(to[name]).hostname]] : []);
}
export function replaceOrigins(value, pairs) {
  return pairs.reduce((text, [from, to]) => text.replaceAll(from, to), value);
}

// Preserve streaming and UTF-8, including hostnames split across TCP chunks.
export function originTransform(pairs) {
  const decoder = new StringDecoder("utf8");
  const retain = Math.max(1, ...pairs.map(([from]) => from.length));
  let pending = "";
  return new Transform({
    transform(chunk, _encoding, callback) {
      pending += decoder.write(chunk);
      let cut = Math.max(0, pending.length - retain);
      for (const [from] of pairs) {
        const start = pending.lastIndexOf(from, cut - 1);
        if (start >= 0 && start < cut && start + from.length > cut) cut = start;
      }
      if (cut && /[\uD800-\uDBFF]/.test(pending[cut - 1])) cut--;
      this.push(replaceOrigins(pending.slice(0, cut), pairs));
      pending = pending.slice(cut);
      callback();
    },
    flush(callback) { this.push(replaceOrigins(pending + decoder.end(), pairs)); callback(); },
  });
}

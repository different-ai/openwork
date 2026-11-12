import { spawnSync } from "node:child_process";
import { setTimeout } from "node:timers/promises";

// These are transport failures, not permission, missing-asset, integrity, or
// compilation failures. In particular, do not retry every HTTP 4xx/5xx response.
export function isTransientNetworkFailure(stderr) {
  const text = String(stderr ?? "");
  // A command may have logged a recovered network warning before failing for a
  // different reason. Deterministic failures must win over earlier warnings.
  if (/HTTP\s+(?:400|401|403|404|409|422)\b|returned error:\s*(?:400|401|403|404|409|422)\b|integrity mismatch|checksum mismatch|certificate (?:verify|verification) failed|curl:\s*\((?:3|23|26|60|77)\)|\b(?:EACCES|ENOSPC|ENOENT|EINTEGRITY|E404|E401|E403)\b/i.test(text)) return false;
  return /\bHTTP\s+(?:408|429|500|502|503|504)\b|returned error:\s*(?:408|429|500|502|503|504)\b|curl:\s*\((?:5|6|7|18|28|52|55|56)\)|\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN)\b|connection reset by peer|TLS handshake timeout|i\/o timeout|unexpected EOF|temporary failure in name resolution|no such host/i.test(text);
}

// Retry only callers that are safe to replay (downloads, clobber uploads,
// reads, and DELETE-by-ID). Never wrap the whole packaging/signing pipeline.
export async function runNetworkCommand(command, args, options = {}, {
  spawn = spawnSync,
  sleep = setTimeout,
  log = (message) => process.stderr.write(`${message}\n`),
} = {}) {
  for (let attempt = 1; ; attempt += 1) {
    const result = spawn(command, args, {
      ...options,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 128 * 1024 * 1024,
      timeout: 10 * 60 * 1000,
    });
    if (result.status === 0 || result.error || result.signal || attempt === 3 || !isTransientNetworkFailure(result.stderr)) {
      return result;
    }
    const delay = 1000 * 2 ** (attempt - 1);
    log(`${command}: transient network failure; retry ${attempt}/2 in ${delay}ms.`);
    await sleep(delay);
  }
}

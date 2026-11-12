import { runNetworkCommand } from "../../../scripts/release/network-retry.mjs";

// Keep the retry boundary at the transport: never replay extraction, integrity
// verification, compilation, or signing because a previous step used the network.
export async function downloadWithRetry(url, destination, dependencies) {
  const result = await runNetworkCommand(process.platform === "win32" ? "curl.exe" : "curl", [
    "--disable", "--fail", "--location", "--silent", "--show-error",
    "--connect-timeout", "20", "--max-time", "300", "--retry", "0",
    "--output", destination, url,
  ], {}, dependencies);
  if (result.status !== 0) {
    throw result.error ?? new Error(String(result.stderr ?? "").trim() || `Download failed with exit ${result.status ?? result.signal ?? "unknown"}`);
  }
}

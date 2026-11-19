import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

export async function probeHandoff({ spawnBrowser = spawn, kill = process.kill, timeoutMs = 30_000 } = {}) {
  const server = createServer((req, res) => {
    res.end("OAuth browser handoff ready");
    if (req.url === "/browser-hop-proof") server.emit("browser-hop");
  });
  let browser;
  let timeout;
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    await new Promise((resolve, reject) => {
      timeout = setTimeout(() => reject(new Error("Timed out waiting for the local OAuth browser probe.")), timeoutMs);
      server.once("browser-hop", resolve);
      browser = spawnBrowser("xdg-open", [`http://127.0.0.1:${server.address().port}/browser-hop-proof`], {
        detached: true,
        stdio: "inherit",
        env: { ...process.env, OPENWORK_PROOF_BROWSER_PROFILE: `${process.env.RUNNER_TEMP}/pr-proof-browser-gate` },
      });
      browser.once("error", reject);
    });
  } finally {
    clearTimeout(timeout);
    try {
      if (browser?.pid) {
        try { kill(-browser.pid, "SIGTERM"); } catch (error) {
          if (error.code !== "ESRCH") throw error;
        }
      }
    } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await probeHandoff();
    console.log("Real xdg-open browser handoff verified");
  } catch (error) {
    console.error("::error::xdg-open did not navigate to the local OAuth browser probe.", error);
    process.exitCode = 1;
  }
}

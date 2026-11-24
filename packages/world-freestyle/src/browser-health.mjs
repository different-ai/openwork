import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// Exercise the real desktop launcher and wait for JavaScript in the browser,
// not merely a successful launcher exit. No account or external site is needed.
export async function verifyBrowserHandoff({ env = process.env, launcher = "xdg-open", args = [], openUrl, timeoutMs = 30_000 } = {}) {
  const profile = await mkdtemp(join(tmpdir(), "openwork-browser-proof-"));
  const nonce = randomUUID();
  const server = createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    if (req.url === `/${nonce}/rendered`) {
      res.end("ok");
      server.emit("rendered");
    } else if (req.url === `/${nonce}`) {
      res.end(`<!doctype html><title>Browser handoff verified</title><p>OpenWork browser handoff verified.</p><script>fetch('/${nonce}/rendered')</script>`);
    } else { res.writeHead(404); res.end(); }
  });
  let child;
  let timer;
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Desktop browser did not render through ${launcher}`)), timeoutMs);
      server.once("rendered", resolve);
      const url = `http://127.0.0.1:${server.address().port}/${nonce}`;
      if (openUrl) {
        Promise.resolve().then(() => openUrl(url)).catch(reject);
        return;
      }
      child = spawn(launcher, [...args, url], {
        env: { ...env, DISPLAY: ":99", OPENWORK_PREVIEW_BROWSER_PROFILE: profile },
        detached: true, stdio: "ignore",
      });
      child.once("error", reject);
      child.once("exit", (code) => { if (code) reject(new Error(`Desktop browser launcher failed: ${launcher}`)); });
    });
  } finally {
    clearTimeout(timer);
    if (child?.pid) { try { process.kill(-child.pid, "SIGTERM"); } catch { /* launcher already exited */ } }
    // XFCE can detach the browser from its launcher's process group. Target only
    // this disposable proof profile, never an existing reviewer's browser.
    try { execFileSync("pkill", ["-f", "--", `--user-data-dir=${profile}`], { stdio: "ignore" }); } catch { /* already stopped */ }
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

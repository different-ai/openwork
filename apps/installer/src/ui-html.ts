import type { InstallerConfig } from "./config"
import { OPENWORK_LOGO_SVG } from "./openwork-logo"

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] as string)
}

export function renderInstallerHtml(config: InstallerConfig, token: string): string {
  const logo = config.logoUrl
    ? `<img class="logo" src="${escapeHtml(config.logoUrl)}" alt="${escapeHtml(config.clientName)}" />`
    : `<div class="logo">${OPENWORK_LOGO_SVG}</div>`

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>OpenWork Installer</title>
<style>
  :root { color-scheme: light; }
  html, body { height: 100%; margin: 0; }
  body {
    display: grid; place-items: center;
    background: #ffffff; color: #18181b;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    -webkit-user-select: none; user-select: none;
  }
  main { display: grid; gap: 6px; justify-items: center; width: 320px; text-align: center; }
  .logo { max-height: 100px; max-width: 260px; width: auto; height: auto; object-fit: contain; margin-bottom: 10px; }
  div.logo svg { max-height: 72px; width: auto; height: 72px; }
  .title { font-size: 17px; font-weight: 600; }
  .client { font-size: 14px; color: #71717a; margin-bottom: 14px; }
  .status { font-size: 12px; color: #71717a; min-height: 30px; margin-top: 12px; }
  .status.error { color: #dc2626; }
  .status.done { color: #16a34a; font-weight: 600; }
  .bar { width: 100%; height: 4px; border-radius: 2px; background: rgba(24,24,27,.12); overflow: hidden; visibility: hidden; }
  .bar > div { height: 100%; width: 0%; background: #18181b; transition: width .2s; }
  .buttons { display: flex; gap: 10px; margin-top: 6px; }
  button {
    font: inherit; font-size: 13px; padding: 7px 22px; border-radius: 7px; cursor: pointer;
    border: 1px solid rgba(24,24,27,.2); background: #ffffff; color: #18181b;
  }
  button.primary { background: #18181b; color: #ffffff; border-color: transparent; font-weight: 600; }
  button:disabled { opacity: .4; cursor: default; }
</style>
</head>
<body>
<main>
  ${logo}
  <div class="title">OpenWork Installer</div>
  <div class="client">${escapeHtml(config.clientName)}</div>
  <div class="bar" id="bar"><div id="bar-fill"></div></div>
  <div class="buttons">
    <button class="primary" id="action">Install</button>
    <button id="exit">Exit</button>
  </div>
  <div class="status" id="status"></div>
</main>
<script>
  const TOKEN = ${JSON.stringify(token)};
  const statusEl = document.getElementById("status");
  const barEl = document.getElementById("bar");
  const barFillEl = document.getElementById("bar-fill");
  const actionBtn = document.getElementById("action");
  const exitBtn = document.getElementById("exit");
  let polling = null;
  let installed = false;

  async function api(path) {
    const response = await fetch(path, { method: "POST", headers: { "x-installer-token": TOKEN } });
    if (!response.ok) throw new Error("request failed: " + response.status);
    return response.json();
  }

  function closeWindow() {
    if (window.openworkInstallerExit) {
      // Native webview: the bound function terminates the window run loop.
      window.openworkInstallerExit();
      return;
    }
    api("/api/exit").catch(() => {});
    window.close();
  }

  function render(status) {
    const downloading = status.step === "download" && status.totalBytes;
    barEl.style.visibility = downloading ? "visible" : "hidden";
    if (downloading) barFillEl.style.width = Math.round(100 * status.downloadedBytes / status.totalBytes) + "%";
    statusEl.classList.toggle("error", status.state === "error");
    statusEl.classList.toggle("done", status.state === "done");

    if (status.state === "running") {
      statusEl.textContent = status.message;
      actionBtn.disabled = true;
      return;
    }
    if (polling) { clearInterval(polling); polling = null; }
    if (status.state === "done") {
      installed = true;
      statusEl.textContent = "Successfully Installed";
      actionBtn.textContent = "Launch";
      actionBtn.disabled = false;
      return;
    }
    if (status.state === "error") {
      statusEl.textContent = status.message + " " + (status.error ?? "");
      actionBtn.textContent = "Retry";
      actionBtn.disabled = false;
    }
  }

  actionBtn.addEventListener("click", async () => {
    if (installed) {
      try { await api("/api/launch"); } catch {}
      closeWindow();
      return;
    }
    actionBtn.disabled = true;
    try {
      await api("/api/install");
      polling = setInterval(async () => {
        try {
          const response = await fetch("/api/status", { headers: { "x-installer-token": TOKEN } });
          render(await response.json());
        } catch {}
      }, 400);
    } catch (error) {
      statusEl.textContent = "Could not start install: " + error.message;
      statusEl.classList.add("error");
      actionBtn.disabled = false;
    }
  });

  exitBtn.addEventListener("click", closeWindow);
</script>
</body>
</html>`
}

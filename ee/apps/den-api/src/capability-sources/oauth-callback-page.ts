/**
 * Shared completion page for OAuth callbacks. Used by both external MCP
 * connection callbacks and native provider callbacks.
 */

export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

export function connectCallbackPage(input:
  | { ok: true; name: string }
  | { ok: false; name: string; message: string; referenceId?: string }): string {
  const title = input.ok ? "You're connected" : "Connection failed"
  const closeButton = `<button type="button" onclick="window.close()">Close window</button>`
  const body = input.ok
    ? `<div class="status-row success">
        <span class="status-icon" aria-hidden="true">✓</span>
        <span><strong>${escapeHtml(input.name)} is connected to OpenWork.</strong><small>Connection complete</small></span>
      </div>
      <p>You can close this window and return to OpenWork.</p>
      ${closeButton}`
    : `<div class="status-row failure">
        <span class="status-icon" aria-hidden="true">!</span>
        <span><strong>${escapeHtml(input.name)}</strong><small>${escapeHtml(input.message)}</small></span>
      </div>
      ${input.referenceId ? `<p class="reference">Diagnostic reference: <code>${escapeHtml(input.referenceId)}</code></p>` : ""}
      ${closeButton}`
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="light">
    <title>${title} — OpenWork</title>
    <style>
      :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      * { box-sizing: border-box; }
      body { position: relative; min-height: 100vh; margin: 0; display: grid; place-items: center; overflow-x: hidden; padding: 32px; color: #101828; background: #f8fbff; }
      body::before { position: fixed; inset: 0; z-index: -1; content: ""; background-image: radial-gradient(circle, #8fb7e8 1px, transparent 1.2px); background-position: 0 0; background-size: 18px 18px; opacity: .12; mask-image: radial-gradient(ellipse at center, black, transparent 78%); }
      main { width: min(100%, 960px); padding: clamp(34px, 7vw, 76px); text-align: center; border: 1px solid #e7eaef; border-radius: 32px; background: rgba(252, 252, 253, .97); box-shadow: 0 18px 60px rgba(16, 24, 40, .06); }
      .eyebrow { margin: 0 0 20px; color: #667085; font-size: 13px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
      h1 { max-width: 16ch; margin: 0 auto; color: #101828; font-size: clamp(34px, 5vw, 56px); line-height: 1.05; letter-spacing: -.045em; }
      p { margin: 24px 0 0; color: #667085; font-size: 17px; line-height: 1.6; }
      .status-row { max-width: 720px; margin: 42px auto 0; display: flex; align-items: center; gap: 16px; padding: 22px 24px; text-align: left; border: 1px solid #e1e4e8; border-radius: 18px; background: #fff; }
      .status-row > span:last-child { min-width: 0; display: grid; gap: 3px; }
      .status-row strong { color: #101828; font-size: 17px; line-height: 1.35; overflow-wrap: anywhere; }
      .status-row small { color: #667085; font-size: 14px; line-height: 1.5; overflow-wrap: anywhere; }
      .status-icon { flex: 0 0 auto; width: 34px; height: 34px; display: grid; place-items: center; border: 1.5px solid #c9cfd7; border-radius: 50%; color: #667085; background: #fff; font-size: 17px; font-weight: 700; }
      .failure { border-color: #f1c9c5; background: #fffafa; }
      .failure .status-icon { border-color: #e3aaa4; color: #b42318; }
      .reference { margin-top: 18px; font-size: 13px; }
      code { font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; user-select: all; }
      button { margin-top: 30px; border: 0; border-radius: 12px; padding: 12px 18px; color: #fff; background: #101828; font: inherit; font-weight: 600; cursor: pointer; box-shadow: 0 1px 2px rgba(16, 24, 40, .12); }
      button:hover { background: #1d2939; }
      button:focus-visible { outline: 3px solid rgba(59, 130, 246, .28); outline-offset: 3px; }
      @media (max-width: 560px) { body { padding: 16px; } main { padding: 32px 22px; border-radius: 24px; } .status-row { margin-top: 30px; padding: 18px; } }
    </style>
  </head>
  <body>
    <main role="${input.ok ? "status" : "alert"}" aria-live="${input.ok ? "polite" : "assertive"}">
      <p class="eyebrow">OpenWork Connect</p>
      <h1>${title}</h1>
      ${body}
    </main>
  </body>
</html>`
}

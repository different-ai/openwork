/**
 * Shared "you can return to OpenWork now" HTML page for OAuth callbacks.
 * Used by both external MCP connection callbacks and native provider
 * callbacks so every connect flow ends on the same deep-linking page.
 */

export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

export function connectCallbackPage(input:
  | { ok: true; name: string }
  | { ok: false; name: string; message: string; referenceId?: string }): string {
  const title = input.ok ? "Connected" : "Connection failed"
  const openWorkUrl = "openwork://settings/extensions"
  const body = input.ok
    ? `<p>${escapeHtml(input.name)} is connected. You can return to OpenWork now.</p>
      <p><a href="${openWorkUrl}" style="display:inline-block; margin-top:16px; border-radius:10px; background:#0f172a; color:white; padding:10px 14px; text-decoration:none; font-weight:600;">Open OpenWork</a></p>
      <script>setTimeout(() => { window.location.href = "${openWorkUrl}" }, 500)</script>`
    : `<p>Could not connect ${escapeHtml(input.name)}: ${escapeHtml(input.message)}</p>
      ${input.referenceId ? `<p style="font-size:12px; color:#64748b;">Diagnostic reference: <code>${escapeHtml(input.referenceId)}</code></p>` : ""}`
  return `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>${title} — OpenWork</title></head>
  <body style="font-family: system-ui, sans-serif; max-width: 480px; margin: 64px auto; text-align: center; color: #0f172a;">
    <h1 style="font-size: 20px;">${title}</h1>
    ${body}
  </body>
</html>`
}

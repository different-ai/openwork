import { env } from "../env.js"
import { NO_INDEX } from "../public-response-headers.js"

export function wantsAppSite(request: Request): boolean {
  return request.method === "GET"
    && !request.headers.has("authorization")
    && (request.headers.get("accept") ?? "").includes("text/html")
}

const SITE_SCRIPT = `
(() => {
  const root = document.documentElement
  const mode = root.dataset.mode
  const frame = document.getElementById("app")
  const preview = document.getElementById("preview")
  const status = document.getElementById("status")
  const endpoint = location.pathname
  let token = null
  let nextId = 1
  let opened = null
  let tools = []
  let storageWritePending = false

  const show = (text) => { status.textContent = text; status.hidden = false; frame.hidden = true }

  async function rpc(method, params) {
    const response = await fetch(endpoint, {
      method: "POST",
      credentials: "omit",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(token ? { authorization: "Bearer " + token, "x-openwork-app-site": "1" } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params: params || {} }),
    })
    const text = await response.text()
    const line = text.split("\\n").find((entry) => entry.startsWith("data:"))
    let message = null
    try { message = JSON.parse(line ? line.slice(5) : text) } catch { message = null }
    if (!message || message.error || !("result" in message)) {
      if (mode === "member" && message?.error?.data?.reason === "not_found") {
        throw new Error("You don't have access to this artifact. Ask the person who sent you the link to share it with you.")
      }
      throw new Error(message && message.error && message.error.message || "This artifact is not available.")
    }
    return message.result
  }

  const post = (message) => frame.contentWindow.postMessage({ jsonrpc: "2.0", ...message }, "*")
  const theme = () => matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"

  async function answer(message) {
    const reply = (result) => post({ id: message.id, result })
    const refuse = (text) => post({ id: message.id, error: { code: -32000, message: text } })
    const params = message.params || {}
    switch (message.method) {
      case "ui/initialize":
        return reply({
          protocolVersion: params.protocolVersion || "2026-01-26",
          hostInfo: { name: "OpenWork App site", version: "1.0.0" },
          hostCapabilities: { serverTools: {}, openLinks: {}, logging: {} },
          hostContext: {
            theme: theme(),
            displayMode: "fullscreen",
            availableDisplayModes: ["fullscreen"],
            platform: "web",
            locale: navigator.language,
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          },
        })
      case "ui/notifications/initialized":
        post({ method: "ui/notifications/tool-input", params: { arguments: { input: {} } } })
        return post({ method: "ui/notifications/tool-result", params: opened })
      case "tools/call": {
        const tool = tools.find((tool) => tool.name === params.name)
        const storageWrite = tool?._meta?.["openwork/storage"] === "write"
        if (storageWrite) {
          if (!(navigator.userActivation && navigator.userActivation.isActive)) {
            return refuse("Saving needs a click on a button in this artifact.")
          }
          if (storageWritePending) return refuse("Still saving the last change. Try again in a moment.")
          storageWritePending = true
        }
        try { return reply(await rpc("tools/call", { name: params.name, arguments: params.arguments || {} })) }
        catch (error) { return refuse(error.message) }
        finally { if (storageWrite) storageWritePending = false }
      }
      case "ui/open-link": {
        let url = null
        try { url = new URL(params.url) } catch { url = null }
        if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) return refuse("Only web links can be opened.")
        window.open(url.href, "_blank", "noopener,noreferrer")
        return reply({})
      }
      case "ping":
        return reply({})
      default:
        if (message.id !== undefined) refuse("This page does not support that request.")
    }
  }

  addEventListener("message", (event) => {
    if (event.source !== frame.contentWindow) return
    const message = event.data
    if (message && message.jsonrpc === "2.0" && typeof message.method === "string") void answer(message)
  })

  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (opened) post({ method: "ui/notifications/host-context-changed", params: { theme: theme() } })
  })

  async function start() {
    if (mode === "member") {
      const requestedOrg = new URLSearchParams(location.search).get("org")
      const org = /^org_[0-7][0-9a-hjkmnp-tv-z]{25}$/.test(requestedOrg) ? requestedOrg : null
      const minted = await fetch("/v1/mcp/token", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", ...(org ? { "x-openwork-org-id": org } : {}) },
        body: JSON.stringify({ scopes: ["mcp:read", "mcp:write"] }),
      }).catch(() => null)
      if (minted?.status === 401) {
        status.textContent = "Sign in to OpenWork to open this artifact. "
        const url = new URL("/artifact", root.dataset.signIn)
        url.searchParams.set("id", endpoint.split("/").pop())
        if (org) url.searchParams.set("org", org)
        const link = document.createElement("a")
        link.href = url.href
        link.textContent = "Sign in"
        status.append(link)
        return
      }
      const issued = await minted?.json().catch(() => null)
      if (org && minted?.status === 404 && issued?.error === "organization_not_found") {
        return show("You are signed in, but you are not a member of the organization this artifact belongs to. Ask the person who sent the link to invite you.")
      }
      if (!minted?.ok || typeof issued?.token !== "string" || !issued.token) {
        return show("This artifact could not be opened. Try again in a moment.")
      }
      token = issued.token
    }
    tools = (await rpc("tools/list")).tools || []
    const launch = tools.find((tool) => tool.name === "open_app")
    const uri = launch && launch._meta && launch._meta.ui && launch._meta.ui.resourceUri
    if (!uri) throw new Error("This artifact is not available.")
    opened = await rpc("tools/call", { name: "open_app", arguments: { input: {} } })
    const resource = await rpc("resources/read", { uri })
    const html = resource.contents && resource.contents[0] && resource.contents[0].text
    if (typeof html !== "string") throw new Error("This artifact is not available.")
    const title = opened.structuredContent && opened.structuredContent.app && opened.structuredContent.app.title
    if (typeof title === "string") document.title = title
    preview.hidden = true
    frame.hidden = false
    frame.srcdoc = html
  }

  start().catch((error) => show(error.message || "This artifact is not available."))
})()
`.trim()

function escapeAttribute(value: string): string {
  return value.replace(/[&"<>]/gu, (char) => `&#${char.charCodeAt(0)};`)
}

const SITE_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data:",
  "font-src data:",
  "connect-src 'self'",
  "frame-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ")

const OPENWORK_MARK = `
<svg role="img" aria-label="OpenWork"
  xmlns="http://www.w3.org/2000/svg"
  viewBox="0 0 834 649"
  fill="none"
>
  <path
    fill="currentColor"
    d="M445.095 7.09371C465.376 6.15629 479.12 14.7057 495.962 24.2006L526.535 41.3366L562.91 61.6421C572.209 66.8088 584.43 72.9805 592.216 79.7283C605.112 90.9218 613.007 107.518 613.57 124.621C613.997 137.564 613.785 151.186 613.771 164.285L613.743 233.167L613.724 302.115C613.724 328.043 615.147 351.097 609.112 376.5C602.601 403.733 589.274 428.855 570.372 449.495C549.311 472.84 531.218 480.587 504.269 495.433L435.717 533.297L369.268 570.017C349.148 581.007 338.445 590.166 314.978 591.343C295.336 592.765 280.624 583.434 264.332 574.332L231.209 555.796L197.159 536.707C188.064 531.606 176.78 525.84 169.138 519.247C155.537 507.509 147.236 489.12 146.689 471.221C146.261 457.224 146.479 442.102 146.479 427.951L146.495 345.546L146.52 273.548C146.53 254.27 145.49 230.956 149.51 212.464C154.532 189.864 165.167 168.888 180.427 151.489C188.245 142.605 197.223 134.814 207.121 128.324C220.854 119.307 239.559 109.953 254.414 101.931L324.032 63.8708L377.708 34.3028C389.942 27.4909 403.011 19.8636 415.79 14.2429C424.983 10.1982 434.435 8.96958 445.095 7.09371Z"
  />
  <path
    fill="#FFFFFF"
    d="M551.317 90.4398C557.678 89.5674 565.764 91.1466 571.495 93.8628C579.57 97.6845 585.756 104.611 588.643 113.063C593.053 125.734 591.473 156.67 591.443 171.112L591.314 249.733L591.238 310.947C591.227 325.186 591.691 340.89 590.054 354.92C588.069 370.594 583.473 385.826 576.46 399.982C555.363 442.986 527.973 455.45 488.286 477.122L422.355 513.332L365.248 544.928C353.229 551.61 337.931 561.062 325.256 565.404C303.927 570.03 288.668 560.584 286.41 537.983C285.155 525.413 285.813 512.071 285.819 499.363L285.877 428.201L285.838 335.271C285.834 319.126 284.849 293.286 287.551 278.43C291.03 259.848 299.063 242.413 310.931 227.699C318.408 218.335 327.295 210.186 337.275 203.548C346.99 197.101 362.755 189.212 373.491 183.383L431.093 151.71L500.183 113.742C508.673 109.063 517.232 104.321 525.662 99.5446C534.307 94.6455 540.968 91.4752 551.317 90.4398Z"
  />
  <path
    fill="currentColor"
    d="M500.082 178.001C526.778 177.772 523.894 205.211 523.884 223.719L523.898 262.499L523.914 317.09C523.91 328.358 524.422 343.13 522.698 354.018C520.708 366.296 516.186 378.028 509.412 388.459C503.656 397.432 496.335 405.297 487.795 411.689C481.432 416.447 474.925 419.72 467.987 423.536L442.835 437.398L405.739 457.871C398 462.106 386.024 469.486 377.74 471.261L377.429 471.295C371.837 471.855 366.369 470.989 361.995 467.199C353.196 459.977 353.708 447.985 353.675 437.935C353.658 432.922 353.668 427.909 353.67 422.896L353.695 376.464L353.657 326.944C353.647 313.866 353.091 297.438 355.615 284.836C358.159 272.209 363.878 260.447 372.266 250.342C376.745 244.958 381.997 240.295 387.801 236.377C393.985 232.272 401.996 228.073 408.612 224.459L440.329 207.201L468.44 191.684C477.65 186.588 489.038 179.021 500.082 178.001Z"
  />
  <path
    fill="#FFFFFF"
    d="M500.225 291.464L500.59 291.556C501.213 292.643 501.002 340.865 500.638 345.536C500.306 350.339 499.443 355.09 498.065 359.703C494.788 370.842 488.588 380.902 480.112 388.834C472.165 396.184 462.79 400.931 453.37 406.067L431.052 418.227L377.328 447.628L376.894 447.414C376.568 445.467 376.757 441.034 376.763 438.896L376.794 421.911C376.893 401.013 376.885 380.115 376.77 359.217C382.142 355.849 390.96 351.452 396.691 348.372L427.925 331.276L469.656 308.362C479.711 302.761 490.055 296.768 500.225 291.464Z"
  />
  <path
    fill="#FFFFFF"
    d="M497.337 201.62C500.344 201.36 500.962 203.237 501.131 205.91C501.599 213.274 501.389 220.747 501.367 228.135L501.431 265.103C460.969 287.74 420.329 310.058 379.523 332.068L376.452 333.794C376.365 312.962 373.253 285.726 386.024 268.182C393.365 258.104 404.145 253.143 414.788 247.296L441.211 232.769L476.823 212.874C483.353 209.216 490.623 204.921 497.337 201.62Z"
  />
  <path
    fill="#FFFFFF"
    d="M443.216 29.48C452.02 29.0815 460.018 30.0261 467.903 34.1434C489.625 45.4892 510.693 58.4477 532.373 69.8693C514.905 78.2946 493.564 90.995 476.372 100.542L386.895 149.628C376.357 155.498 365.774 161.287 355.148 166.992C337.373 176.588 322.776 183.695 307.595 197.464C287.772 215.608 273.675 239.14 267.014 265.17C262.116 284.284 262.909 298.302 262.917 317.836L262.939 357.47L262.926 471.524L262.961 530.447C262.98 532.198 263.562 543.941 263.164 544.751L262.58 544.549L215.582 518.061C189.232 503.261 169.189 495.747 169.845 460.795C170.068 448.934 169.804 435.617 169.812 423.605L169.831 344.391L169.818 269.769C169.814 254.383 168.977 231.859 171.873 217.311C175.825 198.048 184.641 180.127 197.478 165.236C204.056 157.596 211.686 150.929 220.143 145.432C231.916 137.708 249.246 128.979 262.061 121.995L328.787 85.3185L391.28 50.97C401.594 45.3095 412 39.3027 422.528 34.3441C428.812 31.3849 436.148 30.2484 443.216 29.48Z"
  />
</svg>
`.trim()

const PREVIEW_STYLE = `
html, body { margin: 0; height: 100%; }
body { color-scheme: light dark; }
#app:not([hidden]) { display: block; width: 100%; height: 100%; border: 0; }
#preview:not([hidden]) {
  --lp-ink: #011627;
  --lp-page: #fcfdfe;
  --lp-muted: #5e6877;
  --lp-button-ink: #f7f7f4;
  --lp-button-hover: #102638;
  --lp-pill-radius: 9999px;
  box-sizing: border-box;
  min-height: 100%;
  display: grid;
  place-content: center;
  justify-items: center;
  gap: 24px;
  padding: 24px;
  color-scheme: light;
  background: var(--lp-page);
  color: var(--lp-muted);
  font: 400 1rem/1.5 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  -webkit-font-smoothing: antialiased;
  text-align: center;
}
#preview svg { display: block; width: 48px; height: auto; color: var(--lp-ink); }
#status { max-width: 40ch; margin: 0; text-wrap: pretty; }
#status a {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  justify-content: center;
  width: max-content;
  height: 43px;
  margin: 20px auto 0;
  padding: 0 22px;
  border-radius: var(--lp-pill-radius);
  border: 1px solid var(--lp-ink);
  background: var(--lp-ink);
  color: var(--lp-button-ink);
  line-height: 1;
  text-decoration: none;
}
#status a:hover { background: var(--lp-button-hover); border-color: var(--lp-button-hover); }
#status a:focus-visible { outline: 2px solid var(--lp-ink); outline-offset: 4px; }
`.trim()

function sitePage(mode: "public" | "member"): string {
  return `<!doctype html><html lang="en" data-mode="${mode}" data-sign-in="${escapeAttribute(env.webUrl)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="${NO_INDEX}"><title>OpenWork Artifact</title><style>${PREVIEW_STYLE}</style></head><body><main id="preview">${OPENWORK_MARK}<p id="status" role="status">Opening…</p></main><iframe id="app" title="Artifact" sandbox="allow-scripts allow-forms" hidden></iframe><script>${SITE_SCRIPT}</script></body></html>`
}

export const APP_SITE_HEADER = "x-openwork-app-site"

export async function appSiteResponse(input: { appIdOrName: string; publicOnly: boolean }): Promise<Response | null> {
  if (!env.appMcpServersEnabled) return null
  if (input.publicOnly) {
    const { loadPublicMcpApp } = await import("../mcp-apps.js")
    if (!await loadPublicMcpApp({ appIdOrName: input.appIdOrName })) return null
  }
  return new Response(sitePage(input.publicOnly ? "public" : "member"), {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": SITE_CSP,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-robots-tag": NO_INDEX,
    },
  })
}

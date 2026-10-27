import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { test } from "node:test"
import { workbotConnectRequestSchema, workbotOAuthReturnSchema } from "../src/workbot/connect-return-schema.js"
import { connectCallbackPage } from "../src/capability-sources/oauth-callback-page.js"

test("Workbot OAuth returns accept only bounded path-only destinations", () => {
  for (const returnPath of ["/", "/documents?chat=one#file", "/calendar"]) assert.equal(workbotConnectRequestSchema.safeParse({ requestId: randomUUID(), returnPath }).success, true)
  for (const returnPath of ["https://outside.example.test/", "//outside.example.test/", "\\outside.example.test", "/\\outside.example.test", "/\toutside", "/\nother", "documents", "/".repeat(2049)]) assert.equal(workbotConnectRequestSchema.safeParse({ requestId: randomUUID(), returnPath }).success, false, returnPath)
  assert.equal(workbotConnectRequestSchema.safeParse({ requestId: "arbitrary", returnPath: "/" }).success, false)
  assert.equal(workbotOAuthReturnSchema.safeParse({ requestId: randomUUID(), origin: "https://workbot.example.test", returnPath: "//outside.example.test" }).success, false)
})

test("popup completion sends only the finite outcome to the exact origin and safely escapes return markup", () => {
  const requestId = randomUUID()
  const page = connectCallbackPage({ ok: false, name: "Fixture <app>", message: "Provider secret must stay in this page" }, { origin: "https://workbot.example.test", returnPath: '/documents?q="<script>', requestId, connectionId: "google-workspace" })
  assert.ok(page.includes('postMessage({"type":"openwork:connection-result"'))
  assert.ok(page.includes('"https://workbot.example.test")'))
  assert.equal(page.includes('postMessage("*"'), false)
  assert.ok(page.includes('"ok":false'))
  const script = page.slice(page.indexOf("<script>"))
  assert.equal(page.includes("Provider secret"), false)
  assert.equal(script.includes("Provider secret"), false)
  assert.equal(script.includes("Fixture"), false)
  assert.ok(page.includes("Fixture &lt;app&gt;"))
  assert.equal(page.includes('href="https://workbot.example.test/documents?q="<script>'), false)
  assert.equal(connectCallbackPage({ ok: true, name: "Fixture" }).includes("postMessage"), false)
})

test("signed Workbot success reports sign-in only and sends the person back for readiness verification", () => {
  const page = connectCallbackPage({ ok: true, name: "Fixture <app>" }, { origin: "https://workbot.example.test", returnPath: "/documents?chat=one", requestId: randomUUID(), connectionId: "google-workspace" })
  assert.ok(page.includes("<title>Signed in to Fixture &lt;app&gt; — Workbot</title>"))
  assert.ok(page.includes("<h1>Signed in to Fixture &lt;app&gt;</h1>"))
  assert.ok(page.includes("</svg><span>Workbot</span>"))
  assert.ok(page.includes("Return to Workbot to verify the connection."))
  assert.ok(page.includes('href="https://workbot.example.test/documents?chat=one">Return to Workbot</a>'))
  assert.equal(page.includes("You're connected"), false)
  assert.equal(page.includes("is connected"), false)
  assert.equal(page.includes("Connection complete"), false)
  assert.equal(page.includes("return to OpenWork"), false)
  assert.equal(page.includes("— OpenWork"), false)
  assert.equal(page.includes("<script>Fixture <app>"), false)
})

test("signed Workbot failures provide a safe next action instead of untrusted provider prose", () => {
  const page = connectCallbackPage({ ok: false, name: "Fixture", message: "RAW_PROVIDER_ERROR <script>untrusted()</script>", referenceId: "diagnostic-only" }, { origin: "https://workbot.example.test", returnPath: "/calendar", requestId: randomUUID(), connectionId: "google-workspace" })
  assert.ok(page.includes("<title>Connection not verified — Workbot</title>"))
  assert.ok(page.includes("Try Connect again in Workbot."))
  assert.ok(page.includes("ask an admin to review this app's permissions."))
  assert.ok(page.includes(">Return to Workbot</a>"))
  assert.ok(page.includes('"ok":false'))
  assert.equal(page.includes("RAW_PROVIDER_ERROR"), false)
  assert.equal(page.includes("untrusted()"), false)
  assert.equal(page.includes("return to OpenWork"), false)
})

test("compact token-based callback styling is scoped to signed Workbot returns", () => {
  const page = connectCallbackPage({ ok: true, name: "Fixture" }, { origin: "https://workbot.example.test", returnPath: "/documents", requestId: randomUUID(), connectionId: "google-workspace" })
  assert.ok(page.includes('<main class="workbot-callback" role="status"'))
  assert.ok(page.includes("--text-sm: 0.8125rem; --text-xl: 1.25rem; --spacing: 0.25rem;"))
  assert.ok(page.includes("font-size: var(--text-xl); line-height: 1.4;"))
  assert.ok(page.includes("padding: calc(var(--spacing) * 6)"))
  assert.ok(page.includes("color: var(--dls-text-primary)"))
  assert.ok(page.indexOf(".workbot-callback h1") > page.indexOf("@media (max-width: 640px)"))
  const generic = connectCallbackPage({ ok: true, name: "Fixture" })
  assert.equal(generic.includes("workbot-callback"), false)
  assert.ok(generic.includes("font-size: 38px;"))
  assert.ok(generic.includes("font-size: 30px;"))
})

test("ordinary non-Workbot callback wording and diagnostic details remain unchanged", () => {
  const success = connectCallbackPage({ ok: true, name: "Fixture" })
  assert.ok(success.includes("<title>You're connected — OpenWork</title>"))
  assert.ok(success.includes("Fixture is connected to OpenWork."))
  assert.ok(success.includes("You can close this window and return to OpenWork."))
  assert.ok(success.includes("</svg><span>OpenWork</span>"))
  assert.equal(success.includes("Workbot"), false)
  const failure = connectCallbackPage({ ok: false, name: "Fixture", message: "Provider & reason", referenceId: "reference-id" })
  assert.ok(failure.includes("<title>Connection failed — OpenWork</title>"))
  assert.ok(failure.includes("Provider &amp; reason"))
  assert.ok(failure.includes("Diagnostic reference: <code>reference-id</code>"))
  assert.ok(failure.includes("Return to OpenWork to try connecting again. You can close this window."))
  assert.equal(failure.includes("Workbot"), false)
})

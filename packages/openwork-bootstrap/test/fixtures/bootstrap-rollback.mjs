// Isolated CLI test transport: no network or custom asset fetch is permitted.
globalThis.fetch = async (input, init) => {
  const url = new URL(input)
  if (!url.hostname.endsWith(".example.test")) throw new Error(`Unexpected fetch: ${url}`)
  if (url.pathname === "/health") return Response.json({ ok: true })
  if (url.pathname === "/v1/bootstrap/workspace") return Response.json({
    ok: true,
    organization: { id: "test-org", name: "Test organization", slug: "test-org" },
    skill: { id: "test-skill", title: "Test skill" },
    claimLinks: [],
    whiteLabelEnabled: JSON.parse(init.body).workspaceName === "Enabled test organization",
    brand: JSON.parse(init.body).workspaceName === "Enabled test organization"
      ? { appName: "Enabled desktop", logoUrl: "https://assets.example.test/logo.png", iconUrl: "https://assets.example.test/icon.png" }
      : { appName: "OpenWork", logoUrl: null, iconUrl: null },
  })
  throw new Error(`Unexpected fetch: ${url}`)
}

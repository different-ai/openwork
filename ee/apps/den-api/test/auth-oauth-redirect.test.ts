import { describe, expect, test } from "bun:test"
import { normalizeOAuthAuthorizeRedirect } from "../src/routes/auth/oauth-redirect.js"

describe("OAuth authorization redirects", () => {
  test("turns Better Auth's JSON redirect envelope into an HTTP redirect", async () => {
    const headers = new Headers({
      "content-type": "application/json",
      "x-auth-result": "kept",
    })
    headers.append("set-cookie", "session=abc; Path=/; HttpOnly")
    headers.append("set-cookie", "state=xyz; Path=/; HttpOnly")
    const response = new Response(JSON.stringify({
      redirect: true,
      url: "https://app.example.com/mcp/select-organization?state=test",
    }), { headers })

    const normalized = await normalizeOAuthAuthorizeRedirect(response)

    expect(normalized.status).toBe(302)
    expect(normalized.headers.get("location")).toBe("https://app.example.com/mcp/select-organization?state=test")
    expect(normalized.headers.get("x-auth-result")).toBe("kept")
    expect(normalized.headers.getSetCookie()).toEqual([
      "session=abc; Path=/; HttpOnly",
      "state=xyz; Path=/; HttpOnly",
    ])
    expect(normalized.headers.get("content-type")).toBeNull()
    expect(await normalized.text()).toBe("")
  })

  test("leaves ordinary JSON responses unchanged", async () => {
    const response = Response.json({ ok: true })

    expect(await normalizeOAuthAuthorizeRedirect(response)).toBe(response)
    expect(await response.json()).toEqual({ ok: true })
  })
})

import { describe, expect, test } from "bun:test"
import {
  isDesktopHandoffWebAppHost,
  resolveDesktopDenBaseUrl,
  withDenProxyPath,
} from "../src/routes/auth/desktop-handoff-url.js"

describe("desktop handoff URL resolution", () => {
  test("adds the den proxy path for Cloud Run web origins", () => {
    const request = new Request("https://den-api-example.run.app/v1/auth/desktop-handoff", {
      headers: {
        origin: "https://den-web-123.us-central1.run.app",
        "x-forwarded-proto": "https",
        host: "den-api-example.run.app",
      },
    })

    expect(resolveDesktopDenBaseUrl(request)).toBe("https://den-web-123.us-central1.run.app/api/den")
  })

  test("uses forwarded Cloud Run web hosts when no origin is present", () => {
    const request = new Request("https://den-api-example.run.app/v1/auth/desktop-handoff", {
      headers: {
        "x-forwarded-proto": "https",
        "x-forwarded-host": "den-web-123.us-central1.run.app",
      },
    })

    expect(resolveDesktopDenBaseUrl(request)).toBe("https://den-web-123.us-central1.run.app/api/den")
  })

  test("allows self-hosted web hosts configured by deployment", () => {
    const request = new Request("https://den-api.example.internal/v1/auth/desktop-handoff", {
      headers: {
        origin: "https://work.example.com",
      },
    })

    expect(resolveDesktopDenBaseUrl(request, { webAppHosts: ["work.example.com"] }))
      .toBe("https://work.example.com/api/den")
  })

  test("allows configured wildcard host suffixes", () => {
    expect(isDesktopHandoffWebAppHost("tenant.example.com", { webAppHosts: ["*.example.com"] })).toBe(true)
    expect(isDesktopHandoffWebAppHost("example.com", { webAppHosts: ["*.example.com"] })).toBe(false)
  })

  test("does not duplicate the den proxy path", () => {
    expect(withDenProxyPath("https://work.example.com/api/den")).toBe("https://work.example.com/api/den")
  })

  test("keeps non-web hosts as bare origins", () => {
    const request = new Request("https://api.example.com/v1/auth/desktop-handoff", {
      headers: {
        "x-forwarded-proto": "https",
        host: "api.example.com",
      },
    })

    expect(resolveDesktopDenBaseUrl(request)).toBe("https://api.example.com")
  })
})

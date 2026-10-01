import { describe, expect, test } from "bun:test"
import { isCloudBrowserError } from "./contract"
import { displayUrl, isInternalHost, isReadableUrl, parseNavigableUrl } from "./url"

function codeOf(value: string): string | null {
  try {
    parseNavigableUrl(value)
    return null
  } catch (error) {
    return isCloudBrowserError(error) ? error.code : "unexpected"
  }
}

describe("which addresses the agent may open", () => {
  test("public http and https websites open", () => {
    for (const url of ["https://example.com", "http://example.com/path?q=1#top", "https://app.example.com:8443/login", "https://93.184.215.14/", "https://[2606:4700:4700::1111]/"]) {
      expect(codeOf(url)).toBeNull()
    }
  })

  test("browser-internal and script schemes are invalid", () => {
    for (const url of ["file:///etc/passwd", "chrome://settings", "data:text/html,hi", "javascript:alert(1)", "about:blank", "ftp://example.com", "view-source:https://example.com", "not a url", ""]) {
      expect(codeOf(url)).toBe("invalid_url")
    }
  })

  test("credentials in the address are refused", () => {
    expect(codeOf("https://user:pass@example.com/")).toBe("invalid_url")
    expect(codeOf("https://user@example.com/")).toBe("invalid_url")
  })

  test("loopback, private, link-local and internal hosts are blocked, in every spelling", () => {
    for (const url of [
      "http://localhost:9222/json/version",
      "http://app.localhost/",
      "http://127.0.0.1/",
      "http://127.1/",
      "http://2130706433/",
      "http://0x7f000001/",
      "http://0.0.0.0/",
      "http://10.1.2.3/",
      "http://172.16.0.1/",
      "http://172.31.255.255/",
      "http://192.168.1.1/",
      "http://169.254.169.254/latest/meta-data/",
      "http://100.64.0.1/",
      "http://[::1]/",
      "http://[::]/",
      "http://[fe80::1]/",
      "http://[fd00::1]/",
      "http://[::ffff:127.0.0.1]/",
      "http://[::ffff:10.0.0.1]/",
      "http://printer.local/",
      "http://metadata.google.internal/",
      "http://router/",
      "http://224.0.0.1/",
    ]) {
      expect([url, codeOf(url)]).toEqual([url, "blocked_url"])
    }
  })

  test("public addresses next to private ranges stay open", () => {
    expect(isInternalHost("172.32.0.1")).toBe(false)
    expect(isInternalHost("192.169.0.1")).toBe(false)
    expect(isInternalHost("11.0.0.1")).toBe(false)
    expect(isInternalHost("[2001:4860:4860::8888]")).toBe(false)
    expect(isInternalHost("localhost.example.com")).toBe(false)
  })

  test("overlong addresses are invalid", () => {
    expect(codeOf(`https://example.com/${"a".repeat(5_000)}`)).toBe("invalid_url")
  })

  test("readable pages include the blank start page but not internal hosts", () => {
    expect(isReadableUrl("about:blank")).toBe(true)
    expect(isReadableUrl("https://example.com/")).toBe(true)
    expect(isReadableUrl("http://127.0.0.1:9222/json")).toBe(false)
  })

  test("display addresses drop queries and fragments, which can carry tokens", () => {
    expect(displayUrl("https://app.example.com/login?token=secret#frag")).toBe("https://app.example.com/login")
    expect(displayUrl("about:blank")).toBe("about:blank")
    expect(displayUrl("chrome-error://chromewebdata/")).toBe("")
    expect(displayUrl("garbage")).toBe("")
  })
})

import { describe, expect, test } from "bun:test"
import { assertPublicUrl, isPrivateAddress, PrivateUrlError } from "../src/capability-sources/url-guard.js"

describe("isPrivateAddress", () => {
  test.each([
    ["127.0.0.1", true],
    ["127.255.255.255", true],
    ["10.0.0.1", true],
    ["10.255.255.255", true],
    ["172.16.0.1", true],
    ["172.31.255.255", true],
    ["192.168.1.1", true],
    ["169.254.169.254", true], // cloud metadata
    ["169.254.0.1", true],
    ["100.64.0.1", true], // CGNAT
    ["100.127.255.255", true],
    ["0.0.0.0", true],
    ["198.18.0.1", true],
    ["224.0.0.1", true], // multicast
    ["255.255.255.255", true], // broadcast
    ["::1", true],
    ["::", true],
    ["fc00::1", true],
    ["fd12:3456::1", true],
    ["fe80::1", true],
    ["::ffff:127.0.0.1", true], // mapped loopback
    ["::ffff:10.0.0.1", true], // mapped private
    ["not-an-ip", true], // fail closed
  ])("blocks %s", (address, expected) => {
    expect(isPrivateAddress(address)).toBe(expected)
  })

  test.each([
    ["1.1.1.1", false],
    ["8.8.8.8", false],
    ["104.18.0.1", false],
    ["172.15.255.255", false], // just outside 172.16/12
    ["172.32.0.1", false],
    ["100.63.255.255", false], // just outside CGNAT
    ["100.128.0.1", false],
    ["169.253.1.1", false],
    ["198.17.0.1", false],
    ["2606:4700:4700::1111", false],
    ["::ffff:8.8.8.8", false], // mapped public
  ])("allows %s", (address, expected) => {
    expect(isPrivateAddress(address)).toBe(expected)
  })
})

describe("assertPublicUrl", () => {
  test("rejects private IP literals", async () => {
    await expect(assertPublicUrl("http://127.0.0.1:3978/mcp")).rejects.toBeInstanceOf(PrivateUrlError)
    await expect(assertPublicUrl("http://169.254.169.254/latest/meta-data/")).rejects.toBeInstanceOf(PrivateUrlError)
    await expect(assertPublicUrl("http://10.0.0.5/mcp")).rejects.toBeInstanceOf(PrivateUrlError)
    await expect(assertPublicUrl("http://[::1]:8080/mcp")).rejects.toBeInstanceOf(PrivateUrlError)
  })

  test("rejects hostnames that resolve to loopback (the DNS-rebinding case)", async () => {
    // "localhost" is the universally-resolvable stand-in for a public-looking
    // hostname whose DNS answer is a private address.
    await expect(assertPublicUrl("http://localhost:3978/mcp")).rejects.toBeInstanceOf(PrivateUrlError)
  })

  test("rejects non-http(s) protocols and garbage", async () => {
    await expect(assertPublicUrl("file:///etc/passwd")).rejects.toBeInstanceOf(PrivateUrlError)
    await expect(assertPublicUrl("gopher://example.com/")).rejects.toBeInstanceOf(PrivateUrlError)
    await expect(assertPublicUrl("not a url")).rejects.toBeInstanceOf(PrivateUrlError)
  })

  test("allows public IP literals without any DNS lookup", async () => {
    await expect(assertPublicUrl("https://1.1.1.1/mcp")).resolves.toBeUndefined()
  })
})

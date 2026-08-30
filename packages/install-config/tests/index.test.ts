import { describe, expect, test } from "bun:test"

import { installConfigUrlFor, parseInstallerFilenameTag } from "../src/index"

describe("installer filename tags", () => {
  test("parses canonical host and token tags", () => {
    expect(parseInstallerFilenameTag("OpenWork-Installer--127.0.0.1_8790--abcDEF12.exe")).toEqual({
      host: "127.0.0.1:8790",
      token: "abcDEF12",
    })
    expect(parseInstallerFilenameTag("OpenWork-Installer--api.example.com--abcD--EF12")).toEqual({
      host: "api.example.com",
      token: "abcD--EF12",
    })
  })

  test("preserves punycode and dashes in hosts and tokens", () => {
    expect(parseInstallerFilenameTag("OpenWork-Installer--xn--bcher-kva.api-edge.example--abcDEF12--ghiJKLM9.exe")).toEqual({
      host: "xn--bcher-kva.api-edge.example",
      token: "abcDEF12--ghiJKLM9",
    })
    expect(parseInstallerFilenameTag("OpenWork-Installer--api.example.com----abcDEF12")).toEqual({
      host: "api.example.com",
      token: "--abcDEF12",
    })
    expect(parseInstallerFilenameTag("OpenWork-Installer--xn--bcher-kva--abcDEF12")).toEqual({
      host: "xn--bcher-kva",
      token: "abcDEF12",
    })
  })

  test("parses tags with delimiters in the installer prefix without treating token segments as hosts", () => {
    expect(parseInstallerFilenameTag("OpenWork--Cloud-Installer--api.example.com--hostlike--abcDEF12.exe")).toEqual({
      host: "api.example.com",
      token: "hostlike--abcDEF12",
    })
    expect(parseInstallerFilenameTag("OpenWork--Cloud-Installer--localhost--abcD--EF12.exe")).toEqual({
      host: "localhost",
      token: "abcD--EF12",
    })
  })

  test("rejects malformed huge input without ambiguous delimiter backtracking", () => {
    expect(parseInstallerFilenameTag("OpenWork-Installer--alpha--bravo123--charlie9.exe")).toBeNull()
    expect(parseInstallerFilenameTag(`a--${"----".repeat(25_000)}`)).toBeNull()
    expect(parseInstallerFilenameTag(`OpenWork-Installer--api.example.com--${"a-".repeat(50_000)}!`)).toBeNull()
  })

  test("normalizes a slash-heavy install host", () => {
    expect(installConfigUrlFor(`https://api.example.com${"/".repeat(100_000)}`, "abcDEF12")).toBe(
      "https://api.example.com/v1/install-config?token=abcDEF12",
    )
  })
})

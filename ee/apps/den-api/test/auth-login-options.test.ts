import { expect, test } from "bun:test"
import { normalizeLoginEmail, resolveLoginOptionKind } from "../src/auth-login-options.js"

test("login option resolution normalizes email input", () => {
  expect(normalizeLoginEmail(" User@Example.COM ")).toBe("user@example.com")
})

test("login option resolution prioritizes SSO before account providers", () => {
  expect(resolveLoginOptionKind({
    requireSso: true,
    accounts: [
      { providerId: "google", hasPassword: false },
      { providerId: "credential", hasPassword: true },
    ],
  })).toBe("sso")
})

test("login option resolution prefers Google, then password, then GitHub compatibility", () => {
  expect(resolveLoginOptionKind({
    requireSso: false,
    accounts: [
      { providerId: "credential", hasPassword: true },
      { providerId: "google", hasPassword: false },
    ],
  })).toBe("google")

  expect(resolveLoginOptionKind({
    requireSso: false,
    accounts: [
      { providerId: "github", hasPassword: false },
      { providerId: "credential", hasPassword: true },
    ],
  })).toBe("password")

  expect(resolveLoginOptionKind({
    requireSso: false,
    accounts: [{ providerId: "github", hasPassword: false }],
  })).toBe("github")
})

test("login option resolution returns new account when no existing auth method matches", () => {
  expect(resolveLoginOptionKind({ requireSso: false, accounts: [] })).toBe("new_account")
})

test("login option resolution keeps private single-org unknown users in sign-in", () => {
  expect(resolveLoginOptionKind({
    requireSso: false,
    accounts: [],
    allowNewAccount: false,
  })).toBe("password")
})

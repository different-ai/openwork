import { beforeAll, expect, test } from "bun:test"

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
}

let appModule: typeof import("../src/app.js")

beforeAll(async () => {
  seedRequiredEnv()
  appModule = await import("../src/app.js")
})

test("worker proxy reads require a client or host token", () => {
  expect(appModule.isProxyTokenAuthorized("GET", null)).toBe(false)
  expect(appModule.isProxyTokenAuthorized("GET", "invalid")).toBe(false)
  expect(appModule.isProxyTokenAuthorized("GET", "activity")).toBe(false)
  expect(appModule.isProxyTokenAuthorized("GET", "client")).toBe(true)
  expect(appModule.isProxyTokenAuthorized("HEAD", "host")).toBe(true)
})

test("worker proxy writes require a host token", () => {
  expect(appModule.isProxyTokenAuthorized("POST", null)).toBe(false)
  expect(appModule.isProxyTokenAuthorized("POST", "client")).toBe(false)
  expect(appModule.isProxyTokenAuthorized("POST", "activity")).toBe(false)
  expect(appModule.isProxyTokenAuthorized("POST", "host")).toBe(true)
})

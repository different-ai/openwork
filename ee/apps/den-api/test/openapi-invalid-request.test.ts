import { describe, expect, test } from "bun:test"
import { invalidRequestSchema } from "../src/openapi.js"

describe("InvalidRequestError contract", () => {
  test("models validator details and explicit message responses", () => {
    expect(invalidRequestSchema.safeParse({
      error: "invalid_request",
      details: {
        name: "ZodError",
        message: "Request validation failed.",
      },
    }).success).toBe(true)
    expect(invalidRequestSchema.safeParse({
      error: "invalid_request",
      details: [{ message: "A per-member connection is required.", path: ["credentialMode"] }],
    }).success).toBe(true)
    expect(invalidRequestSchema.safeParse({
      error: "invalid_request",
      message: "URL not allowed.",
    }).success).toBe(true)
    expect(invalidRequestSchema.safeParse({ error: "invalid_request" }).success).toBe(false)
  })
})

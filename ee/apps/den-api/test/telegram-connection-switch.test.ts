import { describe, expect, test } from "bun:test"
import { switchTelegramConnectionSafely } from "../src/capability-sources/telegram-connection-switch.js"

describe("Telegram connection replacement", () => {
  test("restores the old same-bot webhook when commit fails after activation", async () => {
    const registrations: string[] = []
    const deletions: string[] = []
    const previous = {
      botToken: "same-token",
      secret: "old-secret",
      url: "https://openwork.example/webhook/tgc_1",
    }
    const next = { ...previous, secret: "new-secret" }

    await expect(switchTelegramConnectionSafely({
      deleteWebhook: async (token) => {
        deletions.push(token)
      },
      next,
      previous,
      registerWebhook: async (registration) => {
        registrations.push(registration.secret)
      },
      switchConnection: async (activate) => {
        await activate()
        throw new Error("commit failed")
      },
    })).rejects.toThrow("commit failed")

    expect(registrations).toEqual(["new-secret", "old-secret"])
    expect(deletions).toEqual([])
  })

  test("does not touch Telegram when a unique bot conflict happens before activation", async () => {
    const registrations: string[] = []
    const deletions: string[] = []

    await expect(switchTelegramConnectionSafely({
      deleteWebhook: async (token) => {
        deletions.push(token)
      },
      next: { botToken: "new-token", secret: "new-secret", url: "https://example.test/new" },
      previous: { botToken: "old-token", secret: "old-secret", url: "https://example.test/old" },
      registerWebhook: async (registration) => {
        registrations.push(registration.secret)
      },
      switchConnection: async () => {
        throw new Error("duplicate entry")
      },
    })).rejects.toThrow("duplicate entry")

    expect(registrations).toEqual([])
    expect(deletions).toEqual([])
  })
})

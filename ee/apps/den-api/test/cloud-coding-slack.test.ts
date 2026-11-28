import assert from "node:assert/strict"
import { test } from "node:test"
import { slackManifest } from "../src/slack-assistant/protocol.js"

test("the Slack app manifest already grants message writes and routes button interactions", () => {
  const manifest = slackManifest("https://api.acme.example/", "acme")
  assert.ok(manifest.oauth_config.scopes.bot.includes("chat:write"))
  assert.deepEqual(manifest.settings.interactivity, {
    is_enabled: true,
    request_url: "https://api.acme.example/v1/integrations/slack/acme/interactions",
  })
})

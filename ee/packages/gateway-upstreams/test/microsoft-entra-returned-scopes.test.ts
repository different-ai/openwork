import assert from "node:assert/strict"
import { test } from "node:test"
import { readMicrosoftTokens } from "../src/microsoft-entra.js"

const appId = "11111111-2222-4333-8444-555555555555"
const otherAppId = "66666666-7777-4888-8999-aaaaaaaaaaaa"
const scope = `api://${appId}/access`

function response(scope?: unknown) {
  return { access_token: "access-token-fixture", token_type: "Bearer", expires_in: 3600, ...(scope === undefined ? {} : { scope }) }
}

test("custom API scopes preserve permission case and do not infer GUID resource aliases", () => {
  for (const requested of [scope, `${appId}/access`]) {
    for (const returned of [requested, `openid profile ${requested}`]) {
      assert.ok(readMicrosoftTokens(response(returned), requested), `${requested}: ${returned}`)
    }
    const alias = requested.startsWith("api://") ? `${appId}/access` : scope
    for (const returned of [alias, requested.toUpperCase(), `${otherAppId}/access`, `api://${otherAppId}/access`, "access", "openid profile", `${appId}/other`, `${scope}/nested`, `https://${appId}/access`]) {
      assert.equal(readMicrosoftTokens(response(returned), requested), null, `${requested}: ${returned}`)
    }
  }
})

test("custom App ID URI resources are not guessed from a hostname or a GUID inside their path", () => {
  for (const resource of ["https://models.example.com/api", "api://models.example.com/api", `https://models.example.com/${appId}`, `api://models.example.com/${appId}`]) {
    assert.ok(readMicrosoftTokens(response(`${resource}/access`), `${resource}/access`))
    assert.ok(readMicrosoftTokens(response(`${resource}/models.read`), `${resource}/.default`))
    for (const returned of [`${appId}/access`, `api://${appId}/access`, "access", `${resource}.evil/access`, `${resource}/nested/access`, `${resource}/`]) {
      assert.equal(readMicrosoftTokens(response(returned), `${resource}/.default`), null, `${resource}: ${returned}`)
    }
    assert.equal(readMicrosoftTokens(response(`${resource}/other`), `${resource}/access`), null)
  }
})

test("default requests accept individual scopes for the exact configured resource format", () => {
  for (const resource of [`api://${appId}`, appId]) {
    const requested = `${resource}/.default`
    for (const returned of [`${resource}/access`, `${resource}/models.read`, `openid ${resource}/access ${resource}/models.read`]) {
      assert.ok(readMicrosoftTokens(response(returned), requested), `${requested}: ${returned}`)
    }
    for (const returned of [`${appId}/`, `api://${otherAppId}/access`, `${scope}/nested`, "openid profile"]) {
      assert.equal(readMicrosoftTokens(response(returned), requested), null, `${requested}: ${returned}`)
    }
  }
})

test("custom resource paths and delegated permissions are case-sensitive; scheme, host and GUID case may vary", () => {
  for (const resource of ["https://Models.example.com/API", "api://Models.example.com/API"]) {
    const requested = `${resource}/Access`
    assert.ok(readMicrosoftTokens(response(`${resource.replace("Models", "models")}/Access`), requested))
    assert.equal(readMicrosoftTokens(response(`${resource}/access`), requested), null)
    assert.equal(readMicrosoftTokens(response(`${resource.replace("API", "api")}/Access`), requested), null)
    assert.equal(readMicrosoftTokens(response(`${resource.replace("API", "api")}/Access`), `${resource}/.default`), null)
  }
  assert.ok(readMicrosoftTokens(response(`API://${otherAppId.toUpperCase()}/access`), `api://${otherAppId}/access`))
  assert.ok(readMicrosoftTokens(response(`${otherAppId.toUpperCase()}/access`), `${otherAppId}/access`))
})

test("missing scope metadata remains optional, but malformed or unrelated metadata fails closed", () => {
  assert.ok(readMicrosoftTokens(response(), scope))
  for (const returned of [null, 1, [], {}, "", " ", "https://graph.microsoft.com/User.Read", "https://cognitiveservices.azure.com/user_impersonation"]) {
    assert.equal(readMicrosoftTokens(response(returned), scope), null, JSON.stringify(returned))
  }
})

test("Foundry continues to accept Cognitive Services individual scopes and absent metadata only", () => {
  assert.ok(readMicrosoftTokens(response()))
  assert.ok(readMicrosoftTokens(response("https://cognitiveservices.azure.com/user_impersonation")))
  assert.ok(readMicrosoftTokens(response("openid https://cognitiveservices.azure.com/.default")))
  for (const returned of [scope, `${appId}/access`, "https://graph.microsoft.com/User.Read", "https://cognitiveservices.azure.com.evil/access", "openid profile", "", null]) {
    assert.equal(readMicrosoftTokens(response(returned)), null, JSON.stringify(returned))
  }
})

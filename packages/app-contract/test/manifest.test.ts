import { describe, expect, test } from "bun:test"

import type { AppContribution } from "../src/contributions.js"
import type { AppManifest } from "../src/manifest.js"
import type { AppPermission } from "../src/permissions.js"
import { stringifyJsonCanonical } from "../src/json.js"
import { checkCompatibility, validateManifest, type Diagnostic } from "../src/validate.js"
import { clone, validManifest } from "./fixtures.js"

function codes(diagnostics: readonly Diagnostic[]): string[] {
  return diagnostics.filter((entry) => entry.severity === "error").map((entry) => entry.code)
}

function contributionOf<T extends AppContribution["type"]>(
  manifest: AppManifest,
  type: T,
): Extract<AppContribution, { type: T }> {
  const found = manifest.contributions.find(
    (contribution): contribution is Extract<AppContribution, { type: T }> => contribution.type === type,
  )
  if (!found) throw new Error(`fixture is missing a ${type} contribution`)
  return found
}

function permissionOf<T extends AppPermission["id"]>(
  manifest: AppManifest,
  id: T,
): Extract<AppPermission, { id: T }> {
  const found = manifest.permissions.find(
    (permission): permission is Extract<AppPermission, { id: T }> => permission.id === id,
  )
  if (!found) throw new Error(`fixture is missing the ${id} permission`)
  return found
}

function firstRequiredEnv(manifest: AppManifest) {
  const found = manifest.environment.required[0]
  if (!found) throw new Error("fixture is missing a required environment variable")
  return found
}

/** Mutate the valid manifest and assert the validator refuses it with a specific code. */
function expectRejected(mutate: (manifest: AppManifest) => void, code: string) {
  const manifest = clone(validManifest())
  mutate(manifest)
  const result = validateManifest(manifest)
  expect(result.ok).toBe(false)
  expect(codes(result.diagnostics)).toContain(code)
}

/** Compile the manifest, asserting it validates, so compatibility tests start from a real manifest. */
function compiled(mutate: (manifest: AppManifest) => void = () => {}): AppManifest {
  const manifest = clone(validManifest())
  mutate(manifest)
  const result = validateManifest(manifest)
  if (!result.ok) throw new Error(codes(result.diagnostics).join(", "))
  return result.manifest
}

describe("valid manifest", () => {
  test("the reference manifest validates with no diagnostics", () => {
    const result = validateManifest(validManifest())
    expect(result.ok).toBe(true)
    expect(result.diagnostics).toEqual([])
  })

  test("it validates identically from raw JSON text", () => {
    const result = validateManifest(stringifyJsonCanonical(validManifest()))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.manifest.id).toBe("com.openworklabs.station")
  })
})

describe("document-level failures", () => {
  test("malformed JSON is reported, not thrown", () => {
    const result = validateManifest("{ not json")
    expect(result.ok).toBe(false)
    expect(codes(result.diagnostics)).toEqual(["manifest.invalid_json"])
  })

  test("a duplicate key is rejected rather than silently last-wins", () => {
    const result = validateManifest('{"manifest_version": 1, "id": "a.b", "id": "c.d"}')
    expect(result.ok).toBe(false)
    expect(result.diagnostics[0]?.message).toContain("duplicate key")
  })

  test("an unsupported manifest_version fails alone, without field noise", () => {
    const result = validateManifest({ manifest_version: 2, id: "a.b" })
    expect(result.ok).toBe(false)
    expect(codes(result.diagnostics)).toEqual(["manifest.unsupported_version"])
  })

  test("a missing manifest_version is a field error", () => {
    const manifest: Record<string, unknown> = { ...clone(validManifest()) }
    delete manifest.manifest_version
    expect(validateManifest(manifest).ok).toBe(false)
  })

  test("an unknown top-level field is rejected", () => {
    expectRejected((manifest) => {
      Object.assign(manifest, { run_command: "npm start" })
    }, "manifest.unknown_field")
  })

  test("an unknown field inside a permission is rejected, not silently stripped", () => {
    expectRejected((manifest) => {
      Object.assign(permissionOf(manifest, "audio.microphone"), { allow_shell: true })
    }, "manifest.unknown_field")
  })

  test("an unknown field inside a contribution is rejected", () => {
    expectRejected((manifest) => {
      Object.assign(contributionOf(manifest, "surface"), { node_integration: true })
    }, "manifest.unknown_field")
  })
})

describe("identity", () => {
  test("a single-segment app id is rejected so it cannot shadow a built-in extension", () => {
    expectRejected((manifest) => {
      manifest.id = "openwork-voice"
    }, "manifest.invalid_field")
  })

  test("an uppercase app id is rejected", () => {
    expectRejected((manifest) => {
      manifest.id = "com.OpenworkLabs.station"
    }, "manifest.invalid_field")
  })

  test("a non-semver version is rejected", () => {
    expectRejected((manifest) => {
      manifest.version = "1.0"
    }, "manifest.invalid_field")
  })

  test("a non-GitHub repository URL is rejected", () => {
    expectRejected((manifest) => {
      manifest.repository = "https://gitlab.com/someone/app"
      manifest.distribution.repository = "https://gitlab.com/someone/app"
    }, "manifest.invalid_field")
  })

  test("an http repository URL is rejected", () => {
    expectRejected((manifest) => {
      manifest.repository = "http://github.com/different-ai/openwork-station"
    }, "manifest.invalid_field")
  })
})

describe("contribution integrity", () => {
  test("duplicate contribution ids are rejected across types", () => {
    expectRejected((manifest) => {
      manifest.contributions.push({ type: "command", id: "station", title: "Collides with the surface" })
    }, "contribution.duplicate_id")
  })

  test("a sidebar item pointing at a missing surface is rejected", () => {
    expectRejected((manifest) => {
      contributionOf(manifest, "right_sidebar_item").surface = "does-not-exist"
    }, "contribution.dangling_reference")
  })

  test("a surface pointing at a missing entrypoint is rejected", () => {
    expectRejected((manifest) => {
      contributionOf(manifest, "surface").entrypoint = "ghost"
    }, "contribution.missing_entrypoint")
  })

  test("an entrypoint no contribution uses is rejected", () => {
    expectRejected((manifest) => {
      manifest.entrypoints.surfaces.hidden = "dist/hidden/index.html"
    }, "entrypoint.unreferenced")
  })

  test("a background entrypoint with no background contribution is rejected", () => {
    expectRejected((manifest) => {
      manifest.contributions = manifest.contributions.filter(
        (contribution) => contribution.type !== "background",
      )
    }, "entrypoint.unreferenced")
  })

  test("a background contribution with no entrypoint is rejected", () => {
    expectRejected((manifest) => {
      delete manifest.entrypoints.background
    }, "entrypoint.missing_background")
  })

  test("a shortcut bound to a missing command is rejected", () => {
    expectRejected((manifest) => {
      contributionOf(manifest, "shortcut").command = "nope"
    }, "contribution.dangling_reference")
  })

  test("a status targeting a non-sidebar contribution is rejected", () => {
    expectRejected((manifest) => {
      contributionOf(manifest, "status").target = "station"
    }, "contribution.dangling_reference")
  })

  test("a min_size larger than the default size is rejected", () => {
    expectRejected((manifest) => {
      contributionOf(manifest, "surface").min_size = { width: 900, height: 900 }
    }, "contribution.invalid_size")
  })

  test("a path escaping the package is rejected", () => {
    expectRejected((manifest) => {
      manifest.icons.default = "../../etc/passwd"
    }, "manifest.invalid_field")
  })

  test("an absolute entrypoint path is rejected", () => {
    expectRejected((manifest) => {
      manifest.entrypoints.surfaces.station = "/etc/passwd"
    }, "manifest.invalid_field")
  })
})

describe("permission integrity", () => {
  test("an unknown permission id is rejected", () => {
    expectRejected((manifest) => {
      manifest.permissions.push({ id: "shell.exec", reason: "run a build" } as unknown as AppPermission)
    }, "manifest.invalid_field")
  })

  test("a duplicated permission is rejected rather than merged", () => {
    expectRejected((manifest) => {
      manifest.permissions.push({
        id: "network.host",
        reason: "also reach somewhere else",
        hosts: ["evil.example.com"],
      })
    }, "permission.duplicate")
  })

  test("a wildcard network host is rejected", () => {
    expectRejected((manifest) => {
      permissionOf(manifest, "network.host").hosts = ["*.openai.com"]
    }, "manifest.invalid_field")
  })

  test("a network host carrying a scheme or path is rejected", () => {
    expectRejected((manifest) => {
      permissionOf(manifest, "network.host").hosts = ["https://api.openai.com/v1"]
    }, "manifest.invalid_field")
  })

  test("an unknown Connect scope is rejected", () => {
    expectRejected((manifest) => {
      const connect = permissionOf(manifest, "openwork.connect.read")
      connect.scopes = ["slack.delete"] as unknown as typeof connect.scopes
    }, "manifest.invalid_field")
  })

  test("a floating surface without the floating-surface permission is rejected", () => {
    expectRejected((manifest) => {
      manifest.permissions = manifest.permissions.filter(
        (permission) => permission.id !== "desktop.floatingSurface",
      )
    }, "contribution.permission_missing")
  })

  test("a global shortcut absent from the permission is rejected", () => {
    expectRejected((manifest) => {
      permissionOf(manifest, "desktop.globalShortcut").shortcuts = [
        { id: "some-other-shortcut", default_accelerator: "CommandOrControl+K" },
      ]
    }, "contribution.permission_missing")
  })

  test("a permission listing a shortcut that is not a contribution is rejected", () => {
    expectRejected((manifest) => {
      permissionOf(manifest, "desktop.globalShortcut").shortcuts.push({
        id: "phantom",
        default_accelerator: "CommandOrControl+J",
      })
    }, "permission.dangling_shortcut")
  })

  test("realtime AI without a network host is rejected", () => {
    expectRejected((manifest) => {
      manifest.permissions = manifest.permissions.filter(
        (permission) => permission.id !== "network.host",
      )
      manifest.privacy.third_parties = []
    }, "permission.unreachable_capability")
  })

  test("an invalid accelerator is rejected", () => {
    expectRejected((manifest) => {
      const shortcut = permissionOf(manifest, "desktop.globalShortcut").shortcuts[0]
      if (shortcut) shortcut.default_accelerator = "Meta+++"
    }, "manifest.invalid_field")
  })
})

describe("privacy disclosure", () => {
  test("a disclosed third-party host must be covered by network.host", () => {
    expectRejected((manifest) => {
      manifest.privacy.third_parties.push({
        name: "Analytics",
        host: "telemetry.example.com",
        purpose: "usage stats",
      })
    }, "privacy.undeclared_host")
  })

  test("requesting the microphone without disclosing audio is rejected", () => {
    expectRejected((manifest) => {
      manifest.privacy.data_handled = ["transcripts", "connected-source-content"]
    }, "privacy.incomplete_disclosure")
  })

  test("requesting Connect reads without disclosing them is rejected", () => {
    expectRejected((manifest) => {
      manifest.privacy.data_handled = ["microphone-audio", "transcripts"]
    }, "privacy.incomplete_disclosure")
  })

  test('"none" cannot be combined with real data categories', () => {
    expectRejected((manifest) => {
      manifest.privacy.data_handled = ["none", "microphone-audio", "connected-source-content"]
    }, "privacy.contradictory_disclosure")
  })
})

describe("distribution", () => {
  test("distributing from a different repository is rejected", () => {
    expectRejected((manifest) => {
      manifest.distribution.repository = "https://github.com/someone-else/mirror"
    }, "distribution.repository_mismatch")
  })

  test("a non-.owapp asset is rejected", () => {
    expectRejected((manifest) => {
      manifest.distribution.asset = "openwork-station-{version}.zip"
    }, "manifest.invalid_field")
  })

  test("an asset with a path separator is rejected", () => {
    expectRejected((manifest) => {
      manifest.distribution.asset = "releases/openwork-station.owapp"
    }, "manifest.invalid_field")
  })
})

describe("engines and platforms", () => {
  test("an empty engine range is rejected", () => {
    expectRejected((manifest) => {
      manifest.engines.app_api = { min: "2.0.0", max_exclusive: "1.0.0" }
    }, "engine.empty_range")
  })

  test("a duplicated platform is rejected", () => {
    expectRejected((manifest) => {
      manifest.platforms = [
        { os: "darwin", arch: ["arm64"] },
        { os: "darwin", arch: ["x64"] },
      ]
    }, "platform.duplicate")
  })

  test("a host below the engine minimum is incompatible", () => {
    const manifest = compiled((draft) => {
      draft.engines.openwork = { min: "9.0.0" }
    })
    const compatibility = checkCompatibility(manifest, {
      openworkVersion: "1.2.3",
      os: "darwin",
      arch: "arm64",
    })
    expect(compatibility.compatible).toBe(false)
    if (!compatibility.compatible) expect(compatibility.reason).toBe("engine_incompatible")
  })

  test("a host at the exclusive App API maximum is incompatible", () => {
    const compatibility = checkCompatibility(compiled(), {
      openworkVersion: "1.0.0",
      appApiVersion: "2.0.0",
      os: "darwin",
      arch: "arm64",
    })
    expect(compatibility.compatible).toBe(false)
    if (!compatibility.compatible) expect(compatibility.reason).toBe("app_api_incompatible")
  })

  test("an unsupported operating system is incompatible", () => {
    const compatibility = checkCompatibility(compiled(), {
      openworkVersion: "1.0.0",
      os: "win32",
      arch: "x64",
    })
    expect(compatibility.compatible).toBe(false)
    if (!compatibility.compatible) expect(compatibility.reason).toBe("platform_unsupported")
  })

  test("an unsupported architecture on a supported OS is incompatible", () => {
    const manifest = compiled((draft) => {
      draft.platforms = [{ os: "darwin", arch: ["arm64"] }]
    })
    const compatibility = checkCompatibility(manifest, {
      openworkVersion: "1.0.0",
      os: "darwin",
      arch: "x64",
    })
    expect(compatibility.compatible).toBe(false)
    if (!compatibility.compatible) expect(compatibility.reason).toBe("platform_unsupported")
  })

  test("a supported host is compatible", () => {
    expect(
      checkCompatibility(compiled(), {
        openworkVersion: "1.4.0",
        appApiVersion: "1.0.0",
        os: "darwin",
        arch: "arm64",
      }).compatible,
    ).toBe(true)
  })
})

describe("environment requirements", () => {
  test("a reserved OPENWORK_ key is rejected", () => {
    expectRejected((manifest) => {
      firstRequiredEnv(manifest).key = "OPENWORK_API_KEY"
    }, "manifest.invalid_field")
  })

  test("a reserved OPENCODE_ key is rejected", () => {
    expectRejected((manifest) => {
      firstRequiredEnv(manifest).key = "OPENCODE_CONFIG"
    }, "manifest.invalid_field")
  })

  test("a lowercase environment key is rejected", () => {
    expectRejected((manifest) => {
      firstRequiredEnv(manifest).key = "openai_api_key"
    }, "manifest.invalid_field")
  })

  test("the same key in required and optional is rejected", () => {
    expectRejected((manifest) => {
      manifest.environment.optional = [{ key: "OPENAI_API_KEY", label: "OpenAI API key" }]
    }, "environment.duplicate_key")
  })
})

// Every URL in a manifest is attacker-controlled, and the trust screen renders
// some of them as links. The scheme is not the manifest's to choose.
describe("manifest URLs are https only", () => {
  for (const url of [
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "file:///etc/passwd",
    "vbscript:msgbox(1)",
    "http://example.com/docs",
    " https://example.com/docs",
    "HTTPS://example.com/docs",
  ]) {
    test(`docs_url rejects ${JSON.stringify(url)}`, () => {
      expectRejected((manifest) => {
        manifest.environment.required = [
          { key: "OPENAI_API_KEY", label: "OpenAI API key", docs_url: url },
        ]
      }, "manifest.invalid_field")
    })
  }

  test("an https docs_url is accepted", () => {
    const manifest = compiled((draft) => {
      draft.environment.required = [
        {
          key: "OPENAI_API_KEY",
          label: "OpenAI API key",
          docs_url: "https://platform.openai.com/api-keys",
        },
      ]
    })
    expect(manifest.environment.required[0]?.docs_url).toBe("https://platform.openai.com/api-keys")
  })

  test("a publisher url must be https too", () => {
    expectRejected((manifest) => {
      manifest.publisher = { name: "OpenWork Labs", url: "javascript:alert(1)" }
    }, "manifest.invalid_field")
  })
})

// `network.host` is the allowlist the sandbox enforces, so an entry is a grant to
// reach something. Loopback reaches OpenWork's own server, a private range reaches
// the user's LAN, and 169.254.169.254 reaches cloud instance metadata.
describe("network.host cannot name the user's own machine or network", () => {
  for (const host of [
    "127.0.0.1",
    "0.0.0.0",
    "10.0.0.5",
    "192.168.1.1",
    "169.254.169.254",
    "app.localhost",
    "printer.local",
    "metadata.internal",
    "db.home.arpa",
  ]) {
    test(`rejects ${host}`, () => {
      expectRejected((manifest) => {
        manifest.permissions = [{ id: "network.host", reason: "Reach it.", hosts: [host] }]
      }, "manifest.invalid_field")
    })
  }

  test("a public hostname is still accepted", () => {
    const manifest = compiled((draft) => {
      draft.permissions = [
        ...draft.permissions.filter((entry) => entry.id !== "network.host"),
        { id: "network.host", reason: "Reach the model.", hosts: ["api.openai.com"] },
      ]
      draft.privacy.third_parties = [
        { name: "OpenAI", host: "api.openai.com", purpose: "Inference." },
      ]
    })
    expect(manifest.permissions.some((entry) => entry.id === "network.host")).toBe(true)
  })
})

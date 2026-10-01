import { RuntimeProviderError, type SandboxHandle, type SandboxProvider } from "@openwork-ee/cloud-runtime/contract"
import { createFakeProvider, type FakeProvider } from "@openwork-ee/cloud-runtime/testing"
import { describe, expect, test } from "bun:test"
import { isCloudBrowserError, type BrowserKey } from "../contract"
import { chromeLaunchScript, createDaytonaBrowserHost, daytonaBrowserSandboxName, DEFAULT_DAYTONA_PROFILE_DIR } from "./daytona"

const member: BrowserKey = { organizationId: "org_01", memberId: "om_01" }

/** A fake Daytona: sandboxes from the fake provider, Chrome "running" once the launch script ran. */
function setup(options: { touch?: boolean; wrap?: (provider: FakeProvider) => SandboxProvider } = {}) {
  const chromeUp = new Set<string>()
  const provider: FakeProvider = createFakeProvider({
    id: "daytona",
    onExec: ({ sandboxId, spec }) => {
      if (spec.command?.includes("setsid nohup")) chromeUp.add(sandboxId)
      return { exitCode: 0 }
    },
  })
  const touched: string[] = []
  const wrapped = options.wrap ? options.wrap(provider) : provider
  const withTouch: SandboxProvider = options.touch
    ? { ...wrapped, touch: async (handle: SandboxHandle) => { touched.push(handle.ref.ref.sandboxId ?? "") } }
    : wrapped
  const probes: string[] = []
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    probes.push(url.pathname)
    const sandboxId = url.hostname.split(".")[0] ?? ""
    const sandbox = provider.fake.sandboxes().find((record) => record.id === sandboxId)
    if (new Headers(init?.headers).get("x-daytona-skip-preview-warning") !== "true") return new Response("warning page", { status: 200 })
    if (!sandbox || sandbox.state !== "running" || !chromeUp.has(sandboxId)) throw new TypeError("fetch failed")
    return Response.json({ Browser: "Chrome/140", webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/abc" })
  }
  const clock = { now: Date.now() }
  const host = createDaytonaBrowserHost({ provider: withTouch, snapshot: "openwork-cloud-browser-1", fetch: fetchImpl, pollIntervalMs: 1, sleep: async () => undefined, now: () => clock.now })
  return { provider, host, chromeUp, probes, touched, clock }
}

describe("daytona cloud browser host", () => {
  test("names are deterministic per member and never reveal ids", () => {
    const name = daytonaBrowserSandboxName(member)
    expect(name).toMatch(/^owb-[0-9a-f]{24}$/)
    expect(daytonaBrowserSandboxName(member)).toBe(name)
    expect(daytonaBrowserSandboxName({ ...member, memberId: "om_02" })).not.toBe(name)
    expect(name).not.toContain("om_01")
    expect(daytonaBrowserSandboxName(member, "owb-staging")).toMatch(/^owb-staging-[0-9a-f]{24}$/)
  })

  test("peek never creates, starts or launches anything", async () => {
    const { provider, host } = setup()
    expect(await host.peek(member)).toBeNull()
    expect(provider.fake.count("create")).toBe(0)
    provider.fake.seed({ idempotencyKey: daytonaBrowserSandboxName(member), state: "stopped" })
    expect(await host.peek(member)).toBeNull()
    expect(provider.fake.count("start")).toBe(0)
    expect(provider.fake.count("exec")).toBe(0)
  })

  test("open creates a private, persistent sandbox from the snapshot and launches Chrome", async () => {
    const { provider, host } = setup()
    const endpoint = await host.open(member)
    const sandbox = provider.fake.sandbox(daytonaBrowserSandboxName(member))
    expect(sandbox?.spec).toMatchObject({
      image: { id: "openwork-cloud-browser-1", version: "openwork-cloud-browser-1" },
      public: false,
      lifecycle: { autoStopMinutes: 15, autoArchiveMinutes: 10_080, autoDeleteMinutes: -1 },
      labels: { "openwork.cloud-browser": "1", "openwork.organization-id": "org_01", "openwork.member-id": "om_01" },
    })
    expect(sandbox?.execs).toHaveLength(1)
    expect(endpoint.cdpUrl).toBe(`http://${sandbox?.id}.daytona.invalid:9222`)
    expect(endpoint.headers).toEqual({ "X-Daytona-Skip-Preview-Warning": "true" })
    expect(endpoint.expiresAt).toBeInstanceOf(Date)
  })

  test("a warm open reuses the endpoint without calling the Daytona API", async () => {
    const { provider, host } = setup()
    await host.open(member)
    const calls = provider.fake.calls.length
    await host.open(member)
    await host.peek(member)
    expect(provider.fake.calls.length).toBe(calls)
  })

  test("a stopped sandbox is started (not recreated) and Chrome relaunched; the profile disk is kept", async () => {
    const { provider, host, chromeUp, clock } = setup()
    await host.open(member)
    const sandbox = provider.fake.sandbox(daytonaBrowserSandboxName(member))
    if (!sandbox) throw new Error("missing sandbox")
    // Idle auto-stop: the disk stays, Chrome does not.
    provider.fake.setState(sandbox.id, "stopped")
    chromeUp.delete(sandbox.id)
    // A liveness probe is trusted for a few seconds, then checked again.
    clock.now += 5_000
    expect(await host.peek(member)).toBeNull()
    await host.open(member)
    expect(provider.fake.count("create")).toBe(1)
    expect(provider.fake.count("start")).toBe(1)
    expect(sandbox.execs).toHaveLength(2)
  })

  test("concurrent opens on one replica share a single start", async () => {
    const { provider, host } = setup()
    const [a, b] = await Promise.all([host.open(member), host.open(member)])
    expect(a.cdpUrl).toBe(b.cdpUrl)
    expect(provider.fake.count("create")).toBe(1)
  })

  test("a sandbox another replica just created is adopted", async () => {
    let racedId = ""
    const { provider, host } = setup({ wrap: (fake) => createFakeProviderRace(fake, () => racedId) })
    racedId = provider.fake.seed({ idempotencyKey: daytonaBrowserSandboxName(member), state: "running", hidden: true }).id
    const endpoint = await host.open(member)
    expect(endpoint.cdpUrl).toContain(racedId)
    expect(provider.fake.sandboxes()).toHaveLength(1)
  })

  test("Daytona outages become retryable errors without leaking provider details", async () => {
    const provider = createFakeProvider({
      id: "daytona",
      onOperation: (operation) => {
        if (operation.name === "create") throw new RuntimeProviderError({ providerId: "daytona", code: "capacity", message: "quota exceeded for org 123" })
      },
    })
    const host = createDaytonaBrowserHost({ provider, snapshot: "s", sleep: async () => undefined })
    const error = await host.open(member).then(() => null, (caught: unknown) => caught)
    expect(isCloudBrowserError(error) && error.code).toBe("browser_unavailable")
    expect(isCloudBrowserError(error) && error.message).not.toContain("123")
  })

  test("use counts as activity, at most once a minute", async () => {
    const { host, touched } = setup({ touch: true })
    await host.open(member)
    await host.open(member)
    await host.peek(member)
    expect(touched).toHaveLength(1)
  })

  test("stop stops the sandbox and never deletes it", async () => {
    const { provider, host } = setup()
    await host.open(member)
    await host.stop?.(member)
    expect(provider.fake.sandbox(daytonaBrowserSandboxName(member))?.state).toBe("stopped")
    expect(provider.fake.count("destroy")).toBe(0)
  })

  test("the launch script starts Chrome fully detached and only once", () => {
    const script = chromeLaunchScript({ profileDir: DEFAULT_DAYTONA_PROFILE_DIR, port: 9222, windowSize: { width: 1280, height: 800 } })
    expect(script).toContain("setsid nohup \"$CHROME\"")
    expect(script).toContain("</dev/null &")
    expect(script).toContain("'--remote-debugging-port=9222'")
    expect(script).toContain("'--user-data-dir=/home/daytona/.openwork/browser-profile'")
    expect(script).toContain("'--password-store=basic'")
    expect(script).toContain("'--headless=new'")
    expect(script.indexOf("curl -fsS")).toBeLessThan(script.indexOf("setsid"))
    expect(script.indexOf("pgrep -x")).toBeLessThan(script.indexOf("rm -f"))
    // Matching command lines would also match the shell running this script.
    expect(script).not.toContain("pgrep -f")
  })
})

/** The first `find` misses a sandbox that a different replica is creating; `create` then conflicts. */
function createFakeProviderRace(provider: FakeProvider, sandboxId: () => string): SandboxProvider {
  return {
    ...provider,
    async create(spec, opts) {
      provider.fake.setVisible(sandboxId(), true)
      return provider.create(spec, opts)
    },
  }
}

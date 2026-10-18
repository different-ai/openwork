import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { appPresentation, APP_FALLBACK, APP_REPLY, APP_REQUEST, APP_RESOURCE } from "../worlds/app-presentation.ts";

const test = spec.world(appPresentation, {
  timeout: 300_000,
  resources: { surfaces: ["appWeb"], services: ["mock"] },
  needs: { commands: ["bun", "opencode"] },
});

test("a member's generated App recovers from missing bootstrap data without being torn down", async ({ world, user, probe, step, evidence }) => {
  await user.resizeViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  world.scenario("bootstrap");
  let recoveredResolutions = 0;
  await step("the member publishes a real generated view that reads its result before launch data exists", async () => {
    await user.type("composer", APP_REQUEST);
    await user.click("Run task");
    await user.see({ role: "button", label: "Open preview" }, { timeoutMs: 60_000 });
    const panes = (await probe.dom("[data-built-app-preview]")).elements.length;
    expect(panes).toBe(0);
    evidence.recordAssertionEvidence("The generated bootstrap case waits for the member's Open action", `panes=${panes}; no synthetic renderer state or log messages`, panes === 0);
    await user.screenshot();
  });
  await step("after: the bootstrap throw is observed but the same view receives launch data and recovers", async () => {
    await user.click({ role: "button", label: "Open preview" });
    await user.see({ role: "heading", text: "Project checklist", mcpApp: { resourceUri: APP_RESOURCE } }, { timeoutMs: 20_000 });
    await user.see({ text: "Connected" });
    await user.notSee({ role: "button", label: /^Retry$/ });
    const geometry = await world.geometry();
    const bootstrap = geometry.timings.filter(mark => mark.name === "openwork.mcp-app.bootstrap-render-observed");
    const resolutions = world.resolutions();
    expect(bootstrap.length).toBeGreaterThan(0);
    expect(resolutions.length).toBeGreaterThan(0);
    expect(world.bootstrapDelayedDocuments()).toBeGreaterThan(0);
    recoveredResolutions = resolutions.length;
    // Development StrictMode can dispatch a canceled discovery before the
    // retained subscriber. Prove the recovered widget's state, not a blanket
    // single-request assumption that is unrelated to bootstrap recovery.
    await user.click({ role: "button", text: "Mark reviewed", mcpApp: { resourceUri: APP_RESOURCE } });
    await user.see({ role: "heading", text: "Checklist reviewed", mcpApp: { resourceUri: APP_RESOURCE } });
    evidence.recordAssertionEvidence("An actual pre-result React failure recovers into an interactive view without Retry", `proxy documents holding real launch data until actual error=${world.bootstrapDelayedDocuments()}; bootstrap events=${bootstrap.length}; observed resource attempts=${resolutions.length}; member marked the checklist reviewed; no Retry; counts are not latency`, bootstrap.length > 0 && resolutions.length > 0 && world.bootstrapDelayedDocuments() > 0);
    await user.screenshot();
  });
  await step("the assistant can finish without replacing the recovered view", async () => {
    await world.releaseReply();
    await user.see({ text: APP_REPLY });
    await user.see({ role: "heading", text: "Checklist reviewed", mcpApp: { resourceUri: APP_RESOURCE } });
    const resolutions = world.resolutions();
    expect(resolutions).toHaveLength(recoveredResolutions);
    evidence.recordAssertionEvidence("The member's reviewed state survives the final message without another resource read", `resource attempts before=${recoveredResolutions}, after=${resolutions.length}; Checklist reviewed is still visible`, resolutions.length === recoveredResolutions);
    await user.screenshot();
  });
});

test("a member's saved fallback is masked after access is denied but retained during an ordinary sign-in outage", async ({ world, user, probe, step, evidence }) => {
  await user.resizeViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  const useful = () => user.see({ role: "heading", text: "Project checklist", mcpApp: { resourceUri: APP_RESOURCE } }, { timeoutMs: 20_000 });
  const fallbackCount = async () => (await probe.dom("[data-mcp-app-fallback]")).elements.length;
  await step("the member opens a published view whose authored fallback is available", async () => {
    await user.type("composer", APP_REQUEST);
    await user.click("Run task");
    await user.see({ role: "button", label: "Open preview" }, { timeoutMs: 60_000 });
    await user.click({ role: "button", label: "Open preview" });
    await useful();
    await user.see({ text: APP_FALLBACK });
    const available = await fallbackCount();
    expect(available).toBe(1);
    evidence.recordAssertionEvidence("The valid authored summary supplies readable saved text", `fallbacks=${available}; interactive view uses a read-only local provider fixture`, available === 1);
    await user.screenshot();
  });
  await step("a fresh sign-in requirement on reopen keeps the saved fallback available", async () => {
    await user.click("Close panel");
    world.scenario("auth-outage");
    await user.click({ role: "button", label: "Open preview" });
    await user.see({ text: "Unavailable" });
    await user.see({ role: "button", label: /^Retry$/ });
    await user.see({ text: APP_FALLBACK });
    expect(world.resolutions().at(-1)?.scenario).toBe("auth-outage");
    const available = await fallbackCount();
    evidence.recordAssertionEvidence("An authentication outage is not an authoritative access removal", `HTTP 401 mcp_auth_required; fallback count=${available}`, available === 1);
    await user.screenshot();
    world.scenario("warm");
    await user.click({ role: "button", label: /^Retry$/ });
    await useful();
  });
  await step("after: an authoritative denial on reopen removes both the iframe and saved text", async () => {
    await user.click("Close panel");
    world.scenario("denied");
    await user.click({ role: "button", label: "Open preview" });
    await user.see({ text: "Unavailable" });
    await user.see({ role: "button", label: /^Retry$/ });
    await user.notSee({ text: APP_FALLBACK });
    const frames = (await probe.dom("[data-built-app-preview] iframe")).elements.length;
    const available = await fallbackCount();
    expect(world.resolutions().at(-1)?.scenario).toBe("denied");
    expect(available).toBe(0);
    expect(frames).toBe(0);
    evidence.recordAssertionEvidence("Current permission overrides valid saved tool metadata", `HTTP 403 mcp_access_denied; saved fallback elements=${available}; iframes=${frames}`, available === 0 && frames === 0);
    await user.screenshot();
  });
  await step("a later sign-in outage cannot restore text already known to be revoked", async () => {
    world.scenario("auth-outage");
    await user.click({ role: "button", label: /^Retry$/ });
    await user.see({ text: "Unavailable" });
    await user.notSee({ text: APP_FALLBACK });
    const beforeRemount = world.resolutions().length;
    await user.click("Close panel");
    await user.click({ role: "button", label: "Open preview" });
    await user.see({ text: "Unavailable" });
    await user.notSee({ text: APP_FALLBACK });
    const available = await fallbackCount();
    expect(available).toBe(0);
    expect(world.resolutions()).toHaveLength(beforeRemount);
    evidence.recordAssertionEvidence("Retry and panel remount do not clear a known denial without fresh authorization", `HTTP 401 after known denial; panel closed/reopened; cached transient response made no new resource read (${beforeRemount} before/${world.resolutions().length} after); fallback count=${available}`, available === 0 && world.resolutions().length === beforeRemount);
    await user.screenshot();
  });
  await step("a full page reload still masks saved text when the server can only report a sign-in outage", async () => {
    await world.releaseReply();
    await user.see({ text: APP_REPLY });
    const before = world.resolutions().length;
    await user.reload();
    await user.see({ role: "button", label: "Open preview" }, { timeoutMs: 20_000 });
    await user.click({ role: "button", label: "Open preview" });
    await user.see({ text: "Unavailable" });
    await user.notSee({ text: APP_FALLBACK });
    const available = await fallbackCount();
    const frames = (await probe.dom("[data-built-app-preview] iframe")).elements.length;
    expect(world.resolutions().length).toBeGreaterThan(before);
    expect(world.resolutions().at(-1)?.scenario).toBe("auth-outage");
    expect(available).toBe(0);
    expect(frames).toBe(0);
    evidence.recordAssertionEvidence("Persisted denial survives a new renderer document and a fresh non-authorizing response", `page reloaded; resource reads before=${before}, after=${world.resolutions().length}; latest HTTP401; fallback=${available}; iframes=${frames}`, available === 0 && frames === 0 && world.resolutions().length > before);
    await user.screenshot();
  });
  await step("fresh successful discovery restores the permitted view and fallback", async () => {
    world.scenario("warm");
    await user.click({ role: "button", label: /^Retry$/ });
    await useful();
    await user.see({ text: APP_FALLBACK });
    const available = await fallbackCount();
    expect(available).toBe(1);
    evidence.recordAssertionEvidence("Only a new allowed resource response restores the saved text", `fresh resource authorization and permitted read/recheck completed; fallback count=${available}`, available === 1);
    await user.screenshot();
  });
});

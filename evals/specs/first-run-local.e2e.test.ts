import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { bareFirstRunWorld } from "../worlds/first-run.ts";

const test = spec.world(bareFirstRunWorld);
const prompt = "Create a short welcome checklist for this OpenWork workspace. Use exactly three bullets and mention one thing I can do next.";

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null && !Array.isArray(entry))
    : [];
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

const chatRequests = (snapshot: Record<string, unknown>) => records(snapshot.inference);
const toolNameSet = (value: unknown) => [...new Set(strings(value))].sort();

test("first use without an invite runs through anonymous OpenWork Models with safe renewal and honest limits", async ({ world, user, probe, step, evidence }) => {
  await step("Welcome", async () => {
    await user.see({ text: "Welcome to OpenWork" });
    await user.see("Use Without Cloud");
    await user.notSee({ text: /Something went wrong/ });
  });

  await step("Choose a local folder", async () => {
    await user.click("Use Without Cloud");
    await user.type({ placeholder: "/workspace/my-project" }, world.workspacePath);
    await user.click("Use this folder");
    await user.see({ text: "Power your first task" }, { timeoutMs: 120_000 });
  });

  await step("Finish onboarding", async () => {
    await user.click("Use OpenWork Models");
    await user.see({ text: "How did you hear about OpenWork?" }, { timeoutMs: 90_000 });
    await user.click("Skip");
    await user.see({ text: /What do you need done\?/ }, { timeoutMs: 180_000 });
    await user.see("Run task");
  });

  const composer = await probe.composer();
  expect(composer.route).toContain("/workspace/");
  expect(composer.route).toContain("/session");
  await user.notSee({ text: /Something went wrong/ });
  await user.see({ text: /Using OpenWork Models \(Free\)/ });

  const configured = await world.providerState();
  expect(configured).toMatchObject({
    status: 200,
    exists: true,
    name: "OpenWork Models (Free)",
    model: true,
    localRoute: true,
    localToken: true,
  });
  expect(records((await world.guestWitness()).mints)).toHaveLength(0);
  expect(await world.openedUrls()).toEqual([]);

  await step("Keep OpenCode's built-in providers opt-in", async () => {
    const fresh = await probe.eventually(
      () => world.runtimeProviderState(),
      {
        within: 60_000,
        label: "fresh runtime provider defaults",
        until: (state) => state.configStatus === 200 && state.providersStatus === 200 && state.selectableProviders.includes("openwork-free"),
      },
    );
    expect(fresh.disabledProviders).toEqual(["opencode", "opencode-go"]);
    expect(fresh.connectedProviders).toContain("openwork-free");
    expect(fresh.selectableProviders).toContain("openwork-free");
    expect(fresh.connectedProviders).not.toContain("opencode");
    expect(fresh.connectedProviders).not.toContain("opencode-go");
    expect(fresh.selectableProviders).not.toContain("opencode");
    expect(fresh.selectableProviders).not.toContain("opencode-go");
    expect(fresh.defaultModel).toBe("openwork-free/openai/gpt-5.6-luna");
    evidence.recordAssertionEvidence(
      "A new public desktop defaults to Luna without silently enabling OpenCode's built-in providers",
      JSON.stringify(fresh),
      true,
    );

    const enabledWrite = await world.setRuntimeDisabledProviders(["opencode-go"]);
    expect(enabledWrite).toEqual({ status: 200, disabledProviders: ["opencode-go"] });
    await world.restartEngine();
    const enabled = await probe.eventually(
      () => world.runtimeProviderState(),
      {
        within: 120_000,
        label: "explicit OpenCode opt-in after engine restart",
        until: (state) => state.disabledProviders.length === 1 && state.disabledProviders[0] === "opencode-go" && state.selectableProviders.includes("opencode"),
      },
    );
    expect(enabled.connectedProviders).toContain("opencode");
    expect(enabled.selectableProviders).toContain("opencode");
    expect(enabled.selectableProviders).toContain("openwork-free");
    expect(enabled.connectedProviders).not.toContain("opencode-go");
    expect(enabled.defaultModel).toBe("openwork-free/openai/gpt-5.6-luna");

    const disabledWrite = await world.setRuntimeDisabledProviders(["opencode", "opencode-go"]);
    expect(disabledWrite).toEqual({ status: 200, disabledProviders: ["opencode", "opencode-go"] });
    await world.restartEngine();
    const disabledAgain = await probe.eventually(
      () => world.runtimeProviderState(),
      {
        within: 120_000,
        label: "OpenCode re-disabled after engine restart",
        until: (state) => state.disabledProviders.length === 2 && !state.connectedProviders.includes("opencode") && !state.selectableProviders.includes("opencode"),
      },
    );
    expect(disabledAgain.disabledProviders).toEqual(["opencode", "opencode-go"]);
    expect(disabledAgain.selectableProviders).toContain("openwork-free");
    expect(disabledAgain.connectedProviders).not.toContain("opencode-go");
    expect(disabledAgain.selectableProviders).not.toContain("opencode-go");
    expect(disabledAgain.defaultModel).toBe("openwork-free/openai/gpt-5.6-luna");
    evidence.recordAssertionEvidence(
      "Explicit built-in provider opt-in survives restart and re-disable restores only the requested runtime entries",
      JSON.stringify({ enabledWrite, enabled, disabledWrite, disabledAgain }),
      true,
    );
  });

  await step("Run the first task without cloud sign-in", async () => {
    await user.type("composer", prompt);
    expect((await probe.composer()).runTaskEnabled).toBe(true);
    await user.click("Run task");
    await user.see({ text: prompt }, { timeoutMs: 30_000 });
    const completion = await probe.eventually(async () => {
      const composer = await probe.composer();
      const client = chatRequests(await world.guestWitness());
      return {
        assistantMessageCount: composer.assistantMessageCount,
        failed: client.find((request) => typeof request.status === "number" && request.status >= 400) ?? null,
      };
    }, {
      within: 180_000,
      label: "first anonymous assistant reply or boundary rejection",
      until: (state) => state.assistantMessageCount > 0 || state.failed !== null,
    });
    if (completion.assistantMessageCount === 0) throw new Error(`Anonymous task boundary rejected the SDK request: ${JSON.stringify(completion.failed)}`);
    await user.see({ text: "Anonymous Models are working." }, { timeoutMs: 180_000 });
    await probe.eventually(
      () => probe.composer(),
      { within: 180_000, label: "first anonymous task becomes idle", until: (state) => state.runTaskVisible },
    );
    const witness = await world.guestWitness();
    const mints = records(witness.mints);
    const accepted = chatRequests(witness).filter((request) => request.status === 200 && request.faulted === false);
    expect(mints).toHaveLength(1);
    expect(accepted.length).toBeGreaterThan(0);
    expect(strings(witness.unexpected)).toEqual([]);
    const upstream = records((await world.upstreamWitness()).calls);
    expect(upstream).toHaveLength(accepted.length);
    expect(upstream.every((request) => request.authenticated === "anonymous" && request.model === "openai/gpt-5.6-luna")).toBe(true);
    expect(upstream.every((request) => typeof request.maxTokens === "number" && request.maxTokens <= 4_096 && request.hasPlugins === false)).toBe(true);
    expect(upstream.some((request) => typeof request.toolCount === "number" && request.toolCount > 0)).toBe(true);
    expect(accepted.map((request) => toolNameSet(request.requestedToolNames))).toEqual(upstream.map((request) => toolNameSet(request.toolNames)));
    expect(upstream.every((request) => typeof request.canonicalBytes === "number" && request.canonicalBytes <= 129_024)).toBe(true);
    expect(upstream.filter((request) => request.stream === true).every((request) => JSON.stringify(request.streamOptions) === '{"include_usage":true}')).toBe(true);
    expect(upstream.every((request) => JSON.stringify(request.usage) === '{"include":true}')).toBe(true);
    await user.notSee({ text: /subscribe to Go/i });
    await user.notSee({ text: /Error from provider/ });
    await user.notSee({ text: /Something went wrong/ });
    evidence.recordAssertionEvidence(
      "Luna completes the first real SDK request through the anonymous gateway with the engine's tools intact",
      JSON.stringify({ accepted, upstream }),
      true,
    );
  });

  await step("Renew a rejected guest token with the same installation", async () => {
    const before = await world.guestWitness();
    const successfulBefore = chatRequests(before).filter((request) => request.status === 200).length;
    const assistantBefore = (await probe.composer()).assistantMessageCount;
    await world.expireGuestToken();
    const renewalPrompt = "Confirm the free model still works after renewal.";
    await user.type("composer", renewalPrompt);
    await user.click("Run task");
    await user.see({ text: renewalPrompt }, { timeoutMs: 30_000 });
    await probe.eventually(
      async () => (await probe.composer()).assistantMessageCount,
      { within: 180_000, label: "second assistant reply after guest renewal", until: (count) => count > assistantBefore },
    );
    await probe.eventually(
      () => probe.composer(),
      { within: 180_000, label: "renewed anonymous task becomes idle", until: (state) => state.runTaskVisible },
    );
    const witness = await world.guestWitness();
    const mints = records(witness.mints);
    expect(mints).toHaveLength(2);
    expect(new Set(mints.map((mint) => mint.installationId)).size).toBe(1);
    const rejected = chatRequests(witness).filter((request) => request.status === 401);
    expect(rejected.length).toBeGreaterThan(0);
    expect(new Set(rejected.map((request) => request.bodyHash)).size).toBe(rejected.length);
    expect(chatRequests(witness).filter((request) => request.status === 200).length).toBeGreaterThan(successfulBefore);
    const provider = await world.providerState();
    const serializedProvider = "serialized" in provider && typeof provider.serialized === "string" ? provider.serialized : "";
    expect(serializedProvider).not.toBe("");
    expect(mints.every((mint) => typeof mint.tokenHash === "string")).toBe(true);
    expect(serializedProvider).not.toContain("ow_guest_v1.");
    evidence.recordAssertionEvidence(
      "Anonymous renewal keeps one installation and does not expose guest credentials in provider config",
      JSON.stringify({ mints, rejected, successfulRequests: chatRequests(witness).filter((request) => request.status === 200).length }),
      true,
    );
  });

  await step("Cancel during shared renewal without starting generation", async () => {
    const upstreamBefore = records((await world.upstreamWitness()).calls).filter((request) => request.marker === "cancellation").length;
    const mintsBefore = records((await world.guestWitness()).mints).length;
    await world.nextGuestSession({ delayMs: 2_000 });
    await world.expireGuestToken();
    expect(await world.requestAnonymous({ abortAfterMs: 300, prompt: "fixture:cancellation" })).toMatchObject({ aborted: true, status: 0 });
    await probe.eventually(
      async () => records((await world.guestWitness()).mints).length,
      { within: 10_000, label: "shared guest mint finishes after caller cancellation", until: (count) => count > mintsBefore },
    );
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const cancellationCalls = records((await world.upstreamWitness()).calls).filter((request) => request.marker === "cancellation");
    expect(cancellationCalls).toHaveLength(upstreamBefore);
    evidence.recordAssertionEvidence(
      "Cancellation during shared renewal never reaches generation",
      JSON.stringify({ upstreamBefore, upstreamAfter: cancellationCalls.length }),
      true,
    );
  });

  await step("Fail guest provisioning without starting generation", async () => {
    const upstreamBefore = records((await world.upstreamWitness()).calls).filter((request) => request.marker === "provisioning").length;
    await world.nextGuestSession({ fail: true });
    await world.expireGuestToken();
    expect(await world.requestAnonymous({ prompt: "fixture:provisioning" })).toEqual({ aborted: false, status: 503, code: "anonymous_unavailable" });
    const provisioningCalls = records((await world.upstreamWitness()).calls).filter((request) => request.marker === "provisioning");
    expect(provisioningCalls).toHaveLength(upstreamBefore);
    evidence.recordAssertionEvidence(
      "Failed guest provisioning stops before generation",
      JSON.stringify({ upstreamBefore, upstreamAfter: provisioningCalls.length }),
      true,
    );
  });

  await step("Show quota limits without retrying the hosted model", async () => {
    await world.failGuestRequestsWith("limit");
    const quotaPrompt = "Trigger the deterministic free quota witness.";
    await user.type("composer", quotaPrompt);
    await user.click("Run task");
    await user.see({ text: "OpenWork Models free limit reached" }, { timeoutMs: 180_000 });
    await user.see({ text: /Wait for your free usage to reset/ });
    const limited = chatRequests(await world.guestWitness()).filter((request) => request.status === 429 && request.faulted === true);
    expect(limited.length).toBeGreaterThan(0);
    expect(new Set(limited.map((request) => request.bodyHash)).size).toBe(limited.length);
    evidence.recordAssertionEvidence("The free limit is shown without replaying a request", JSON.stringify(limited), true);
  });

  await step("Distinguish temporary service unavailability", async () => {
    await world.failGuestRequestsWith("unavailable");
    const unavailablePrompt = "Trigger the deterministic unavailable witness.";
    await user.type("composer", unavailablePrompt);
    await user.click("Run task");
    await user.see({ text: "OpenWork Models are temporarily unavailable" }, { timeoutMs: 180_000 });
    await user.see({ text: /use an existing signed-in plan/i });
    const unavailable = chatRequests(await world.guestWitness()).filter((request) => request.status === 503 && request.faulted === true);
    expect(unavailable.length).toBeGreaterThan(0);
    expect(new Set(unavailable.map((request) => request.bodyHash)).size).toBe(unavailable.length);
    evidence.recordAssertionEvidence("Temporary anonymous service failure remains distinct and single-attempt", JSON.stringify(unavailable), true);
  });

  await step("Preserve an explicit local provider through real sign-out", async () => {
    await world.failGuestRequestsWith(null);
    await world.prepareExplicitByokAndSignIn();
    await user.see({ role: "button", label: "Sign out" }, { timeoutMs: 60_000 });
    await user.click({ role: "button", label: "Sign out" });
    await user.notSee({ role: "button", label: "Sign out" }, { timeoutMs: 60_000 });
    const explicit = await probe.eventually(
      () => world.explicitByokState(),
      { within: 60_000, label: "local providers restored after sign-out", until: (state) => state.providerPreserved && state.freeProviderPreserved && state.defaultPreserved && state.disabledProviders.length === 2 },
    );
    expect(explicit).toEqual({
      providerPreserved: true,
      freeProviderPreserved: true,
      defaultPreserved: true,
      disabledProviders: ["opencode", "opencode-go"],
    });
    evidence.recordAssertionEvidence("Explicit BYOK choice survives cloud sign-in and sign-out without enabling built-in providers", JSON.stringify(explicit), true);
  });

  await step("Suppress managed installs with a live server and no guest contact", async () => {
    const managed = await world.managedProviderSuppressed();
    expect(managed).toMatchObject({
      provider: { status: 200, exists: false },
      contacts: 0,
    });
    evidence.recordAssertionEvidence("Managed desktop suppression stays live without anonymous outbound contact", JSON.stringify(managed), true);
  });
});

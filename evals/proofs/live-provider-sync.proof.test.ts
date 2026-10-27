import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { liveProviderSync, type AdminAcknowledgement, type ExpectedProvider, type ManagedModel } from "../worlds/live-provider-sync.ts";

const test = spec.world(liveProviderSync, {
  resources: { surfaces: ["appWeb"], services: ["den"] },
  // The shipping server downloads its pinned verified v2 binary if absent.
  // Requiring opencode2 on PATH skips CI before that installer can run.
  needs: { commands: ["bun"] }, timeout: 480_000,
});

// Each case cold-seeds a new Den/org/member, app profile and real v2 workspace.
// Real authenticated admin API writes are the action, never frontend cache writes.
for (const repetition of [1, 2, 3]) {
  test(`a member's already-open picker follows the full administrator lifecycle in independent cold run ${repetition}`, async ({ world, user, probe, step, evidence }) => {
    let documentIdentity = 0;
    let route = "";
    const latencies: number[] = [];
    const baseline: ExpectedProvider = { id: world.baseline.id, models: [world.initialModel, world.siblingModel], name: world.initialName };
    let extra: Awaited<ReturnType<typeof world.createProvider>> | undefined;
    let extraExpected: ExpectedProvider | undefined;
    let grantId = "";

    async function snapshot(models: ManagedModel[], metadata?: string) {
      const [all, picker, ...rows] = await Promise.all([
        probe.dom(world.pickerRows),
        probe.dom('[data-testid="composer-model-picker"]'),
        ...models.map((model) => probe.dom(`${world.rowSelector(model)} [data-slot="model-label"] > span:first-child`)),
      ]);
      return {
        count: all.elements.length,
        open: picker.elements.length === 1,
        names: rows.map((row) => row.elements.map((element) => element.text)),
        metadata: !metadata || picker.elements.some((element) => element.text.includes(metadata)),
      };
    }
    async function unchanged() {
      expect(await world.documentIdentity()).toBe(documentIdentity);
      expect(await probe.hash()).toBe(route);
      await user.see({ testId: "composer-model-picker" });
    }
    async function observe(update: AdminAcknowledgement, expected: ExpectedProvider[], otherMember: ExpectedProvider[] = [], metadata?: string) {
      // Both identity-scoped reads are genuine Den GETs, not inventory injections.
      // Den aliases/names must match the explicit upstream IDs; cached aliases
      // must also survive removal/regrant and metadata edits unchanged.
      const [models] = await Promise.all([world.catalog("riley", expected), world.catalog("jordan", otherMember)]);
      await probe.eventually(() => snapshot(models, metadata), {
        within: Math.max(1, 5_000 - (Date.now() - update.acknowledgedAt)),
        label: "the same open picker contains exactly the acknowledged organization models",
        until: (value) => value.open && value.metadata && value.count === models.length
          && value.names.every((names, index) => names.length === 1 && names[0] === models[index]?.name),
      });
      const elapsedMs = Date.now() - update.acknowledgedAt;
      expect(elapsedMs).toBeLessThanOrEqual(5_000);
      latencies.push(elapsedMs);
      const result = await snapshot(models, metadata);
      expect(result.count).toBe(models.length);
      expect(result.names).toEqual(models.map((model) => [model.name]));
      expect(result.metadata).toBe(true);
      await unchanged();
      evidence.recordAssertionEvidence("The acknowledged admin change reaches the same open picker within five seconds without duplicates or scope leaks",
        `${update.path} -> ${update.status}; ACK-to-picker ${elapsedMs} ms; exact rows ${models.map((model) => `${model.providerId}:${model.id} = ${model.name} (${model.upstreamId})`).join("; ") || "none"}; other member has only ${otherMember.map((provider) => provider.id).join(", ") || "no providers"}; document, route and open picker unchanged.`, elapsedMs <= 5_000 && result.open && result.count === models.length && result.names.every((names, index) => names.length === 1 && names[0] === models[index]?.name));
      await user.screenshot();
    }
    function added() {
      if (!extra || !extraExpected) throw new Error("The added provider has not been created");
      return { provider: extra, expected: extraExpected };
    }

    await step("before: the member has two assigned sibling models and another member has no access", async () => {
      await user.see("composer", { editable: true });
      await user.click("Change model");
      await probe.eventually(() => world.runtime(), {
        within: 60_000, label: "the signed-in organization runs v2 chat with live provider sync",
        until: (status) => status.chatRouting === true && status.liveProviderSync === true,
      });
      const models = await world.catalog("riley", [baseline]);
      expect(models).toHaveLength(2);
      const otherMember = await world.catalog("jordan", []);
      expect(otherMember).toEqual([]);
      try {
        await probe.eventually(() => snapshot(models), {
          within: 60_000, label: "exactly the two initial managed models are available",
          until: (value) => value.open && value.count === 2 && value.names.every((names, index) => names.length === 1 && names[0] === models[index]?.name),
        });
      } catch (error) {
        throw new Error(`${error instanceof Error ? error.message : String(error)}; native diagnostics ${JSON.stringify(await world.diagnostics())}`);
      }
      documentIdentity = await world.documentIdentity();
      route = await probe.hash();
      evidence.recordAssertionEvidence("A cold real-v2 workspace starts with two exact assigned models and no cross-member access",
        `Cold run ${repetition}; org ${world.organizationId}; ${models.map((model) => `${model.id} = ${model.name}`).join("; ")}; Jordan sees zero providers; periodic sync is 600000 ms.`, models.length === 2 && otherMember.length === 0);
      await user.screenshot();
    });

    await step("after: a newly created provider appears exactly once beside the existing sibling models", async () => {
      extra = await world.createProvider(world.extraName, [world.initialModel]);
      extraExpected = { id: extra.id, models: [world.initialModel], name: world.extraName };
      grantId = extra.grantId;
      await observe(extra.acknowledgement, [baseline, extraExpected]);
    });
    await step("disabling the added provider removes only its models", async () => {
      const { provider } = added();
      await observe(await world.patchProvider(provider.id, { status: "disabled" }), [baseline]);
    });
    await step("reenabling the provider restores the same model identity exactly once", async () => {
      const { provider, expected } = added();
      await observe(await world.patchProvider(provider.id, { status: "active" }), [baseline, expected]);
    });
    await step("adding a model preserves both existing sibling identities", async () => {
      const update = await world.addModel();
      expect(update.body).toMatchObject({ addedModelIds: [world.addedModel] });
      baseline.models = [world.initialModel, world.siblingModel, world.addedModel];
      await observe(update, [baseline, added().expected]);
    });
    await step("removing one model leaves both of its siblings available", async () => {
      const update = await world.patchGroup(world.baseline.id, world.baseline.groupId, { modelIds: [world.initialModel, world.siblingModel] });
      baseline.models = [world.initialModel, world.siblingModel];
      await observe(update, [baseline, added().expected]);
    });
    await step("renaming provider metadata updates its visible name without changing any model identity", async () => {
      const { provider, expected } = added();
      const update = await world.patchProvider(provider.id, { name: world.renamedName });
      expected.name = world.renamedName;
      await observe(update, [baseline, expected], [], world.renamedName);
    });
    // Den does not expose arbitrary catalog-model names or a per-model status.
    // Supported metadata is PATCH provider.name; supported model disablement is
    // PATCH a single-model group's status, keeping provider and siblings active.
    await step("disabling a single-model group leaves the provider's unrelated siblings available", async () => {
      const { provider } = added();
      await observe(await world.patchGroup(provider.id, provider.groupId, { status: "disabled" }), [baseline]);
    });
    await step("reenabling the single-model group restores the original alias and display name", async () => {
      const { provider, expected } = added();
      await observe(await world.patchGroup(provider.id, provider.groupId, { status: "active" }), [baseline, expected]);
    });
    await step("revoking the member grant removes only that member's assigned provider", async () => {
      const { provider } = added();
      await observe(await world.revokeGrant(provider.id, grantId), [baseline]);
    });
    await step("regranting member access restores the original models without granting another member access", async () => {
      const { provider, expected } = added();
      const update = await world.grant(provider.id, provider.groupId, provider.setId, { type: "member", memberId: world.rileyId });
      const body = update.body;
      if (typeof body !== "object" || body === null || !("accessGrant" in body) || typeof body.accessGrant !== "object" || body.accessGrant === null || !("id" in body.accessGrant) || typeof body.accessGrant.id !== "string") throw new Error("Missing real Den grant ID");
      grantId = body.accessGrant.id;
      await observe(update, [baseline, expected]);
    });
    await step("moving the grant to another member removes it from the open picker without leaking siblings", async () => {
      const { provider, expected } = added();
      await observe(await world.patchGrant(provider.id, grantId, { type: "member", memberId: world.jordanId }), [baseline], [expected]);
    });
    await step("a team grant restores models only to the team that contains the signed-in member", async () => {
      const { provider, expected } = added();
      await observe(await world.patchGrant(provider.id, grantId, { type: "team", teamId: world.rileyTeam }), [baseline, expected]);
    });
    await step("moving access to a different team removes the models from the original member", async () => {
      const { provider, expected } = added();
      await observe(await world.patchGrant(provider.id, grantId, { type: "team", teamId: world.jordanTeam }), [baseline], [expected]);
    });
    await step("revoking the team grant leaves neither team with access to that provider", async () => {
      await observe(await world.revokeGrant(added().provider.id, grantId), [baseline]);
    });
    await step("regranting the original team restores the same aliases without cross-team leakage", async () => {
      const { provider, expected } = added();
      await observe(await world.grant(provider.id, provider.groupId, provider.setId, { type: "team", teamId: world.rileyTeam }), [baseline, expected]);
    });
    await step("rapid acknowledged edits converge to the latest models without stale additions or duplicates", async () => {
      const { provider, expected } = added();
      const receipts: AdminAcknowledgement[] = [];
      // Deliberately do not wait for intermediate picker states. All writes use
      // the real Den API; the last acknowledgement starts the convergence clock.
      receipts.push(await world.addModel());
      await unchanged();
      receipts.push(await world.patchProvider(provider.id, { status: "disabled" }));
      await unchanged();
      receipts.push(await world.patchGroup(world.baseline.id, world.baseline.groupId, { modelIds: [world.initialModel] }));
      await unchanged();
      receipts.push(await world.patchProvider(provider.id, { status: "active" }));
      await unchanged();
      receipts.push(await world.enableModels(provider.id, provider.groupId, [world.addedModel]));
      await unchanged();
      expected.models = [world.initialModel, world.addedModel];
      const final = await world.patchGroup(world.baseline.id, world.baseline.groupId, { modelIds: [world.initialModel, world.siblingModel] });
      expect(receipts.map((receipt) => receipt.status)).toEqual([200, 200, 200, 200, 200]);
      await observe(final, [baseline, expected]);
    });
    await step("deleting the added provider removes all its models while preserving the baseline siblings", async () => {
      const { provider } = added();
      await observe(await world.deleteProvider(provider.id), [baseline]);
    });
    await step("later inventory updates cannot resurrect deleted providers or removed models", async () => {
      // A subsequent genuine inventory update witnesses that absence survives
      // more than the first removal event, then samples the unchanged open picker.
      const update = await world.patchProvider(world.baseline.id, { name: "Live sync surviving siblings" });
      baseline.name = "Live sync surviving siblings";
      await observe(update, [baseline], [], baseline.name);
    });
    await step("the picker remains stable after the burst and deletion across repeated observations", async () => {
      const models = await world.catalog("riley", [baseline]);
      const startedAt = Date.now();
      let samples = 0;
      await probe.eventually(async () => {
        const value = await snapshot(models);
        expect(value.count).toBe(2);
        expect(value.names).toEqual(models.map((model) => [model.name]));
        expect(value.open).toBe(true);
        await unchanged();
        samples += 1;
        return Date.now() - startedAt;
      }, { within: 5_000, label: "deleted and removed models stay absent while both siblings remain", until: (elapsed) => elapsed >= 2_000 && samples >= 3 });
      const sorted = [...latencies].sort((a, b) => a - b);
      const maximum = sorted.at(-1) ?? 0;
      expect(maximum).toBeLessThanOrEqual(5_000);
      evidence.recordAssertionEvidence("All lifecycle writes meet the five-second limit and deleted models do not resurrect",
        `Cold run ${repetition}: ${latencies.length} timed mutations; ACK-to-picker ms [${latencies.join(", ")}]; min ${sorted[0]}, median ${sorted[Math.floor(sorted.length / 2)]}, max ${maximum}; ${samples} stable observations over ${Date.now() - startedAt} ms. API limitation: arbitrary catalog-model rename/per-model status are not exposed; provider-name metadata and single-model group status are exercised instead.`, maximum <= 5_000 && samples >= 3);
      await user.screenshot();
    });
  });
}

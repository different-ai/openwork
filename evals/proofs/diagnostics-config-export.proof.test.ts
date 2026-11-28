import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { orgDiagnosticsSchema } from "@openwork/types/den/diagnostics";
import { WORLD_SECRETS, diagnosticsConfigExportWorld } from "../worlds/diagnostics-config-export.ts";

const test = spec.world(diagnosticsConfigExportWorld, {
  timeout: 600_000,
  resources: { surfaces: ["web"], services: ["den"] },
  needs: { placement: "local" },
});

const EXPORT_KEYS = ["appVersion", "deployment", "deploymentCapabilities", "generatedAt", "helmAppVersion", "helmChartVersion", "kind", "lockedFeatures", "version", "versionSkew"];

test("an installation administrator sees that the server and the Helm chart disagree, and copies a configuration that is safe to send", async ({ world, user, probe, step, evidence }) => {
  const admin = user.on(world.operator), adminProbe = probe.on(world.operator);
  const member = user.on(world.member), memberProbe = probe.on(world.member);
  const text = async (selector: string) => (await adminProbe.dom(selector)).elements.map((element) => element.text.replace(/\s+/g, " ").trim()).join(" ");
  const has = (shown: string, expected: string) => shown.replace(/\s+/g, "").includes(expected.replace(/\s+/g, ""));

  await step("before: Diagnostics lists the server and its services, with no configuration to share", async () => {
    await admin.see({ testId: "diagnostics-installation" }, { timeoutMs: 90_000 });
    await admin.see({ testId: "installation-server" }, { timeoutMs: 60_000 });
    const rows = (await adminProbe.dom('[data-testid="installation-config"]')).elements.length;
    const response = await adminProbe.api(world.den.admin, "/v1/org/diagnostics");
    const report = orgDiagnosticsSchema.parse(response.body);
    await admin.screenshot();
    const ok = rows === 0 && report.installation.access === "operator" && report.installation.config === undefined;
    evidence.recordAssertionEvidence("With the feature off there is no Configuration row, and Den sends none", `Configuration rows: ${rows}; installation: ${report.installation.access}; configuration in the answer: ${report.installation.access === "operator" && report.installation.config !== undefined}`, ok);
    expect(ok).toBe(true);
  });

  await step("after: a Configuration row shows the running version and warns that it differs from the chart", async () => {
    await world.turnOnConfigExport();
    await admin.reload();
    await admin.see({ testId: "installation-config" }, { timeoutMs: 90_000 });
    await admin.see({ testId: "installation-config-state" }, { text: "Version mismatch", timeoutMs: 60_000 });
    const row = await text('[data-testid="installation-config-toggle"]');
    const attention = await text('[data-testid="diagnostics-attention"]');
    await admin.screenshot();
    const ok = has(row, "Configuration") && has(row, "Helm chart 0.2.0") && has(row, "Running 0.19.2") && has(row, "Version mismatch")
      && has(attention, "OpenWork server is not the version the Helm chart installs (0.19.1)");
    evidence.recordAssertionEvidence("The row names the chart, the running version and the mismatch without being opened, and the page lists it under what needs attention", `${row}; needs attention: ${attention}`, ok);
    expect(ok).toBe(true);
  });

  await step("opening the row says which version the chart installs and which features the deployment locks", async () => {
    await admin.click({ testId: "installation-config-toggle" });
    await admin.see({ text: "The chart installs 0.19.1 and the server runs 0.19.2. Set the image tag to 0.19.1, or upgrade the chart." }, { timeoutMs: 30_000 });
    const details = await text('[data-testid="installation-config-details"]');
    await admin.screenshot();
    const ok = has(details, "Chart app version 0.19.1") && has(details, "Locked by deployment administratorRecovery off");
    evidence.recordAssertionEvidence("The details give both versions and the feature this deployment locks off", details, ok);
    expect(ok).toBe(true);
  });

  await step("after: Copy configuration puts versions, capability states and locked features on the clipboard, and nothing else", async () => {
    await admin.click({ testId: "installation-config-copy" });
    await admin.see({ testId: "installation-config-copy" }, { text: "Copied", timeoutMs: 30_000 });
    const copied = await adminProbe.eventually(() => world.readClipboard(), {
      within: 15_000, label: "the configuration reached the clipboard", until: (value) => value.includes("openwork.installation-config"),
    });
    await admin.screenshot();
    const parsed: unknown = JSON.parse(copied);
    const keys = typeof parsed === "object" && parsed !== null ? Object.keys(parsed).sort() : [];
    const read = (key: string) => typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, key) : undefined;
    const leaked = [...Object.values(WORLD_SECRETS), world.den.admin.email, "127.0.0.1", "http://", "mysql://"].filter((value) => copied.includes(value));
    const ok = JSON.stringify(keys) === JSON.stringify(EXPORT_KEYS)
      && read("appVersion") === "0.19.2" && read("helmAppVersion") === "0.19.1" && read("helmChartVersion") === "0.2.0" && read("versionSkew") === true
      && JSON.stringify(read("lockedFeatures")) === JSON.stringify({ administratorRecovery: false })
      && leaked.length === 0;
    evidence.recordAssertionEvidence(
      "The copied file has ten fixed fields and none of this server's secrets, addresses or emails",
      `fields: ${keys.join(", ")}; versionSkew: ${String(read("versionSkew"))}; lockedFeatures: ${JSON.stringify(read("lockedFeatures"))}; secrets, addresses or emails found: ${leaked.length}`,
      ok,
    );
    expect(ok).toBe(true);
  });

  await step("a workspace member who is not an installation administrator gets no configuration, even when asking for it", async () => {
    const response = await memberProbe.api(world.den.members.member, "/v1/org/diagnostics?include=config");
    const report = orgDiagnosticsSchema.parse(response.body);
    await member.see({ testId: "member-home" }, { timeoutMs: 90_000 });
    const rows = (await memberProbe.dom('[data-testid="installation-config"]')).elements.length;
    await member.screenshot();
    const ok = rows === 0 && JSON.stringify(report.installation) === JSON.stringify({ access: "locked", reason: "installation_admin_required" });
    evidence.recordAssertionEvidence("Den answers the member with a locked Installation section and no configuration, and the member has no Diagnostics page", `installation: ${JSON.stringify(report.installation)}; Configuration rows on the member's screen: ${rows}`, ok);
    expect(ok).toBe(true);
  });
});

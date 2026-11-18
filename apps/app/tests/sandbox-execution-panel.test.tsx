/** @jsxImportSource react */
import { expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { sandboxSettingsQueryKey } from "../src/react-app/infra/use-sandbox-settings";
import { HostExecutionPanel, SandboxExecutionSection, type SandboxExecutionSectionProps } from "../src/react-app/domains/settings/panels/host-execution-panel";

const base: SandboxExecutionSectionProps = {
  settings: { allowHostExecution: false, effectiveAllowHostExecution: false, managed: false, featureEnabled: true },
  loading: false, unavailable: false, error: false, saving: false, saveError: false, preparing: false, prepareError: false,
  onSelect: () => {}, onRetry: () => {}, onReload: () => {},
};
const render = (props: Partial<SandboxExecutionSectionProps> = {}) => renderToStaticMarkup(<SandboxExecutionSection {...base} {...props} />);

test("flag off hides the production section even with a cached managed sandbox requirement", () => {
  const queryClient = new QueryClient();
  queryClient.setQueryData(sandboxSettingsQueryKey(null, "workspace-one"), { ...base.settings, managed: true });
  const html = renderToStaticMarkup(<QueryClientProvider client={queryClient}><HostExecutionPanel openworkServerClient={null} openworkServerStatus="disconnected" runtimeWorkspaceId="workspace-one" sandboxRolloutEnabled={false} onUpdated={() => {}} /></QueryClientProvider>);
  expect(html).toBe("");
  queryClient.clear();
});

test("real section uses named radios and the requested plain sentence", () => {
  const html = render();
  for (const text of ["Where the agent runs commands", "On this computer", "In a sandbox (isolated)", "In a sandbox, the agent can only see your workspace and the authorized folders below."]) expect(html).toContain(text);
  expect(html).toContain('role="radiogroup"');
  expect(html).not.toContain('role="switch"');
  expect(html).not.toContain("Sandbox ready");
  expect(html).not.toContain("microVM");
});

test("loading keeps the destination with skeletons, errors and disconnected states offer recovery", () => {
  expect(render({ loading: true })).toContain('data-testid="sandbox-settings-loading"');
  expect(render({ loading: true })).not.toContain('role="radiogroup"');
  expect(render({ error: true })).toContain("Couldn&#x27;t check where commands run");
  expect(render({ error: true })).toContain("Retry");
  expect(render({ unavailable: true })).toContain("Connect to your workspace");
});

test("real runtime states show honest preparation, readiness and supported retry", () => {
  for (const state of ["idle", "starting", "ready", "unsupported", "failed"] satisfies NonNullable<NonNullable<SandboxExecutionSectionProps["settings"]>["runtime"]>["state"][]) {
    const html = render({ settings: { ...base.settings!, runtime: { state, canRetry: true } } });
    expect(html).toContain(`data-sandbox-state="${state}"`);
    expect(html.includes('data-testid="sandbox-retry"')).toBe(state === "failed" || state === "unsupported");
    expect(html).not.toContain("Downloading");
    expect(html.includes('role="progressbar"')).toBe(state === "idle" || state === "starting");
  }
  expect(render({ settings: { ...base.settings!, runtime: { state: "failed", canRetry: false } } })).not.toContain('data-testid="sandbox-retry"');
});

test("preparation exposes real stage counts and accessible progress without invented percentages", () => {
  for (const [stage, completed, label] of [["preparing_files", 0, "Preparing files"], ["starting", 1, "Starting sandbox"]] satisfies [string, number, string][]) {
    const html = render({ settings: { ...base.settings!, runtime: { state: "starting", stage, progress: { completed, total: 2 }, canRetry: false } } });
    expect(html).toContain(label);
    expect(html).toContain(`aria-valuenow="${completed}"`);
    expect(html).toContain('aria-valuemax="2"');
    expect(html).toContain(`aria-valuetext="${completed} / 2"`);
    expect(html).toContain(`${completed} / 2`);
    expect(html).not.toContain("Downloading");
  }
  const html = render({ settings: { ...base.settings!, runtime: { state: "starting", canRetry: false } } });
  expect(html).toContain('role="progressbar"');
  expect(html).not.toContain("aria-valuenow=");
  expect(html).not.toContain('data-testid="sandbox-preparation-count"');
});

test("unsupported permissions report the sanitized reason and next action neutrally with supported retry", () => {
  const message = "OpenWork cannot use its sandbox files. Allow access to the sandbox installation, then retry.";
  const html = render({ prepareError: true, settings: { ...base.settings!, runtime: { state: "unsupported", reason: "runtime_permission_denied", message, canRetry: true } } });
  expect(html).toContain(message);
  expect(html).toContain('data-testid="sandbox-retry"');
  expect(html.split('data-sandbox-state="unsupported"')[1]).not.toContain("text-destructive");
  expect(html).not.toContain("Contact your admin");
  expect(html).not.toContain("Sandbox unavailable. Commands are blocked.");
  const failed = render({ settings: { ...base.settings!, runtime: { state: "failed", message: "Sandbox stopped. Retry to start it again.", canRetry: true } } });
  expect(failed).toContain("Sandbox stopped. Retry to start it again.");
  expect(failed.split('data-sandbox-state="failed"')[1]).toContain("text-destructive");
});

test("pending is a neutral status, preserves the chosen location and does not claim ready", () => {
  const html = render({ prepareError: true, settings: { ...base.settings!, pending: true, effectiveAllowHostExecution: true, runtime: { state: "ready", canRetry: false } } });
  expect(html).toContain("Applies when the current task finishes");
  expect(html).toContain("Current commands run on this computer");
  expect(html).not.toContain("Sandbox ready");
  expect(html).not.toContain('role="alert"');
});

test("real radio choices and retry button invoke their production actions", async () => {
  const ownedDom = typeof window === "undefined";
  if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
  const priorAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const choices: boolean[] = [];
  let retries = 0;
  try {
    await act(async () => root.render(<SandboxExecutionSection {...base} onSelect={(value) => choices.push(value)} />));
    const computer = container.querySelector<HTMLElement>('[data-testid="sandbox-location-computer"]');
    if (!computer) throw new Error("Computer radio missing");
    await act(async () => computer.click());
    expect(choices).toEqual([true]);
    await act(async () => root.render(<SandboxExecutionSection {...base} settings={{ ...base.settings!, runtime: { state: "failed", canRetry: true } }} onRetry={() => { retries += 1; }} />));
    const retry = container.querySelector<HTMLElement>('[data-testid="sandbox-retry"]');
    if (!retry) throw new Error("Retry action missing");
    await act(async () => retry.click());
    expect(retries).toBe(1);
    await act(async () => root.render(<SandboxExecutionSection {...base} settings={{ ...base.settings!, runtime: { state: "unsupported", message: "Allow sandbox file access, then retry.", canRetry: true } }} onRetry={() => { retries += 1; }} />));
    const retryUnsupported = container.querySelector<HTMLElement>('[data-testid="sandbox-retry"]');
    if (!retryUnsupported) throw new Error("Unsupported recovery action missing");
    await act(async () => retryUnsupported.click());
    expect(retries).toBe(2);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", priorAct);
    if (ownedDom) await GlobalRegistrator.unregister();
  }
});

test("explicit computer policy keeps a stricter applied device sandbox selected and locked", () => {
  const settings = { ...base.settings!, allowHostExecution: false, effectiveAllowHostExecution: false, managed: true, managedMode: "computer", deviceRestricted: true } satisfies NonNullable<SandboxExecutionSectionProps["settings"]>;
  const html = render({ settings });
  expect(html).toContain('data-host-execution="deny"');
  expect(html).toContain('data-host-execution-managed="true"');
  expect(html).toContain("Managed by your organization");
  expect(html).toContain("Your stricter device setting is kept.");
  expect(html).toContain('data-testid="sandbox-device-restriction"');
  expect(html).toContain('aria-disabled="true"');
  expect(html).toMatch(/aria-checked="true"[^>]*data-testid="sandbox-location-sandbox"/);
});

test("organization can lock either location", () => {
  for (const effectiveAllowHostExecution of [true, false]) {
    const html = render({ settings: { ...base.settings!, managed: true, effectiveAllowHostExecution } });
    expect(html).toContain("Managed by your organization");
    expect(html).toContain('data-host-execution-managed="true"');
    expect(html).toContain('aria-disabled="true"');
  }
});

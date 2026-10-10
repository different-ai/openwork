"use client";
import { useState } from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { requestJson, getRequestError } from "../../_lib/den-flow";
import { getWorkbotSettingsRoute } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { DenButton } from "../../_components/ui/button";
import { DenSwitch } from "../../_components/ui/switch";
import { DenInput } from "../../_components/ui/input";
import { auditSummaryClass, AuditChevron } from "./audit-logs-details";
import type { ExternalMcpConnection } from "./mcp-connections-data";

const setupSchema = z.object({
  enabled: z.boolean(),
  installed: z.boolean(),
  hasSigningSecret: z.boolean(),
  eligible: z.boolean(),
  rolloutEnabled: z.boolean(),
  runnerAvailable: z.boolean(),
  shadowMode: z.boolean(),
  dailyLimit: z.number(),
  model: z.string().nullable().default(null),
  modelManagedByOrganization: z.boolean().default(false),
  defaultModel: z.string().nullable().default(null),
  progressUpdates: z.boolean().default(false),
  models: z.array(z.object({ id: z.string(), name: z.string() })).default([]),
  channelIds: z.array(z.string()),
  metrics: z.object({
    completed: z.number(),
    failed: z.number(),
    active: z.number(),
    awaitingConnection: z.number(),
    firstTextMedianMs: z.number().nullable(),
    finalMedianMs: z.number().nullable(),
    helpful: z.number(),
    needsWork: z.number(),
  }),
  manifest: z.unknown(),
});
export function SlackAssistantSetup({ connection }: { connection: ExternalMcpConnection }) {
  const { orgContext, orgSlug, runReauthableAction } = useOrgDashboard();
  const client = useQueryClient();
  const [secret, setSecret] = useState("");
  const [channels, setChannels] = useState<string | null>(null);
  const [limit, setLimit] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const orgId = orgContext?.organization.id;
  const isSlack = (() => {
    try {
      return new URL(connection.url).hostname === "mcp.slack.com";
    } catch {
      return false;
    }
  })();
  const path = `/v1/mcp-connections/${connection.id}/slack-assistant`;
  const queryKey = ["slack-assistant", orgId, connection.id];
  const headers = { "x-openwork-org-id": orgId ?? "" };
  const query = useQuery({
    queryKey,
    enabled: isSlack && Boolean(orgId),
    queryFn: async () => setupSchema.parse(await request(path, { headers })),
  });
  async function request(url: string, init: RequestInit) {
    const { response, payload } = await requestJson(url, init);
    if (!response.ok) throw getRequestError(payload, response, "Slack setup request failed.");
    return payload;
  }
  if (!isSlack) return null;
  const data = query.data;
  async function save(
    enabled: boolean,
    changes: { shadowMode?: boolean; model?: string | null; progressUpdates?: boolean } = {},
  ) {
    setBusy(true);
    setError(null);
    try {
      await runReauthableAction("slack-assistant-setup", async () => {
        await request(path, {
          method: "PUT",
          headers,
          body: JSON.stringify({
            enabled,
            shadowMode: changes.shadowMode ?? data?.shadowMode ?? false,
            dailyLimit: limit ?? data?.dailyLimit ?? 100,
            channelIds: channels === null ? (data?.channelIds ?? []) : channels.split(/[\s,]+/).filter(Boolean),
            ...(secret ? { signingSecret: secret } : {}),
            ...(changes.model !== undefined ? { model: changes.model } : {}),
            ...(changes.progressUpdates !== undefined ? { progressUpdates: changes.progressUpdates } : {}),
          }),
        });
        setSecret("");
        setChannels(null);
        setLimit(null);
        await client.invalidateQueries({ queryKey });
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save Slack setup.");
    } finally {
      setBusy(false);
    }
  }
  async function install() {
    setBusy(true);
    setError(null);
    try {
      await runReauthableAction("slack-assistant-setup", async () => {
        const result = z
          .object({ url: z.string().url() })
          .parse(await request(`${path}/install`, { method: "POST", headers }));
        window.location.assign(result.url);
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start Slack installation.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="mt-10 flex flex-col gap-4 rounded-2xl border border-gray-100 bg-white p-5" aria-label="OpenWork in Slack" data-testid="slack-assistant-setup">
      <div>
        <h2 className="text-base font-semibold">OpenWork in Slack</h2>
        <p className="mt-1 text-sm text-gray-500">
          Mention @openwork to work as yourself, with your own connections and permissions. Each member connects their
          own Slack account.
        </p>
      </div>
      {query.isPending ? <p role="status">Loading Slack setup…</p> : null}
      {query.error ? <p role="alert">Could not load Slack setup.</p> : null}
      {data && !data.eligible ? <p>Choose Individual accounts mode before enabling the assistant.</p> : null}
      {data && !data.rolloutEnabled ? (
        <p className="text-sm text-gray-500">
          Ask a platform admin to enable Slack Assistant for this workspace in /admin.
        </p>
      ) : null}
      {data && !data.runnerAvailable ? (
        <p className="text-sm text-gray-500" role="status">
          Not available on this deployment: the Slack assistant runs on OpenWork&apos;s cloud runner, which isn&apos;t set up
          here. Whoever runs this OpenWork deployment can turn it on.
        </p>
      ) : null}
      {data ? (
        <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4" aria-label="Last 24 hours">
          {[
            ["Completed", data.metrics.completed],
            ["Active", data.metrics.active],
            ["Need connection", data.metrics.awaitingConnection],
            ["Failed", data.metrics.failed],
          ].map(([label, value]) => (
            <div key={label} className="rounded-lg bg-gray-50 p-3">
              <p className="text-xs text-gray-500">{label}</p>
              <p className="mt-1 text-lg font-medium">{value}</p>
            </div>
          ))}
        </div>
      ) : null}
      {data ? (
        <p className="text-xs text-gray-500">
          Last 24 hours · Median first reply:{" "}
          {data.metrics.firstTextMedianMs === null ? "—" : `${(data.metrics.firstTextMedianMs / 1000).toFixed(1)}s`} ·
          Helpful: {data.metrics.helpful} · Needs work: {data.metrics.needsWork}
        </p>
      ) : null}
      {data?.eligible ? (
        <>
          <div className="flex min-h-12 items-center justify-between gap-3 border-b border-gray-100 text-sm">
            <span>Enable @openwork in Slack</span>
            <DenSwitch
              checked={data.enabled}
              disabled={busy || (!data.enabled && (!data.rolloutEnabled || !data.runnerAvailable || (!data.hasSigningSecret && !secret)))}
              aria-label="Enable @openwork in Slack"
              testId="slack-assistant-enabled"
              onChange={(checked) => void save(checked)}
            />
          </div>
          <label className="flex flex-col gap-1 text-sm">
            Slack app signing secret
            <DenInput
              type="password"
              autoComplete="off"
              data-ph-no-capture
              data-testid="slack-assistant-signing-secret"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder={data.hasSigningSecret ? "Saved securely" : "Paste from Slack app settings"}
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <DenButton variant="secondary" disabled={busy || !secret} onClick={() => void save(data.enabled)}>
              Save secret
            </DenButton>
            <DenButton disabled={busy || !data.hasSigningSecret || !data.runnerAvailable} onClick={() => void install()}>
              {data.installed ? "Reinstall in Slack" : "Add to Slack"}
            </DenButton>
          </div>
          <div className="flex min-h-12 items-center justify-between gap-3 border-b border-gray-100 text-sm">
            <span>Send replies privately during rollout</span>
            <DenSwitch
              checked={data.shadowMode}
              disabled={busy || !data.hasSigningSecret}
              aria-label="Send replies privately during rollout"
              testId="slack-assistant-shadow"
              onChange={(checked) => void save(data.enabled, { shadowMode: checked })}
            />
          </div>
          <div className="flex min-h-12 items-center justify-between gap-3 border-b border-gray-100 text-sm">
            <span>Show progress while working</span>
            <DenSwitch
              checked={data.progressUpdates}
              disabled={busy || !data.hasSigningSecret}
              aria-label="Show progress while working"
              testId="slack-assistant-progress"
              onChange={(checked) => void save(data.enabled, { progressUpdates: checked })}
            />
          </div>
          <p className="text-xs text-gray-500">
            Access follows this connector’s workspace, team, and member grants. Turning the assistant off stops
            accepting new requests.
          </p>
          {data.models.length > 0 && data.modelManagedByOrganization ? (
            <p className="text-sm" data-testid="slack-assistant-model">
              Model: {data.models.find((m) => m.id === data.model)?.name ?? data.model ?? `Default${data.defaultModel ? ` (${data.models.find((m) => m.id === data.defaultModel)?.name ?? data.defaultModel})` : ""}`}{" "}
              <Link href={getWorkbotSettingsRoute(orgSlug)} className="text-gray-500 underline-offset-2 hover:text-gray-900 hover:underline">
                Change in Manage › Workbot
              </Link>
            </p>
          ) : data.models.length > 0 ? (
            <label className="block text-sm">
              Model
              <select
                value={data.model ?? ""}
                disabled={busy || !data.hasSigningSecret}
                onChange={(e) => void save(data.enabled, { model: e.target.value || null })}
                className="mt-1 block w-full rounded-lg border border-gray-200 px-3 py-2"
              >
                <option value="">
                  Default{data.defaultModel ? ` (${data.models.find((m) => m.id === data.defaultModel)?.name ?? data.defaultModel})` : ""}
                </option>
                {data.models.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <details className="group text-sm" data-testid="slack-assistant-limits">
            <summary className={auditSummaryClass} data-testid="slack-assistant-limits-toggle"><AuditChevron />Rollout limits</summary>
            <div className="flex flex-col items-start gap-3 pb-3">
              <label className="flex w-full flex-col gap-1">
                Allowed channel IDs
                <DenInput
                  value={channels ?? data.channelIds.join(", ")}
                  onChange={(e) => setChannels(e.target.value)}
                  placeholder="All channels"
                />
              </label>
              <p className="text-xs text-gray-500">
                Separate IDs with commas. Direct messages remain available to eligible members.
              </p>
              <label className="flex w-full flex-col gap-1">
                Requests per member per day
                <DenInput
                  type="number"
                  min={1}
                  max={1000}
                  value={limit ?? data.dailyLimit}
                  onChange={(e) => setLimit(Number(e.target.value))}
                />
              </label>
              <DenButton
                variant="secondary"
                disabled={busy || !data.hasSigningSecret || (channels === null && limit === null)}
                onClick={() => void save(data.enabled)}
              >
                Save limits
              </DenButton>
            </div>
          </details>
          <details className="group text-sm" data-testid="slack-assistant-manifest">
            <summary className={auditSummaryClass} data-testid="slack-assistant-manifest-toggle"><AuditChevron />Slack app manifest</summary>
            <p className="my-2 text-xs text-gray-500">
              Merge these settings into the Slack app registered for this connection. Keep its existing user OAuth and
              MCP settings.
            </p>
            <pre className="max-h-72 overflow-auto rounded-lg bg-gray-50 p-3 text-xs">
              {JSON.stringify(data.manifest, null, 2)}
            </pre>
          </details>
        </>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      ) : null}
    </section>
  );
}

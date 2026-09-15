"use client";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { requestJson, getRequestError } from "../../_lib/den-flow";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { DenButton } from "../../_components/ui/button";
import type { ExternalMcpConnection } from "./mcp-connections-data";

const setupSchema = z.object({
  enabled: z.boolean(),
  installed: z.boolean(),
  hasSigningSecret: z.boolean(),
  eligible: z.boolean(),
  rolloutEnabled: z.boolean(),
  webAccess: z.boolean(),
  shadowMode: z.boolean(),
  dailyLimit: z.number(),
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
  const { orgContext, runReauthableAction } = useOrgDashboard();
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
  async function save(enabled: boolean, shadowMode = data?.shadowMode ?? false) {
    setBusy(true);
    setError(null);
    try {
      await runReauthableAction("slack-assistant-setup", async () => {
        await request(path, {
          method: "PUT",
          headers,
          body: JSON.stringify({
            enabled,
            shadowMode,
            dailyLimit: limit ?? data?.dailyLimit ?? 100,
            channelIds: channels === null ? (data?.channelIds ?? []) : channels.split(/[\s,]+/).filter(Boolean),
            ...(secret ? { signingSecret: secret } : {}),
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
    <section className="mt-10 space-y-4 rounded-2xl border border-gray-100 bg-white p-5" aria-label="OpenWork in Slack">
      <div>
        <h2 className="text-base font-semibold">OpenWork in Slack</h2>
        <p className="mt-1 text-sm text-gray-500">
          Mention @openwork to use your own workspace, connections, and permissions. Each member connects their own
          Slack account.
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
      {data && !data.webAccess ? <p>OpenWork Web access is required for this workspace.</p> : null}
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
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={data.enabled}
              disabled={busy || (!data.enabled && (!data.rolloutEnabled || !data.webAccess || (!data.hasSigningSecret && !secret)))}
              onChange={(e) => void save(e.target.checked)}
            />
            Enable @openwork in Slack
          </label>
          <label className="block text-sm">
            Slack app signing secret
            <input
              type="password"
              autoComplete="off"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder={data.hasSigningSecret ? "Saved securely" : "Paste from Slack app settings"}
              className="mt-1 block w-full rounded-lg border border-gray-200 px-3 py-2"
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <DenButton variant="secondary" disabled={busy || !secret} onClick={() => void save(data.enabled)}>
              Save secret
            </DenButton>
            <DenButton disabled={busy || !data.hasSigningSecret || !data.webAccess} onClick={() => void install()}>
              {data.installed ? "Reinstall in Slack" : "Add to Slack"}
            </DenButton>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={data.shadowMode}
              disabled={busy || !data.hasSigningSecret}
              onChange={(e) => void save(data.enabled, e.target.checked)}
            />
            Send replies privately during rollout
          </label>
          <p className="text-xs text-gray-500">
            Access follows this connector’s workspace, team, and member grants. Turning the assistant off stops
            accepting new requests.
          </p>
          <details className="space-y-3">
            <summary className="cursor-pointer text-sm">Rollout limits</summary>
            <label className="block text-sm">
              Allowed channel IDs
              <input
                value={channels ?? data.channelIds.join(", ")}
                onChange={(e) => setChannels(e.target.value)}
                placeholder="All channels"
                className="mt-1 block w-full rounded-lg border border-gray-200 px-3 py-2"
              />
            </label>
            <p className="text-xs text-gray-500">
              Separate IDs with commas. Direct messages remain available to eligible members.
            </p>
            <label className="block text-sm">
              Requests per member per day
              <input
                type="number"
                min={1}
                max={1000}
                value={limit ?? data.dailyLimit}
                onChange={(e) => setLimit(Number(e.target.value))}
                className="mt-1 block w-full rounded-lg border border-gray-200 px-3 py-2"
              />
            </label>
            <DenButton
              variant="secondary"
              disabled={busy || !data.hasSigningSecret || (channels === null && limit === null)}
              onClick={() => void save(data.enabled)}
            >
              Save limits
            </DenButton>
          </details>
          <details>
            <summary className="cursor-pointer text-sm">Slack app manifest</summary>
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

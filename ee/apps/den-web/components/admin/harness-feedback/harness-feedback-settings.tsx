"use client";

import { Search } from "lucide-react";
import { useEffect, useState } from "react";
import { z } from "zod";
import { DenBadge } from "../../../app/(den)/_components/ui/badge";
import { DenButton } from "../../../app/(den)/_components/ui/button";
import { DenCard } from "../../../app/(den)/_components/ui/card";
import { DenInput } from "../../../app/(den)/_components/ui/input";
import { DenNotice } from "../../../app/(den)/_components/ui/notice";
import { DenSelect } from "../../../app/(den)/_components/ui/select";
import { sendAdmin } from "../admin-request";
import { useAdminReport } from "../use-admin-report";

const PATH = "/v1/admin/harness-feedback/settings";
const SLACK = `${PATH}/slack`;
const organization = z.object({ id: z.string(), name: z.string() });
const organizations = z.object({ organizations: z.array(organization) });
const settings = organizations.extend({ webhookConfigured: z.boolean(), jevConfigured: z.boolean() });
const parseSettings = (data: unknown) => settings.safeParse(data).data ?? null;
const parseOrganizations = (data: unknown) => organizations.safeParse(data).data ?? null;

function OrganizationPicker({ enabled, disabled, add }: {
  enabled: z.infer<typeof organization>[];
  disabled: boolean;
  add: (id: string) => void;
}) {
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [choice, setChoice] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);
  const params = new URLSearchParams({ limit: "25", includeFeatures: "0", search: query });
  const result = useAdminReport(`/v1/admin/organizations?${params}`, parseOrganizations, 0);
  const options = result.status === "ready" ? result.data.organizations.filter((org) => !enabled.some(({ id }) => id === org.id)) : [];
  const ready = result.status === "ready" && search.trim() === query;
  return (
    <form className="flex flex-col gap-2" onSubmit={(event) => {
      event.preventDefault();
      if (!disabled && ready && options.some(({ id }) => id === choice)) add(choice);
    }}>
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-48 flex-1">
          <DenInput type="search" icon={Search} aria-label="Search organizations" placeholder="Find an organization" maxLength={160} value={search}
            onChange={(event) => { setSearch(event.target.value); setChoice(""); }} />
        </div>
        <div className="min-w-44 flex-1">
          <DenSelect aria-label="Organization to add" value={choice} onChange={(event) => setChoice(event.target.value)} disabled={disabled || !ready || !options.length}>
            <option value="">Choose an organization</option>
            {options.map((org) => <option key={org.id} value={org.id}>{org.name}</option>)}
          </DenSelect>
        </div>
        <DenButton type="submit" size="sm" disabled={disabled || !ready || !options.some(({ id }) => id === choice)}>Add organization</DenButton>
      </div>
      {result.status !== "loading" && result.status !== "ready" ? <DenNotice presentation="inline" message="Couldn’t load organizations. Change the search to try again." /> : null}
      {ready && !options.length ? <p className="text-sm text-muted-foreground">No organizations to add in these results. Try a different name.</p> : null}
    </form>
  );
}

export function HarnessFeedbackSettings({ revision, refresh }: { revision: number; refresh: () => void }) {
  const result = useAdminReport(PATH, parseSettings, revision);
  const [webhook, setWebhook] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ message: string; tone: "error" | "success" }>();

  async function update(path: string, method: "PUT" | "DELETE" | "POST", success: string, body?: unknown) {
    setFeedback(undefined);
    setBusy(true);
    try {
      const response = await sendAdmin(path, method, body);
      if (!response.ok) {
        setFeedback({ message: response.message, tone: "error" });
        return;
      }
      if (path === SLACK) setWebhook("");
      setFeedback({ message: success, tone: "success" });
      if (method !== "POST") refresh();
    } catch {
      setFeedback({ message: "Couldn’t confirm the result. Refresh before trying again.", tone: "error" });
    } finally {
      setBusy(false);
    }
  }

  const data = result.data;
  const disabled = busy || result.status !== "ready";
  return (
    <DenCard className="space-y-4 !rounded-lg">
      <h2 className="text-sm font-semibold">Feedback settings</h2>
      {result.status !== "loading" && result.status !== "ready" ? <DenNotice presentation="inline" message="Couldn’t load feedback settings." action={<DenButton size="sm" variant="secondary" onClick={refresh}>Try again</DenButton>} /> : null}
      {!data && result.status === "loading" ? <div role="status" aria-label="Loading settings" className="h-48 animate-pulse rounded-lg bg-muted motion-reduce:animate-none" /> : null}
      {data ? <>
        {!data.jevConfigured ? <DenNotice tone="neutral" presentation="inline" message="Jev isn’t set up on this deployment. Reports will wait until automatic classification and issue naming are available." /> : null}
        <section aria-labelledby="feedback-organizations" className="space-y-2">
          <h3 id="feedback-organizations" className="text-sm font-medium">Enabled organizations</h3>
          {!data.organizations.length ? <p className="text-sm text-muted-foreground">Harness feedback is off. Add an organization to start collecting reports.</p> : (
            <ul className="divide-y divide-border">
              {data.organizations.map((org) => <li key={org.id} className="flex min-h-10 items-center justify-between gap-3 text-sm">
                <span className="min-w-0 break-words">{org.name}</span>
                <DenButton aria-label={`Remove ${org.name}`} size="sm" variant="ghost" disabled={disabled}
                  onClick={() => void update(`${PATH}/organizations/${encodeURIComponent(org.id)}`, "DELETE", "Organization removed.")}>Remove</DenButton>
              </li>)}
            </ul>
          )}
          <OrganizationPicker enabled={data.organizations} disabled={disabled} add={(id) => void update(`${PATH}/organizations/${encodeURIComponent(id)}`, "PUT", "Organization added.")} />
        </section>
        <section aria-labelledby="feedback-slack" className="space-y-2 border-t border-border pt-3">
          <div className="flex min-h-10 flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <h3 id="feedback-slack" className="text-sm font-medium">Slack notifications</h3>
              <DenBadge>{data.webhookConfigured ? "Connected" : "Not set up"}</DenBadge>
            </div>
            {data.webhookConfigured ? <div className="flex flex-wrap gap-2">
              <DenButton size="sm" variant="secondary" disabled={disabled} onClick={() => void update(`${SLACK}/test`, "POST", "Test message sent.")}>Send test message</DenButton>
              <DenButton size="sm" variant="ghost" disabled={disabled} onClick={() => void update(SLACK, "DELETE", "Slack webhook cleared.")}>Clear webhook</DenButton>
            </div> : null}
          </div>
          <form className="flex flex-wrap items-center gap-2" onSubmit={(event) => {
            event.preventDefault();
            if (!disabled && webhook.trim()) void update(SLACK, "PUT", "Slack webhook saved.", { webhookUrl: webhook.trim() });
          }}>
            <DenInput className="min-w-48 flex-1" aria-label="Slack webhook URL" placeholder="Paste a Slack webhook URL" type="password" autoComplete="off" spellCheck={false}
              maxLength={2048} value={webhook} disabled={disabled} onChange={(event) => setWebhook(event.target.value)} />
            <DenButton size="sm" type="submit" variant="secondary" disabled={disabled || !webhook.trim()}>Save webhook</DenButton>
          </form>
        </section>
        {feedback ? <DenNotice presentation="inline" {...feedback} /> : null}
      </> : null}
    </DenCard>
  );
}

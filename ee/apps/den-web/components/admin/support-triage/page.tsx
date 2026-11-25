"use client";

import { useState } from "react";
import { z } from "zod";
import { DenButton } from "../../../app/(den)/_components/ui/button";
import { DenInput } from "../../../app/(den)/_components/ui/input";
import { DenNotice } from "../../../app/(den)/_components/ui/notice";
import { DenSelect } from "../../../app/(den)/_components/ui/select";
import { DenSwitch } from "../../../app/(den)/_components/ui/switch";
import { FeatureIntroBox, FeatureIntroFullscreen, FeatureIntroLockedAction } from "../../../app/(den)/dashboard/_features/feature-intros/feature-intro-views";
import { supportTriageIntro } from "../../../app/(den)/dashboard/_features/feature-intros/intros/support-triage";
import { sendAdmin } from "../admin-request";
import { useAdminReport } from "../use-admin-report";
import { categoryLabels, parseThreads, TriageThreads } from "./threads";

const root = "/v1/admin/support-triage";
const limit = 25;
const settingsSchema = z.object({ enabledAt: z.string().nullable(), plainConfigured: z.boolean(), slackConfigured: z.boolean(), leadsSlackConfigured: z.boolean(), jevConfigured: z.boolean() });
const parseSettings = (payload: unknown) => settingsSchema.safeParse(payload).data ?? null;
const cta = supportTriageIntro.ctas[0] ?? null;
const plainPermissions = ["thread:read", "thread:setPriority", "thread:setStatus", "customer:read", "timeline:read", "workspace:read",
  "labelType:read", "labelType:create", "label:create", "label:read"];

const credentials = {
  plain: { label: "Plain API key", field: "plainApiKey", testPath: "/plain/test", cleared: "Plain key cleared. Triage is off.", hint: null },
  slack: { label: "Bugs Slack webhook", field: "slackWebhookUrl", testPath: "/slack/test", cleared: "Bugs Slack webhook cleared.",
    hint: "Product bugs post here. Enterprise leads also post here unless a leads webhook is saved." },
  leads: { label: "Leads Slack webhook", field: "leadsSlackWebhookUrl", testPath: "/slack/leads/test", cleared: "Leads Slack webhook cleared. Enterprise leads post to the bugs webhook.",
    hint: "Enterprise leads post here. Leave empty to send them to the bugs webhook." },
} as const;

function CredentialSetting({ kind, configured, disabled, run }: { kind: keyof typeof credentials; configured: boolean; disabled: boolean;
  run: (method: "PUT" | "POST", path: string, body: unknown, success: string) => Promise<boolean> }) {
  const [value, setValue] = useState("");
  const plain = kind === "plain";
  const { label, field, testPath, cleared, hint } = credentials[kind];
  const test = plain ? "Test connection" : "Send test message";
  return <details className="group border-b border-border py-2">
    <summary className="flex min-h-8 cursor-pointer list-none items-center justify-between gap-3 text-sm [&::-webkit-details-marker]:hidden">
      <span className="flex items-center gap-2"><span aria-hidden className="inline-block transition-transform group-open:rotate-90 motion-reduce:transition-none">›</span>{label}</span>
      <span className="text-muted-foreground">{configured ? "Saved" : plain ? "Not set up" : "Optional"}</span>
    </summary>
    <form className="space-y-2 pb-2 pl-4 pt-2" onSubmit={(event) => {
      event.preventDefault();
      if (value.trim() && !disabled) void run("PUT", "/settings", { [field]: value.trim() }, `${label} saved.`).then((ok) => { if (ok) setValue(""); });
    }}>
      <DenInput aria-label={label} type="password" autoComplete="new-password" spellCheck={false} maxLength={2048} value={value}
        disabled={disabled} onChange={(event) => setValue(event.target.value)} placeholder={configured ? `Replace ${label.toLowerCase()}` : `Paste ${label.toLowerCase()}`} />
      {plain ? <p className="text-xs text-muted-foreground">Permissions: {plainPermissions.map((permission, index) => <span key={permission}>{index ? ", " : ""}<code>{permission}</code></span>)}.</p>
        : <p className="text-xs text-muted-foreground">{hint}</p>}
      <div className="flex flex-wrap gap-2">
        <DenButton type="submit" size="sm" variant="secondary" disabled={disabled || !value.trim()}>Save {plain ? "key" : "webhook"}</DenButton>
        <DenButton type="button" size="sm" variant="ghost" disabled={disabled || (!configured && !value.trim())}
          onClick={() => void run("POST", testPath, value.trim() ? { [field]: value.trim() } : {}, plain ? "Plain connection verified." : "Test message sent.")}>{test}</DenButton>
        {configured ? <DenButton type="button" size="sm" variant="ghost" disabled={disabled}
          onClick={() => void run("PUT", "/settings", { [field]: null }, cleared).then((ok) => { if (ok) setValue(""); })}>Clear {plain ? "key" : "webhook"}</DenButton> : null}
      </div>
    </form>
  </details>;
}

export function SupportTriagePage() {
  const [revision, setRevision] = useState(0);
  const [category, setCategory] = useState("");
  const [offset, setOffset] = useState(0);
  const [busy, setBusy] = useState(false);
  const [help, setHelp] = useState(false);
  const [feedback, setFeedback] = useState<{ message: string; tone: "error" | "success" }>();
  const refresh = () => setRevision((previous) => previous + 1);
  const settings = useAdminReport(`${root}/settings`, parseSettings, revision);
  const query = new URLSearchParams({ limit: String(limit), offset: String(offset), ...(category ? { category } : {}) });
  const threads = useAdminReport(`${root}/threads?${query}`, parseThreads, revision);
  const data = settings.data;
  const disabled = busy || settings.status !== "ready";
  const unfilteredEmpty = threads.status === "ready" && !threads.data.total && !category;
  const firstSetup = unfilteredEmpty && data && !data.plainConfigured && !data.enabledAt;
  const introControls = { intro: supportTriageIntro, cta, note: null, onCtaClick: () => {} };

  async function run(method: "PUT" | "POST", path: string, body: unknown, success: string) {
    setFeedback(undefined);
    setBusy(true);
    try {
      const result = await sendAdmin(`${root}${path}`, method, body);
      setFeedback(result.ok ? { message: success, tone: "success" } : { message: result.message, tone: "error" });
      if (result.ok && method === "PUT") refresh();
      return result.ok;
    } catch {
      setFeedback({ message: "Couldn’t confirm the result. Refresh before trying again.", tone: "error" });
      return false;
    } finally {
      setBusy(false);
    }
  }

  return <div className="space-y-6 text-foreground">
    <header className="flex flex-wrap items-center justify-between gap-2">
      <h1 className="text-lg font-semibold tracking-tight">Support triage</h1>
      <div className="flex gap-2">
        <DenButton variant="ghost" size="sm" aria-label="About support triage" aria-expanded={help || Boolean(firstSetup)} onClick={() => setHelp(!help)} disabled={Boolean(firstSetup)}>?</DenButton>
        <DenButton variant="secondary" size="sm" onClick={refresh}>Refresh</DenButton>
      </div>
    </header>
    {firstSetup || help ? <FeatureIntroFullscreen {...introControls} /> : null}
    <section id="triage-settings" aria-labelledby="triage-settings-heading" className="max-w-2xl">
      <h2 id="triage-settings-heading" className="border-b border-border pb-2 text-sm font-semibold">Triage settings</h2>
      {settings.status !== "ready" && settings.status !== "loading" ? <DenNotice presentation="inline" message={data ? "Couldn’t verify settings. Showing the last loaded values." : "Couldn’t load settings."}
        action={<DenButton size="sm" variant="secondary" onClick={refresh}>Try again</DenButton>} /> : null}
      {!data && settings.status === "loading" ? <div role="status" aria-label="Loading triage settings" className="mt-2 h-44 animate-pulse rounded-md bg-muted motion-reduce:animate-none" /> : null}
      {data ? <>
        <div className="flex min-h-11 flex-wrap items-center justify-between gap-2 border-b border-border py-1 text-sm">
          <span>{data.enabledAt ? `On since ${new Date(data.enabledAt).toLocaleString()}` : "Triage off"}</span>
          <DenSwitch checked={Boolean(data.enabledAt)} disabled={disabled || (!data.enabledAt && (!data.jevConfigured || !data.plainConfigured))}
            aria-label="Enable support triage" aria-describedby="triage-readiness" onChange={(enabled) => void run("PUT", "/settings", { enabled }, enabled ? "Triage enabled." : "Triage turned off.")} />
        </div>
        <CredentialSetting kind="plain" configured={data.plainConfigured} disabled={disabled} run={run} />
        <CredentialSetting kind="slack" configured={data.slackConfigured} disabled={disabled} run={run} />
        <CredentialSetting kind="leads" configured={data.leadsSlackConfigured} disabled={disabled} run={run} />
        <div id="triage-readiness" className="flex min-h-11 flex-wrap items-center justify-between gap-2 border-b border-border py-1 text-sm">
          <span>Jev classification</span>
          {data.jevConfigured ? <span className="text-muted-foreground">Configured</span> : <FeatureIntroLockedAction reason="Deployment operator must configure Jev" />}
        </div>
        {feedback ? <DenNotice presentation="inline" {...feedback} /> : null}
      </> : null}
    </section>
    {!firstSetup ? <section className="space-y-2" aria-labelledby="triaged-threads-heading">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="triaged-threads-heading" className="text-sm font-semibold">Recent threads</h2>
        {!unfilteredEmpty ? <DenSelect aria-label="Filter by category" value={category} onChange={(event) => { setCategory(event.target.value); setOffset(0); }}>
          <option value="">All categories</option>
          {Object.entries(categoryLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </DenSelect> : null}
      </div>
      {threads.status !== "ready" && threads.status !== "loading" ? <DenNotice presentation="inline" message={threads.data ? "Couldn’t verify threads. Showing the last loaded results." : "Couldn’t load threads."}
        action={<DenButton size="sm" variant="secondary" onClick={refresh}>Try again</DenButton>} /> : null}
      {!threads.data && threads.status === "loading" ? <div role="status" aria-label="Loading threads" className="h-36 animate-pulse rounded-md bg-muted motion-reduce:animate-none" /> : null}
      {unfilteredEmpty && !help ? <FeatureIntroBox {...introControls} cta={data?.enabledAt ? null : cta} /> : null}
      {threads.data && !unfilteredEmpty ? <>
        <TriageThreads threads={threads.data.threads} />
        {offset || threads.data.total > limit ? <div className="flex items-center justify-end gap-2">
          <DenButton variant="secondary" size="sm" disabled={!offset || threads.status !== "ready"} onClick={() => setOffset(Math.max(0, offset - limit))}>Previous</DenButton>
          <DenButton variant="secondary" size="sm" disabled={offset + limit >= threads.data.total || threads.status !== "ready"} onClick={() => setOffset(offset + limit)}>Next</DenButton>
        </div> : null}
      </> : null}
    </section> : null}
  </div>;
}

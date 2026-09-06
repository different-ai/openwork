"use client";

import { useId, useState } from "react";
import { Globe, Info, Terminal, TriangleAlert, X } from "lucide-react";
import type { DesktopExecutionPolicy } from "@openwork/types/den/desktop-policies";
import { DenButton } from "../../_components/ui/button";
import { validateExecutionPolicy } from "./execution-policy-fields";
import { TeamPermissionGroup, TeamPermissionSelect } from "./team-permission-fields";
import { teamWebsiteSummary } from "./team-permission-state";

export function TeamExecutionFields({ value, onChange, onPendingSiteChange }: {
  value: DesktopExecutionPolicy;
  onChange: (value: DesktopExecutionPolicy) => void;
  onPendingSiteChange: (pending: boolean) => void;
}) {
  const id = useId();
  const [site, setSite] = useState("");
  const [siteError, setSiteError] = useState<string | null>(null);
  const [editingSites, setEditingSites] = useState(false);
  const [commandsText, setCommandsText] = useState(value.blockedCommands.join("\n"));
  const browserMode = value.browserOrigins === undefined ? "all" : value.browserOrigins.length || editingSites ? "approved" : "blocked";
  const commandsAllowed = value.commands === "allow";
  const restrictedBrowser = value.browserOrigins !== undefined || value.blockBrowserUploads;

  function changeSite(text: string) {
    setSite(text);
    setSiteError(null);
    onPendingSiteChange(Boolean(text.trim()));
  }

  function addSite() {
    try {
      const candidate = validateExecutionPolicy({ ...value, browserOrigins: [...(value.browserOrigins ?? []), site.trim()] });
      const origin = candidate.browserOrigins?.at(-1);
      if (origin && value.browserOrigins?.includes(origin)) {
        setSiteError("This website is already approved.");
        return;
      }
      onChange(candidate);
      changeSite("");
    } catch (error) {
      setSiteError(error instanceof Error ? error.message : "Enter a complete website address.");
    }
  }

  return <>
    <TeamPermissionGroup title="Browse websites" icon={Globe} defaultOpen status={browserMode === "all" ? "Allowed" : browserMode === "blocked" || value.browserOrigins?.length === 0 ? "Blocked" : "Approved sites only"} description={value.browserOrigins?.length === 0 ? "No websites are approved, so browsing is blocked" : `${teamWebsiteSummary(value)} · uploads and forms ${value.blockBrowserUploads ? "blocked" : "allowed"}`}>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-gray-100 py-3">
        <label htmlFor={`${id}-browser`} className="text-sm text-gray-800">Website access</label>
        <select id={`${id}-browser`} value={browserMode} onChange={(event) => {
          changeSite("");
          setEditingSites(event.target.value === "approved");
          if (event.target.value === "all") {
            const { browserOrigins: _origins, ...rest } = value;
            onChange(rest);
          } else onChange({ ...value, browserOrigins: event.target.value === "blocked" ? [] : value.browserOrigins ?? [] });
        }} className="max-w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-800">
          <option value="all">All websites</option><option value="approved">Approved sites only</option><option value="blocked">Blocked</option>
        </select>
      </div>
      {browserMode === "approved" ? <div className="pb-3">
        <ul aria-label="Approved websites" className="space-y-2">
          {value.browserOrigins?.map((origin) => <li key={origin} className="flex items-center gap-2 rounded-lg border border-gray-200 py-1 pl-3 pr-1">
            <span className="min-w-0 flex-1 break-all text-sm text-gray-700">{origin}</span>
            <DenButton variant="ghost" size="xs" aria-label={`Remove ${origin}`} onClick={() => { setEditingSites(true); setSiteError(null); onChange({ ...value, browserOrigins: value.browserOrigins?.filter((site) => site !== origin) }); }}><X aria-hidden="true" className="h-4 w-4" /></DenButton>
          </li>)}
        </ul>
        <div className="mt-2 flex gap-2">
          <input aria-label="Website address to approve" aria-invalid={Boolean(siteError)} aria-describedby={`${id}-site-help${siteError ? ` ${id}-site-error` : ""}`} type="url" placeholder="https://portal.example.com" value={site} onChange={(event) => changeSite(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addSite(); } }} className="min-w-0 flex-1 rounded-lg border border-gray-200 px-3 py-2 text-sm" />
          <DenButton variant="secondary" size="sm" disabled={!site.trim()} onClick={addSite}>Add site</DenButton>
        </div>
        {siteError ? <p id={`${id}-site-error`} role="alert" className="mt-2 text-xs text-red-700">{siteError}</p> : null}
        <p id={`${id}-site-help`} className="mt-2 text-xs leading-5 text-gray-500">Whole websites only. Add sign-in sites and subdomains separately. Up to 100 sites. {value.browserOrigins?.length === 0 ? "No sites are approved, so browsing is blocked." : null}</p>
      </div> : null}
      <TeamPermissionSelect label="Upload files & submit forms" allowed={!value.blockBrowserUploads} onChange={(allowed) => onChange({ ...value, blockBrowserUploads: !allowed })} />
      <div className="flex items-start gap-2 rounded-lg bg-gray-50 p-3 text-xs leading-5 text-gray-600"><Info aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" /><p>Applies to the built-in browser. {value.browserOrigins !== undefined ? "Separate web search and fetch tools are blocked while website restrictions are on. " : ""}These rules do not control other apps or third-party connections.</p></div>
      {commandsAllowed && restrictedBrowser ? <div role="status" className="mt-3 flex items-start gap-2 rounded-lg bg-amber-50 p-3 text-xs leading-5 text-amber-900"><TriangleAlert aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" /><div><p>Computer commands can still access other websites and send data.</p><DenButton variant="ghost" size="sm" className="mt-1 !px-0 !text-amber-900 underline underline-offset-4" onClick={() => onChange({ ...value, commands: "deny" })}>Block computer commands too</DenButton></div></div> : null}
    </TeamPermissionGroup>
    <TeamPermissionGroup title="Run computer commands" icon={Terminal} status={!commandsAllowed ? "Blocked" : value.blockedCommands.length ? "Some blocked" : "Allowed"} description={!commandsAllowed ? "Shell commands and interactive terminals are unavailable" : value.blockedCommands.length ? "Command patterns apply · saved commands and terminals blocked" : "Shell commands, saved commands, and interactive terminals"}>
      <TeamPermissionSelect label="Computer commands" allowed={commandsAllowed} onChange={(allowed) => onChange({ ...value, commands: allowed ? "allow" : "deny" })} />
      {commandsAllowed ? <details className="mt-2"><summary className="cursor-pointer text-xs text-gray-600">Advanced: block specific commands</summary><label htmlFor={`${id}-patterns`} className="mt-3 block text-sm text-gray-800">Blocked command patterns</label><textarea id={`${id}-patterns`} rows={3} value={commandsText} onChange={(event) => { setCommandsText(event.target.value); onChange({ ...value, blockedCommands: event.target.value.split("\n").filter((line) => line.trim()) }); }} className="mt-2 w-full rounded-lg border border-gray-200 p-3 text-sm" /><p className="mt-2 text-xs leading-5 text-gray-500">One pattern per line. Use * for any text. Patterns do not block every way of doing the same thing. Saved commands and interactive terminals are unavailable when patterns apply.</p></details> : null}
    </TeamPermissionGroup>
  </>;
}

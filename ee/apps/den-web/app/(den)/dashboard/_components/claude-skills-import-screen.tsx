"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowLeft, Check, FileText, KeyRound } from "lucide-react";
import { DenButton } from "../../_components/ui/button";
import { DenCheckbox } from "../../_components/ui/checkbox";
import { DenInput } from "../../_components/ui/input";
import { getRequestError, requestJson } from "../../_lib/den-flow";
import { getNewPluginRoute, getPluginRoute } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";

type ClaudeSkill = { id: string; displayName: string; updatedAt: string };
type ImportResult =
  | { skillId: string; name: string; ok: true; pluginId: string }
  | { skillId: string; name: string | null; ok: false; message: string };

/** Downloads can take a while for large skills; imports run one skill at a time. */
const IMPORT_TIMEOUT_MS = 10 * 60_000;

function parseSkills(payload: unknown): { skills: ClaudeSkill[]; truncated: boolean } {
  const value = payload as { skills?: unknown; truncated?: unknown } | null;
  const skills = Array.isArray(value?.skills) ? value.skills.flatMap((entry) => {
    const skill = entry as Partial<ClaudeSkill>;
    return typeof skill.id === "string" && typeof skill.displayName === "string"
      ? [{ id: skill.id, displayName: skill.displayName, updatedAt: typeof skill.updatedAt === "string" ? skill.updatedAt : "" }]
      : [];
  }) : [];
  return { skills, truncated: value?.truncated === true };
}

function parseResults(payload: unknown): ImportResult[] {
  const results = (payload as { results?: unknown } | null)?.results;
  return Array.isArray(results) ? results.filter((entry): entry is ImportResult => typeof (entry as ImportResult)?.skillId === "string") : [];
}

/**
 * Brings a team's custom skills over from Claude: the person enters an
 * Anthropic API key from the workspace that holds them, picks skills, and each
 * becomes a private OpenWork skill with all its files. The key stays in this
 * page's memory and is sent only with these two requests; OpenWork never stores it.
 */
export function ClaudeSkillsImportScreen() {
  const { orgSlug, runReauthableAction } = useOrgDashboard();
  const [apiKey, setApiKey] = useState("");
  const [skills, setSkills] = useState<ClaudeSkill[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [results, setResults] = useState<ImportResult[] | null>(null);
  const [busy, setBusy] = useState<"listing" | "importing" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function listSkills() {
    setBusy("listing");
    setError(null);
    setResults(null);
    try {
      let payload: unknown = null;
      await runReauthableAction("list-claude-skills", async () => {
        const result = await requestJson("/v1/plugins/anthropic-skills/preview", { method: "POST", body: JSON.stringify({ apiKey }) }, 60_000);
        if (!result.response.ok) throw getRequestError(result.payload, result.response, "Your skills could not be listed.");
        payload = result.payload;
      });
      const listed = parseSkills(payload);
      setSkills(listed.skills);
      setTruncated(listed.truncated);
      setSelected(listed.skills.map((skill) => skill.id));
    } catch (listError) {
      setError(listError instanceof Error ? listError.message : "Your skills could not be listed.");
    } finally {
      setBusy(null);
    }
  }

  async function importSelected() {
    setBusy("importing");
    setError(null);
    try {
      let payload: unknown = null;
      await runReauthableAction("import-claude-skills", async () => {
        const result = await requestJson("/v1/plugins/anthropic-skills/import", { method: "POST", body: JSON.stringify({ apiKey, skillIds: selected }) }, IMPORT_TIMEOUT_MS);
        if (!result.response.ok) throw getRequestError(result.payload, result.response, "Your skills could not be imported.");
        payload = result.payload;
      });
      setResults(parseResults(payload));
      // Nothing more needs the key.
      setApiKey("");
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : "Your skills could not be imported.");
    } finally {
      setBusy(null);
    }
  }

  const imported = results?.filter((result) => result.ok).length ?? 0;

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-10">
      <Link href={getNewPluginRoute(orgSlug)} className="mb-6 inline-flex items-center gap-2 text-[14px] text-gray-500 hover:text-gray-900">
        <ArrowLeft size={15} />
        Back to create
      </Link>

      <div>
        <h1 className="text-[28px] font-semibold text-gray-900">Import skills from Claude</h1>
        <p className="mt-1 text-[15px] text-gray-500">
          Bring your team&apos;s custom skills over with all their files. Each becomes a private skill you can share.
        </p>
      </div>

      <div className="mt-8 rounded-[24px] border border-gray-200 bg-white p-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <label className="min-w-0 flex-1">
            <span className="mb-1.5 block text-[13px] font-medium text-gray-700">Anthropic API key</span>
            <DenInput
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={apiKey}
              onChange={(event) => { setApiKey(event.target.value); setSkills(null); setResults(null); setError(null); }}
              placeholder="sk-ant-..."
              disabled={busy !== null}
            />
          </label>
          <DenButton onClick={() => void listSkills()} disabled={busy !== null || !apiKey.trim()}>
            <KeyRound size={15} />
            {busy === "listing" ? "Listing..." : "Show my skills"}
          </DenButton>
        </div>
        <p className="mt-2 text-[12px] text-gray-500">Use a key from the Claude Console workspace that holds the skills. OpenWork uses it only for this import and never stores it.</p>
      </div>

      {skills && !results ? (
        <div className="mt-6 rounded-[24px] border border-gray-200 bg-white p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-[18px] font-semibold text-gray-900">{skills.length === 0 ? "No custom skills in this workspace" : "Choose skills to import"}</h2>
              {truncated ? <p className="mt-1 text-[13px] text-gray-500">Only the first {skills.length} skills are listed. Import these, then run it again for the rest.</p> : null}
            </div>
            {skills.length > 0 ? <span className="rounded-full bg-gray-100 px-3 py-1 text-[12px] font-medium text-gray-600">{selected.length} selected</span> : null}
          </div>
          {skills.length > 0 ? (
            <div className="mt-5 overflow-hidden rounded-2xl border border-gray-100">
              {skills.map((skill) => (
                <label key={skill.id} className="flex items-center gap-3 border-b border-gray-100 px-4 py-3 last:border-b-0">
                  <DenCheckbox
                    checked={selected.includes(skill.id)}
                    disabled={busy !== null}
                    onCheckedChange={(checked) => setSelected((current) => checked ? [...new Set([...current, skill.id])] : current.filter((id) => id !== skill.id))}
                  />
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-gray-50 text-gray-500"><FileText size={16} /></span>
                  <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-gray-900">{skill.displayName}</span>
                </label>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {results ? (
        <div className="mt-6 rounded-[24px] border border-gray-200 bg-white p-6" data-testid="claude-import-results">
          <h2 className="text-[18px] font-semibold text-gray-900">Imported {imported} of {results.length}</h2>
          <div className="mt-5 overflow-hidden rounded-2xl border border-gray-100">
            {results.map((result) => (
              <div key={result.skillId} className="flex items-center gap-3 border-b border-gray-100 px-4 py-3 last:border-b-0">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] font-medium text-gray-900">{result.name ?? result.skillId}</span>
                  {!result.ok ? <span className="block text-[12px] text-red-700">{result.message}</span> : null}
                </span>
                {result.ok ? (
                  <Link href={getPluginRoute(orgSlug, result.pluginId)} className="inline-flex items-center gap-1.5 text-[13px] font-medium text-emerald-700 hover:text-emerald-800">
                    <Check size={14} />
                    Open
                  </Link>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {error ? (
        <div role="alert" className="mt-4 rounded-[16px] border border-red-200 bg-red-50 px-4 py-3 text-[14px] text-red-700">{error}</div>
      ) : null}

      {skills && skills.length > 0 && !results ? (
        <div className="mt-6 flex items-center justify-end gap-3">
          <Link href={getNewPluginRoute(orgSlug)} className="text-[14px] text-gray-500 hover:text-gray-900">Cancel</Link>
          <DenButton onClick={() => void importSelected()} disabled={busy !== null || selected.length === 0}>
            {busy === "importing" ? "Importing..." : `Import ${selected.length} skill${selected.length === 1 ? "" : "s"}`}
          </DenButton>
        </div>
      ) : null}
    </div>
  );
}

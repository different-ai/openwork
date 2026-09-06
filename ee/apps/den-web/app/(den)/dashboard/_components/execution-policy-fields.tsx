"use client";
import { useState } from "react";
import type { DesktopExecutionPolicy } from "@openwork/types/den/desktop-policies";

export function ExecutionPolicyFields({ value, onChange }: { value: DesktopExecutionPolicy; onChange: (value: DesktopExecutionPolicy) => void }) {
  const [commandsText, setCommandsText] = useState(value.blockedCommands.join("\n"));
  const [originsText, setOriginsText] = useState(value.browserOrigins?.join("\n") ?? "");
  return <section aria-label="Commands and browser access" className="rounded-xl border border-gray-200 bg-white">
    <div className="border-b border-gray-100 px-4 py-3 text-sm font-medium text-gray-900">Commands & browser</div>
    <div className="space-y-5 p-4">
      <label className="flex items-center justify-between gap-4 text-sm"><span>Run OS commands</span><input aria-label="Run OS commands" type="checkbox" checked={value.commands === "allow"} onChange={(event) => onChange({ ...value, commands: event.target.checked ? "allow" : "deny" })} /></label>
      <label className="block text-sm text-gray-800">Blocked command patterns<textarea aria-label="Blocked command patterns" className="mt-2 w-full rounded-lg border border-gray-200 p-3 text-sm" rows={2} value={commandsText} onChange={(event) => { setCommandsText(event.target.value); onChange({ ...value, blockedCommands: event.target.value.split("\n").filter((line) => line.trim()) }); }} /></label>
      <p className="text-xs text-gray-500">One pattern per line. Use * for any text. For complete command blocking, turn off OS commands above.</p>
      <label className="flex items-center justify-between gap-4 text-sm"><span>Restrict browsing to approved sites</span><input aria-label="Restrict browsing to approved sites" type="checkbox" checked={value.browserOrigins !== undefined} onChange={(event) => { if (event.target.checked) onChange({ ...value, browserOrigins: originsText.split("\n").map((line) => line.trim()).filter(Boolean) }); else { const { browserOrigins: _origins, ...rest } = value; onChange(rest); } }} /></label>
      {value.browserOrigins !== undefined ? <label className="block text-sm text-gray-800">Approved websites<textarea aria-label="Approved websites" className="mt-2 w-full rounded-lg border border-gray-200 p-3 text-sm" rows={3} placeholder="https://portal.example.com" value={originsText} onChange={(event) => { setOriginsText(event.target.value); onChange({ ...value, browserOrigins: event.target.value.split("\n").filter((line) => line.trim()) }); }} /><span className="mt-1 block text-xs text-gray-500">One complete site address per line. Subdomains must be added separately. An empty list blocks browsing. Include required sign-in and resource sites.</span></label> : null}
      <label className="flex items-center justify-between gap-4 text-sm"><span>Block browser uploads and form submissions</span><input aria-label="Block browser uploads and form submissions" type="checkbox" checked={value.blockBrowserUploads} onChange={(event) => onChange({ ...value, blockBrowserUploads: event.target.checked })} /></label>
      <p className="text-xs text-gray-500">Website rules apply to the built-in browser and web fetching. Disable OS commands to prevent scripts from bypassing browser restrictions. These settings do not control other apps on the device.</p>
    </div>
  </section>;
}

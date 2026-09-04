import { useState } from "react";
import { coworkerBridge, type CoworkerSummary, type CoworkerTemplateSync } from "@/lib/bridge";
import { Button, ErrorNote } from "@/ui/kit";

export function AssignedCoworkers({ signedIn, result, error, selected, onSync, onImported }: {
  signedIn: boolean;
  result: CoworkerTemplateSync | null;
  error: string;
  selected: CoworkerSummary | null;
  onSync: (installIds?: string[]) => Promise<void>;
  onImported: (result: CoworkerTemplateSync) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState("");
  const [notice, setNotice] = useState("");
  async function run(action: () => Promise<unknown>) {
    setBusy(true); setLocalError(""); setNotice("");
    try { await action(); }
    catch (cause) { setLocalError(cause instanceof Error ? cause.message : "Your coworker could not be added."); }
    finally { setBusy(false); }
  }
  return <section className="rounded-2xl border border-line bg-panel/50 p-5" data-testid="assigned-coworkers">
    <h3 className="text-sm font-semibold text-snow">Your team's coworkers</h3>
    <p className="mt-1 text-xs leading-5 text-mist">OpenWork Connect can give you a prepared team. Each coworker starts with its role and instructions, then builds its own memories and work with you.</p>
    {signedIn ? <>
      <Button className="mt-3" disabled={busy} onClick={() => void run(() => onSync())}>{busy ? "Updating team…" : "Refresh assigned coworkers"}</Button>
      {result?.items.length === 0 ? <p className="mt-3 text-xs text-mist">No coworker templates are available yet. Your admin can include them in a plugin and assign it to your team or marketplace.</p> : null}
      {result?.items.map((item) => <div key={item.id} className="mt-3 flex items-start justify-between gap-3 border-t border-line pt-3" data-testid="assigned-coworker" data-template-id={item.id}>
        <div className="min-w-0">
          <p className="text-xs font-medium text-snow">{item.template.name} · {item.template.role}</p>
          <p className="mt-1 text-xs text-mist">{item.template.description}</p>
          <p className="mt-1 text-[11px] text-mist">{item.installed ? (item.updateAvailable ? "Template updated · your working copy is preserved" : "Already added to this computer") : item.assigned ? "Assigned to you" : "Available to add"}</p>
        </div>
        {!item.installed ? <Button disabled={busy} onClick={() => void run(() => onSync([item.id]))}>Add coworker</Button> : null}
      </div>)}
    </> : <p className="mt-3 text-xs text-mist">Sign in to get the coworkers assigned to you, or import a template file.</p>}
    <div className="mt-4 flex flex-wrap gap-2">
      <Button disabled={busy} onClick={() => void run(async () => {
        const imported = await coworkerBridge.templates.import();
        if (imported) { onImported(imported); setNotice(imported.created.length ? "Coworker added." : "This template has already been added."); }
      })}>Import coworker template</Button>
      {selected ? <Button variant="ghost" disabled={busy} onClick={() => void run(async () => {
        if ((await coworkerBridge.templates.export(selected.slug)).saved) setNotice("Template exported. Import it into an OpenWork Connect plugin to share it.");
      })}>Export {selected.name}'s template</Button> : null}
    </div>
    <p className="mt-2 text-[11px] leading-5 text-mist">Templates carry a starting profile and reusable instructions. Conversations, evolving memory, files, credentials, and scheduled work stay here. Apps and models use your own access. Changes to a shared template do not replace your working copy.</p>
    {notice ? <p className="mt-3 text-xs text-mint" role="status">{notice}</p> : null}
    {localError || error ? <div className="mt-3"><ErrorNote>{localError || error}</ErrorNote></div> : null}
  </section>;
}

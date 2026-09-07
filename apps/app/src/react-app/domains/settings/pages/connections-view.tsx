/** @jsxImportSource react */
import { ArrowRight, Cable, Cpu, Monitor, Globe, Mic, Image } from "lucide-react";
import { isBuiltInOpenWorkExtension, type McpDirectoryInfo } from "../../../../app/constants";
import { getMcpIdentityKey } from "../../../../app/mcp";

export function ConnectionsView(props: {
  entries: McpDirectoryInfo[];
  onNavigate: (path: string) => void;
  builtInsDisabled: boolean;
}) {
  const builtIns = props.entries.filter(isBuiltInOpenWorkExtension);
  const groups = [
    { title: "On your computer", description: "Give OpenWork access to the apps and tools you use on this device.", entries: builtIns.filter((entry) => entry.extensionManifest?.id !== "ollama") },
    { title: "Local AI", description: "Run models on your computer with Ollama.", entries: builtIns.filter((entry) => entry.extensionManifest?.id === "ollama") },
  ];
  return (
    <div className="w-full max-w-3xl space-y-8" data-testid="connections-home">
      {props.builtInsDisabled ? <p role="status" className="rounded-xl border p-4 text-sm text-muted-foreground">Built-in features are disabled by your organization. You can review their setup, but cannot enable them.</p> : null}
      {groups.filter((group) => group.entries.length > 0).map((group) => (
        <section key={group.title} className="space-y-3" aria-label={group.title}>
          <div>
            <h3 className="text-sm font-medium">{group.title}</h3>
            <p className="mt-1 text-sm text-muted-foreground">{group.description}</p>
          </div>
          <div className="divide-y rounded-xl border bg-card">
            {group.entries.map((entry) => (
              <button key={getMcpIdentityKey(entry)} type="button"
                onClick={() => props.onNavigate(`connect/${encodeURIComponent(getMcpIdentityKey(entry))}`)}
                className="flex w-full items-center gap-4 p-4 text-left transition-colors first:rounded-t-xl last:rounded-b-xl hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted">
                  {entry.extensionManifest?.id === "ollama" ? <Cpu size={20} /> : entry.extensionManifest?.id === "openwork-browser" ? <Globe size={20} /> : entry.extensionManifest?.id === "openwork-voice" ? <Mic size={20} /> : entry.extensionManifest?.id === "computer-use" ? <Monitor size={20} /> : <Image size={20} />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">{entry.name}</span>
                  <span className="mt-1 block text-sm text-muted-foreground">{entry.extensionManifest?.id === "ollama" ? "Choose or download a local model." : entry.description}</span>
                </span>
                <ArrowRight size={16} className="shrink-0 text-muted-foreground" />
              </button>
            ))}
          </div>
        </section>
      ))}
      <section className="space-y-3" aria-label="Apps and services">
        <h3 className="text-sm font-medium">Apps and services</h3>
        <div className="grid gap-3 sm:grid-cols-2">
          {[
            { title: "Connected accounts", description: "Manage accounts and services available through your organization.", path: "extensions/connections" },
            { title: "Custom tools", description: "Connect an MCP server to this workspace.", path: "extensions/mcps" },
            { title: "AI providers", description: "Connect services that provide AI models.", path: "ai" },
          ].map((item) => (
            <button key={item.path} type="button" onClick={() => props.onNavigate(item.path)}
              className="flex items-start gap-3 rounded-xl border p-4 text-left transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring">
              <Cable size={18} className="mt-0.5 shrink-0 text-muted-foreground" />
              <span><span className="block text-sm font-medium">{item.title}</span><span className="mt-1 block text-sm text-muted-foreground">{item.description}</span></span>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

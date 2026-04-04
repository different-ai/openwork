import { useMemo, useState } from "react";
import { Cloud, FolderPlus, Globe, X } from "lucide-react";

import { pickDirectory } from "../../app/lib/tauri";
import { isTauriRuntime } from "../../app/utils";
import { useOpenworkStore } from "../kernel/store";
import { Button } from "../ui/button";
import { Card, CardQuiet } from "../ui/card";
import { Input } from "../ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";

function basename(path: string) {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const parts = normalized.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "workspace";
}

export function CreateWorkspaceDialog() {
  const open = useOpenworkStore((state) => state.createWorkspaceOpen);
  const setOpen = useOpenworkStore((state) => state.setCreateWorkspaceOpen);
  const createLocalWorkspace = useOpenworkStore((state) => state.createLocalWorkspace);
  const connectRemoteWorkspace = useOpenworkStore((state) => state.connectRemoteWorkspace);

  const [tab, setTab] = useState("local");
  const [folderPath, setFolderPath] = useState("");
  const [workspaceName, setWorkspaceName] = useState("");
  const [remoteHostUrl, setRemoteHostUrl] = useState("");
  const [remoteToken, setRemoteToken] = useState("");
  const [remoteName, setRemoteName] = useState("");
  const [remoteDirectory, setRemoteDirectory] = useState("");
  const [busy, setBusy] = useState(false);

  const localName = useMemo(() => workspaceName.trim() || basename(folderPath), [folderPath, workspaceName]);

  if (!open) return null;

  const handlePickFolder = async () => {
    const next = await pickDirectory({ title: "Choose workspace folder" }).catch(() => null);
    const selected = Array.isArray(next) ? next[0] : next;
    if (typeof selected === "string" && selected.trim()) {
      setFolderPath(selected.trim());
      if (!workspaceName.trim()) {
        setWorkspaceName(basename(selected.trim()));
      }
    }
  };

  const handleCreateLocal = async () => {
    if (!folderPath.trim()) return;
    setBusy(true);
    try {
      const ok = await createLocalWorkspace({
        folderPath: folderPath.trim(),
        name: localName,
        preset: "starter",
      });
      if (ok) setOpen(false);
    } finally {
      setBusy(false);
    }
  };

  const handleConnectRemote = async () => {
    if (!remoteHostUrl.trim() || !remoteToken.trim()) return;
    setBusy(true);
    try {
      const ok = await connectRemoteWorkspace({
        openworkHostUrl: remoteHostUrl.trim(),
        openworkToken: remoteToken.trim(),
        directory: remoteDirectory.trim() || null,
        displayName: remoteName.trim() || null,
        source: "manual",
      });
      if (ok) setOpen(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 px-4 py-6 backdrop-blur-[2px]">
      <Card className="w-full max-w-[640px] rounded-[28px] p-0">
        <div className="flex items-start justify-between border-b border-dls-border px-6 py-5">
          <div>
            <div className="ow-kicker">Workspace setup</div>
            <h2 className="mt-2 text-xl font-semibold text-dls-text">Create or connect a workspace</h2>
            <p className="mt-2 text-sm leading-6 text-dls-secondary">Start with a native local workspace or connect to an existing remote worker.</p>
          </div>
          <button className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-dls-border bg-dls-surface text-dls-secondary" onClick={() => setOpen(false)} type="button">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-6 py-5">
          <Tabs onValueChange={setTab} value={tab}>
            <TabsList className="grid gap-2 md:grid-cols-2">
              <TabsTrigger value="local">
                <div className="flex items-center gap-2 text-sm font-medium text-dls-text"><FolderPlus className="h-4 w-4" /> Local workspace</div>
                <div className="mt-1 text-sm leading-6 text-dls-secondary">Create a workspace on this device.</div>
              </TabsTrigger>
              <TabsTrigger value="remote">
                <div className="flex items-center gap-2 text-sm font-medium text-dls-text"><Globe className="h-4 w-4" /> Connect remote</div>
                <div className="mt-1 text-sm leading-6 text-dls-secondary">Attach to a worker URL and token.</div>
              </TabsTrigger>
            </TabsList>

            <TabsContent className="mt-4" value="local">
              <div className="space-y-4">
                <CardQuiet className="rounded-3xl p-5">
                  <div className="text-sm font-medium text-dls-text">Workspace folder</div>
                  <div className="mt-1 text-sm leading-6 text-dls-secondary">Choose where this workspace should live on your device.</div>
                  <div className="mt-4 rounded-[20px] border border-dls-border bg-dls-hover px-4 py-3 text-sm text-dls-secondary">
                    {folderPath.trim() || "No folder selected yet."}
                  </div>
                  <div className="mt-4 flex flex-wrap gap-2">
                    <Button onClick={() => void handlePickFolder()} type="button" variant="secondary">
                      <FolderPlus className="h-4 w-4" />
                      Select folder
                    </Button>
                    {!isTauriRuntime() ? <span className="text-xs text-dls-secondary">Desktop-only: folder picker is not available in the browser build.</span> : null}
                  </div>
                </CardQuiet>

                <CardQuiet className="rounded-3xl p-5">
                  <div className="text-sm font-medium text-dls-text">Workspace name</div>
                  <div className="mt-1 text-sm leading-6 text-dls-secondary">Use the current folder name or set a friendlier label.</div>
                  <div className="mt-4">
                    <Input id="openwork-create-workspace-name" name="openworkCreateWorkspaceName" onChange={(event) => setWorkspaceName(event.target.value)} placeholder="Workspace name" value={workspaceName} />
                  </div>
                </CardQuiet>

                <div className="flex justify-end gap-3 border-t border-dls-border pt-4">
                  <Button onClick={() => setOpen(false)} type="button" variant="secondary">Cancel</Button>
                  <Button disabled={!folderPath.trim() || busy || !isTauriRuntime()} onClick={() => void handleCreateLocal()} type="button">
                    Create workspace
                  </Button>
                </div>
              </div>
            </TabsContent>

            <TabsContent className="mt-4" value="remote">
              <div className="space-y-4">
                <CardQuiet className="rounded-3xl p-5">
                  <div className="flex items-center gap-2 text-sm font-medium text-dls-text"><Cloud className="h-4 w-4" /> Remote server details</div>
                  <div className="mt-1 text-sm leading-6 text-dls-secondary">Use the worker URL your OpenWork host shared with you. Add a token if the server requires one.</div>
                  <div className="mt-4 space-y-3">
                    <Input id="openwork-modal-remote-url" name="openworkModalRemoteUrl" onChange={(event) => setRemoteHostUrl(event.target.value)} placeholder="Worker URL" value={remoteHostUrl} />
                    <Input id="openwork-modal-remote-token" name="openworkModalRemoteToken" onChange={(event) => setRemoteToken(event.target.value)} placeholder="Access token" value={remoteToken} />
                    <Input id="openwork-modal-remote-name" name="openworkModalRemoteName" onChange={(event) => setRemoteName(event.target.value)} placeholder="Display name (optional)" value={remoteName} />
                    <Input id="openwork-modal-remote-directory" name="openworkModalRemoteDirectory" onChange={(event) => setRemoteDirectory(event.target.value)} placeholder="Directory hint (optional)" value={remoteDirectory} />
                  </div>
                </CardQuiet>

                <div className="flex justify-end gap-3 border-t border-dls-border pt-4">
                  <Button onClick={() => setOpen(false)} type="button" variant="secondary">Cancel</Button>
                  <Button disabled={!remoteHostUrl.trim() || !remoteToken.trim() || busy} onClick={() => void handleConnectRemote()} type="button">
                    Connect remote
                  </Button>
                </div>
              </div>
            </TabsContent>
          </Tabs>
        </div>
      </Card>
    </div>
  );
}

import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { Button } from "@/components/ui/button";

const sessionsSchema = z.array(z.object({
  connectionId: z.string(), id: z.string(), phase: z.enum(["approval", "working", "paused"]),
  appName: z.string(), task: z.string(), mode: z.enum(["observe", "assist", "control"]),
  recoverable: z.boolean().optional(),
  status: z.string().optional(), windowTitle: z.string().optional(), canContinue: z.boolean().optional(),
  previewVisible: z.boolean().optional(), remainingSeconds: z.number().optional(),
  windows: z.array(z.object({ id: z.number(), title: z.string() })).optional(),
}));
export function ComputerUseControls() {
  const [windows, setWindows] = useState<Record<string, number>>({});
  const state = useQuery({ queryKey: ["computer-use", "host"], enabled: Boolean(window.__OPENWORK_ELECTRON__?.invokeDesktop),
    queryFn: async () => {
      const invoke = window.__OPENWORK_ELECTRON__?.invokeDesktop;
      return invoke ? sessionsSchema.parse(await invoke("getComputerUseState")) : [];
    }, refetchInterval: 750, refetchIntervalInBackground: true, retry: false });
  const action = useMutation({ mutationFn: async (value: { connectionId: string; id: string; action: string; windowId?: number }) => {
    const invoke = window.__OPENWORK_ELECTRON__?.invokeDesktop;
    if (!invoke) throw new Error("Computer Use requires the desktop app.");
    await invoke("computerUseAction", value);
  }, onSuccess: () => state.refetch() });
  if (!state.data?.length) return null;
  return <aside aria-label="Computer Use controls" className="fixed bottom-6 right-6 z-50 flex w-96 max-w-[calc(100vw-3rem)] flex-col gap-3">
    {state.data.map((session) => {
      const approval = session.phase === "approval";
      const blocked = session.phase === "paused" && session.recoverable !== true;
      const selectedWindow = windows[session.id] ?? session.windows?.[0]?.id;
      const send = (command: string) => action.mutate({ connectionId: session.connectionId, id: session.id, action: command, windowId: selectedWindow });
      if (!approval && !blocked) {
        return session.previewVisible ? null : <Button key={session.connectionId} variant="outline" onClick={() => send("show")}>Show {session.appName} preview</Button>;
      }
      return <section key={session.connectionId} className="rounded-2xl border border-border bg-background p-4 shadow-lg">
        <p className="text-sm font-semibold">{approval ? `Use ${session.appName}?` : `Computer Use · ${session.appName}`}</p>
        <p className="mt-1 text-sm text-muted-foreground">{session.task}</p>
        {approval ? <>
          <label className="mt-3 block text-xs font-medium">Window
            <select aria-label="Window to allow" className="mt-1 w-full rounded-md border border-border bg-background p-2 text-sm" value={selectedWindow} onChange={(event) => setWindows({ ...windows, [session.id]: Number(event.target.value) })}>
              {session.windows?.map((window) => <option key={window.id} value={window.id}>{window.title}</option>)}
            </select>
          </label>
          <p className="my-3 text-xs text-muted-foreground">{session.mode === "observe" ? "Read this window. No clicks or typing." : session.mode === "assist" ? "Read and use this window’s app controls." : "Use this window’s mouse and keyboard. OpenWork yields to your input, then refreshes the window before continuing. Stop ends access."} Access lasts up to 15 minutes. Window content goes to your selected model provider.</p>
          <div className="flex justify-end gap-2"><Button variant="outline" onClick={() => send("deny")}>Cancel</Button><Button disabled={selectedWindow === undefined || action.isPending} onClick={() => send("approve")}>Allow and start</Button></div>
        </> : <>
          <p className="mt-2 truncate text-xs text-muted-foreground">{session.windowTitle} · {session.mode === "observe" ? "Read only" : session.mode === "assist" ? "App controls" : "Mouse and keyboard"}</p>
          <p role="status" className="my-3 text-sm">{session.status}</p>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" disabled={action.isPending || session.canContinue === false} onClick={() => send("resume")}>Continue</Button>
            <Button variant="destructive" onClick={() => send("stop")}>Stop</Button>

          </div>
        </>}
        {action.error ? <p role="alert" className="mt-2 text-sm text-destructive">{action.error.message}</p> : null}
      </section>;
    })}
  </aside>;
}

import { addInitScript, captureBrowserFilm, evaluate, reattachSurface, type Surface } from "@openwork/cdp";
import { setTimeout as wait } from "node:timers/promises";

type ReopenWitness = {
  firstComputer: string | null;
  firstDraft: string | null;
  sawLocalFallback: boolean;
  sawMissingTask: boolean;
};

type WitnessWindow = Window & { restartWitness?: ReopenWitness };

export function remoteTaskRestartBrowser(app: Surface) {
  const directory = process.env.OW_RESTART_FILM;
  const targets = async () => {
    const response = await fetch(`${app.handle.cdpUrl}/json/list`, { signal: AbortSignal.timeout(3000) });
    return response.json() as Promise<Array<{ id: string; url: string; type: string }>>;
  };
  return {
    recording: Boolean(directory),
    currentUrl: () => evaluate<string>(app.client, () => location.href),
    draft: () => evaluate(app.client, () => (document.querySelector('textarea[aria-label="Follow up"]') as HTMLTextAreaElement | null)?.value ?? ""),
    film: (name: string) => directory ? captureBrowserFilm(app, `${directory}/${name}`) : undefined,
    watchReopen: () => addInitScript(app.client, () => {
      // Sample the first visible frame, not the still-transparent route mount
      // or a later settled state that could hide a visible fallback.
      const witness: ReopenWitness = { firstComputer: null, firstDraft: null, sawLocalFallback: false, sawMissingTask: false };
      (window as WitnessWindow).restartWitness = witness;
      const visible = (element: Element | null) => Boolean(element?.checkVisibility({ opacityProperty: true, visibilityProperty: true }));
      const frame = () => {
        const header = document.querySelector('[data-remote-session-header] [data-remote-thread-computer]');
        const composerLabel = document.querySelector('[data-remote-follow-up-computer]');
        if (visible(header)) witness.firstComputer ??= header?.textContent?.trim() ?? "";
        witness.sawLocalFallback ||= [header, composerLabel].some(label => visible(label) && label?.textContent?.trim().toLowerCase() === "your computer");
        const editor = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Follow up"]');
        if (editor && visible(editor)) witness.firstDraft ??= editor.value;
        witness.sawMissingTask ||= visible(document.querySelector('[data-remote-session-missing]'));
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    }),
    reopenWitness: () => evaluate(app.client, () => (window as WitnessWindow).restartWitness),
    async typeForFilm(text: string) {
      for (const char of text) {
        await app.client.send("Input.insertText", { text: char });
        await wait(74);
      }
    },
    async replaceWindow() {
      // Keep the isolated Chrome profile, not the renderer. The separate blank window
      // gives CDP a real no-app frame between destroying and reopening the task.
      const oldTargetId = app.client.targetId;
      if (!oldTargetId) throw new Error("The original app window has no CDP target ID");
      const created = await app.client.send("Target.createTarget", { url: "about:blank", newWindow: true }) as { targetId: string };
      const close = await fetch(`${app.handle.cdpUrl}/json/close/${oldTargetId}`, { signal: AbortSignal.timeout(3000) });
      if (!close.ok) throw new Error(`Chrome did not close the original app window (${close.status})`);
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        if (!(await targets()).some(entry => entry.id === oldTargetId)) break;
        await wait(50);
      }
      const originalGone = !(await targets()).some(entry => entry.id === oldTargetId);
      if (!originalGone) throw new Error("Chrome still lists the original app window after closure");
      await reattachSurface(app);
      await app.client.send("Emulation.setFocusEmulationEnabled", { enabled: true });
      return { originalGone, replacementAttached: app.client.targetId === created.targetId && created.targetId !== oldTargetId };
    },
  };
}

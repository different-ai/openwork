import { addInitScript, browserScript, captureBrowserFilm, connect, debuggerUrlFor, evaluate, targetById, type Surface } from "@openwork/cdp";

interface LiveSyncWitness {
  initialStorage: [number, number];
  streamStatus: number;
  snapshot: boolean;
  liveUpdate: boolean;
}

declare global { interface Window { liveSyncProof?: LiveSyncWitness } }

export async function newRemoteTaskViewer(app: Surface, session: { token: string }, liveText: string) {
  const origin = await evaluate(app.client, () => location.origin);
  const version = await fetch(`${app.handle.cdpUrl}/json/version`, { signal: AbortSignal.timeout(5_000) }).then(response => response.json());
  const browser = await connect(version.webSocketDebuggerUrl);
  const { browserContextId } = await browser.send("Target.createBrowserContext", { disposeOnDetach: true }) as { browserContextId: string };
  try {
    const { targetId } = await browser.send("Target.createTarget", { url: "about:blank", browserContextId }) as { targetId: string };
    if (targetId === app.client.targetId) throw new Error("A separate browsing context was not created.");
    const target = await targetById(app.handle.cdpUrl, targetId);
    const client = await connect(debuggerUrlFor(app.handle.cdpUrl, target));
    const surface: Surface = { handle: { ...app.handle, name: "second-device" }, client };
    await client.send("Page.enable");
    await client.send("Network.enable");
    await client.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    await client.send("Page.bringToFront");
    await addInitScript(client, browserScript((origin, token, marker) => {
      if (location.origin !== origin) return;
      const witness: LiveSyncWitness = { initialStorage: [localStorage.length, sessionStorage.length], streamStatus: 0, snapshot: false, liveUpdate: false };
      window.liveSyncProof = witness;
      // Only authentication is planted, after inspecting this clean context's storage.
      localStorage.setItem("openwork.den.authToken", token);
      const fetchOriginal = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        const response = await fetchOriginal(input, init);
        const url = new URL(input instanceof Request ? input.url : String(input), location.href);
        if (url.pathname === "/v1/remote-sessions/stream" && response.headers.get("content-type")?.includes("text/event-stream")) {
          witness.streamStatus = response.status;
          const reader = response.clone().body?.getReader();
          if (reader) void (async () => {
            const decoder = new TextDecoder();
            let buffer = "";
            for (;;) {
              const next = await reader.read();
              if (next.done) break;
              buffer += decoder.decode(next.value, { stream: true });
              let split: number;
              while ((split = buffer.indexOf("\n\n")) >= 0) {
                const event = buffer.slice(0, split);
                buffer = buffer.slice(split + 2);
                witness.snapshot ||= event.startsWith("event: snapshot\n");
                witness.liveUpdate ||= event.startsWith("event: update\n") && event.includes(marker);
              }
            }
          })().catch(() => undefined);
        }
        return response;
      };
    }, [origin, session.token, liveText]));
    const filmDirectory = process.env.OW_LIVE_SYNC_FILM;
    return {
      surface, recording: Boolean(filmDirectory),
      film: () => filmDirectory ? captureBrowserFilm(surface, filmDirectory) : undefined,
      witness: () => evaluate(client, () => window.liveSyncProof),
      // After the first paint, forbid further tail/read HTTP responses so only
      // the open SSE connection can deliver the newly published transcript line.
      blockTranscriptRequests: () => client.send("Network.setBlockedURLs", { urls: ["*/v1/remote-sessions/tail/*", "*/v1/remote-sessions/read"] }),
      async [Symbol.asyncDispose]() {
        client.close();
        await browser.send("Target.disposeBrowserContext", { browserContextId }).catch(() => undefined);
        browser.close();
      },
    };
  } catch (error) {
    await browser.send("Target.disposeBrowserContext", { browserContextId }).catch(() => undefined);
    browser.close();
    throw error;
  }
}

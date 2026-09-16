if (process.versions.electron && process.type === "browser") {
  const original = globalThis.fetch.bind(globalThis);
  const controlUrl = "http://127.0.0.1/__openwork_archive_test_control";
  const modes = new Set(["none", "false", "error", "timeout", "unconfirmed", "hold", "retry", "permission", "question", "prompt_error", "hold_prompt", "accepted_command", "accepted_prompt", "hold_archive", "hold_messages"]);
  const state = { mode: "none", sessionId: "", workspaceId: "", requests: [] };
  const releases = new Set();
  let origin = "";
  let workspaceIds = new Set();
  let sequence = 0;
  const snapshot = () => ({ witness: "archive-main-fetch-v1", ...state, held: releases.size > 0, origin, workspaceIds: [...workspaceIds] });
  const hold = (request, record, resetMode = false) => new Promise((resolve, reject) => {
    const cleanup = () => {
      releases.delete(release);
      request.signal.removeEventListener("abort", abort);
    };
    const abort = () => {
      cleanup();
      record.result = "cancelled";
      reject(request.signal.reason);
    };
    const release = () => {
      cleanup();
      if (resetMode && state.mode === "hold") state.mode = "none";
      resolve();
    };
    releases.add(release);
    if (request.signal.aborted) abort();
    else request.signal.addEventListener("abort", abort, { once: true });
  });
  globalThis.fetch = async (input, init) => {
    const rawUrl = input instanceof Request ? input.url : String(input);
    if (rawUrl === controlUrl) {
      const request = new Request(input, init);
      if (request.method !== "POST") throw new Error("Archive witness control requires POST");
      const command = await request.json();
      if (command.action === "configure") {
        if (origin) throw new Error("Archive main witness is already configured");
        const target = new URL(command.origin);
        if (target.origin !== command.origin || target.protocol !== "http:"
          || !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname)
          || !Array.isArray(command.workspaceIds) || command.workspaceIds.length === 0
          || !command.workspaceIds.every(id => typeof id === "string" && id.length > 0)) {
          throw new Error("Archive witness requires an exact loopback origin and known workspaces");
        }
        origin = target.origin;
        workspaceIds = new Set(command.workspaceIds);
      } else if (command.action === "fault") {
        if (!origin || !modes.has(command.mode) || !workspaceIds.has(command.workspaceId)
          || typeof command.sessionId !== "string" || !command.sessionId) throw new Error("Invalid archive main fault target");
        if (releases.size) throw new Error("Release the previous archive fault before replacing it");
        state.mode = command.mode;
        state.sessionId = command.sessionId;
        state.workspaceId = command.workspaceId;
      } else if (command.action === "release") {
        if (!releases.size) throw new Error("No pending main archive request to release");
        for (const release of [...releases]) await release();
      } else if (command.action !== "state") {
        throw new Error("Unknown archive main witness control action");
      }
      return Response.json(snapshot());
    }
    const url = new URL(rawUrl);
    const mount = url.pathname.match(/^\/(?:workspace|w)\/([^/]+)\/opencode\/(.*)$/);
    if (url.origin !== origin || !mount || !workspaceIds.has(decodeURIComponent(mount[1]))) return original(input, init);
    const request = new Request(input, init);
    const workspaceId = decodeURIComponent(mount[1]);
    const endpoint = mount[2];
    const post = request.method === "POST" ? endpoint.match(/^session\/([^/]+)\/(abort|prompt_async|command|shell)$/) : null;
    const metadata = request.method === "PATCH" ? endpoint.match(/^session\/([^/]+)$/) : null;
    const read = request.method === "GET" ? endpoint.match(/^session\/([^/]+)(?:\/(message|todo))?$/) : null;
    const inventory = request.method === "GET" && ["session", "session/status", "permission", "question"].includes(endpoint);
    const record = post || metadata || read || inventory ? {
      path: url.pathname,
      sessionId: post?.[1] ?? metadata?.[1] ?? (inventory ? "" : read[1]),
      action: post?.[2] ?? (metadata ? "metadata" : inventory ? endpoint : read[2] === "message" ? "messages" : read[2] ?? "session"),
      messageID: null, result: null, at: Date.now(), sequence: sequence++, transport: "main",
    } : null;
    if (record) state.requests.push(record);
    if (record && ["prompt_async", "command"].includes(record.action)) {
      const body = await request.clone().json();
      if (typeof body?.messageID === "string") record.messageID = body.messageID;
      if (record.action === "command" && typeof body?.command === "string" && typeof body.arguments === "string") {
        record.command = { name: body.command, arguments: body.arguments,
          model: typeof body.model === "string" ? body.model : null,
          agent: typeof body.agent === "string" ? body.agent : null };
      }
    }
    const target = workspaceId === state.workspaceId && record?.sessionId === state.sessionId;
    if (record?.action === "metadata" && target && state.mode === "hold_archive") await hold(request, record);
    if (record && target && ((record.action === "command" && state.mode === "accepted_command")
      || (record.action === "prompt_async" && state.mode === "accepted_prompt"))) {
      record.result = "accepted, not dispatched";
      const admitted = new Request(request, { signal: new AbortController().signal });
      const release = async () => {
        releases.delete(release);
        try {
          const response = await original(admitted);
          record.result = response.status;
          record.responseBody = (await response.text()).slice(0, 2000);
          if (!response.ok) throw new Error("Admitted " + record.action + " dispatch failed: " + response.status + " " + record.responseBody);
        } catch (error) {
          record.dispatchError = error instanceof Error ? error.message : String(error);
          throw error;
        }
      };
      releases.add(release);
      return record.action === "prompt_async" ? new Response(null, { status: 204 }) : Response.json({ ok: true, accepted: true });
    }
    if (record?.action === "prompt_async" && target && state.mode === "prompt_error") {
      record.result = 400;
      return Response.json({ error: "Injected send failure" }, { status: 400 });
    }
    if (record?.action === "prompt_async" && target && state.mode === "hold_prompt") {
      await hold(request, record);
      record.result = 400;
      return Response.json({ error: "Injected delayed queue send failure" }, { status: 400 });
    }
    if (record?.action === "abort" && target && ["false", "error", "timeout", "unconfirmed", "hold"].includes(state.mode)) {
      const mode = state.mode;
      if (mode === "hold" || mode === "timeout") await hold(request, record, true);
      else {
        record.result = mode;
        if (mode === "error") throw new TypeError("Injected abort connection failure");
        return Response.json(mode === "unconfirmed");
      }
    }
    let response;
    try {
      response = await original(request);
    } catch (error) {
      if (record) record.result = request.signal.aborted ? "cancelled" : "error";
      throw error;
    }
    if (record) record.result = response.status;
    if (record?.action === "messages" && target && state.mode === "hold_messages" && response.ok) {
      const body = new Uint8Array(await response.arrayBuffer());
      const stream = new ReadableStream({
        start(controller) {
          record.result = "held";
          let cancelled = false;
          const abort = () => {
            cancelled = true;
            record.cancelled = true;
            controller.error(request.signal.reason);
          };
          const finish = (expired) => {
            if (record.result !== "held") return;
            clearTimeout(timer);
            releases.delete(release);
            request.signal.removeEventListener("abort", abort);
            record.result = expired ? "expired" : "released";
            if (!cancelled) {
              controller.enqueue(body);
              controller.close();
            }
          };
          const release = () => finish(false);
          const timer = setTimeout(() => finish(true), 20_000);
          releases.add(release);
          if (request.signal.aborted) abort();
          else request.signal.addEventListener("abort", abort, { once: true });
        },
      });
      return new Response(stream, { status: response.status, headers: response.headers });
    }
    const { mode, sessionId, workspaceId: armedWorkspaceId } = state;
    const stillArmed = () => state.mode === mode && state.sessionId === sessionId && state.workspaceId === armedWorkspaceId;
    if (workspaceId === armedWorkspaceId && response.ok && mode === "retry" && endpoint === "session/status") {
      const statuses = await response.clone().json();
      if (!stillArmed()) return response;
      return Response.json({ ...statuses, [sessionId]: { type: "retry", attempt: 1, message: "Retrying", next: Date.now() + 60000 } });
    }
    if (workspaceId === armedWorkspaceId && response.ok && (mode === "permission" || mode === "question") && endpoint === mode) {
      const requests = await response.clone().json();
      if (!stillArmed()) return response;
      return Response.json([...requests, { id: "archive-pending-request", sessionID: sessionId,
        permission: "bash", patterns: ["*"], metadata: {}, always: [],
        questions: [{ question: "Continue?", header: "Continue", options: [{ label: "Yes", description: "Continue" }] }],
      }]);
    }
    return response;
  };
}

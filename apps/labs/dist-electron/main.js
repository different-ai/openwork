import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { createOpencode, createOpencodeClient, } from "@opencode-ai/sdk/v2";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "..");
const rendererUrl = process.env.OPENWORK_LABS_RENDERER_URL ?? "http://127.0.0.1:4174";
const smokeWorkspaceDir = process.env.OPENWORK_LABS_SMOKE_WORKSPACE_DIR ?? "";
const smokePrompt = process.env.OPENWORK_LABS_SMOKE_PROMPT ?? "";
const configDir = path.join(app.getPath("userData"), "labs");
const configFile = path.join(configDir, "workspace.json");
const logFile = path.join(configDir, "runtime.log");
let mainWindow = null;
let localOpencode = null;
let activeClient = null;
let activeDirectory;
let eventAbort = null;
let syncTimer = null;
let connection = { kind: "none" };
let sessions = [];
let currentSessionID = null;
let messages = [];
const logs = [];
const sessionStatuses = new Map();
const pendingSync = { sessions: false, messages: false };
function snapshot() {
    return { connection, sessions, currentSessionID, messages };
}
function emitState() {
    mainWindow?.webContents.send("ow:state", snapshot());
}
function pushLog(scope, level, message) {
    const entry = { id: randomUUID(), scope, level, message, at: new Date().toISOString() };
    logs.push(entry);
    if (logs.length > 500)
        logs.splice(0, logs.length - 500);
    mainWindow?.webContents.send("ow:log", entry);
    void appendFile(logFile, `[${entry.at}] [${scope}] [${level}] ${message}\n`).catch(() => undefined);
}
async function saveConnection() {
    await mkdir(configDir, { recursive: true });
    if (connection.kind === "none") {
        await writeFile(configFile, "null", "utf8");
        return;
    }
    await writeFile(configFile, JSON.stringify(connection), "utf8");
}
async function loadConnection() {
    try {
        const raw = await readFile(configFile, "utf8");
        if (!raw.trim() || raw.trim() === "null")
            return null;
        const parsed = JSON.parse(raw);
        if (parsed.kind === "local" || parsed.kind === "remote")
            return parsed;
        return null;
    }
    catch {
        return null;
    }
}
function clientOrThrow() {
    if (!activeClient) {
        throw new Error("No active opencode connection");
    }
    return activeClient;
}
function requestArgs(input) {
    if (!activeDirectory) {
        return { ...(input ?? {}) };
    }
    return { ...(input ?? {}), directory: activeDirectory };
}
function formatOpencodeError(error) {
    if (!error)
        return "Unknown error";
    if (error instanceof Error)
        return error.message;
    if (typeof error === "string")
        return error;
    if (typeof error === "object") {
        const value = error;
        if (typeof value.data?.message === "string" && value.data.message.trim()) {
            return value.data.message;
        }
        if (typeof value.name === "string" && value.name.trim()) {
            return value.name;
        }
    }
    return JSON.stringify(error);
}
function basicAuthHeader(username, password) {
    return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}
function localServerHeaders() {
    const password = process.env.OPENCODE_SERVER_PASSWORD?.trim();
    if (!password)
        return undefined;
    const username = process.env.OPENCODE_SERVER_USERNAME?.trim() || "opencode";
    return { Authorization: basicAuthHeader(username, password) };
}
function isSessionActive(status) {
    return status?.type === "busy" || status?.type === "retry";
}
function toSessionSummary(session) {
    return {
        id: session.id,
        title: session.title || "Untitled chat",
        createdAt: new Date(session.time.created).toISOString(),
        updatedAt: new Date(session.time.updated).toISOString(),
        active: isSessionActive(sessionStatuses.get(session.id)),
    };
}
function partText(part) {
    if (part.type === "text") {
        return part.text;
    }
    if (part.type === "tool" && part.state.status === "error") {
        return `Tool ${part.tool} failed: ${part.state.error}`;
    }
    return "";
}
function messageText(info, parts) {
    const text = parts
        .map((part) => partText(part))
        .filter((value) => value.length > 0)
        .join("");
    if (text.trim())
        return text;
    if (info.role === "assistant" && info.error)
        return formatOpencodeError(info.error);
    return "";
}
function toMessage(entry) {
    return {
        id: entry.info.id,
        role: entry.info.role === "assistant" && entry.info.error ? "error" : entry.info.role,
        text: messageText(entry.info, entry.parts),
        createdAt: new Date(entry.info.time.created).toISOString(),
    };
}
function resetSnapshot() {
    sessions = [];
    currentSessionID = null;
    messages = [];
    sessionStatuses.clear();
}
async function refreshSessions() {
    const sdk = clientOrThrow();
    const [listResult, statusResult] = await Promise.all([
        sdk.session.list(requestArgs({ roots: true, limit: 100 })),
        sdk.session.status(requestArgs()),
    ]);
    if (listResult.error)
        throw new Error(formatOpencodeError(listResult.error));
    if (statusResult.error)
        throw new Error(formatOpencodeError(statusResult.error));
    sessionStatuses.clear();
    for (const [sessionID, status] of Object.entries(statusResult.data ?? {})) {
        sessionStatuses.set(sessionID, status);
    }
    sessions = (listResult.data ?? []).map((session) => toSessionSummary(session));
    if (!currentSessionID && sessions[0])
        currentSessionID = sessions[0].id;
    if (currentSessionID && !sessions.some((session) => session.id === currentSessionID)) {
        currentSessionID = sessions[0]?.id ?? null;
    }
}
async function refreshMessages() {
    if (!currentSessionID) {
        messages = [];
        return;
    }
    const result = await clientOrThrow().session.messages(requestArgs({ sessionID: currentSessionID, limit: 200 }));
    if (result.error)
        throw new Error(formatOpencodeError(result.error));
    messages = (result.data ?? []).map((entry) => toMessage(entry));
}
function queueSync(request) {
    pendingSync.sessions ||= request.sessions === true;
    pendingSync.messages ||= request.messages === true;
    if (syncTimer)
        return;
    syncTimer = setTimeout(() => {
        syncTimer = null;
        const next = { ...pendingSync };
        pendingSync.sessions = false;
        pendingSync.messages = false;
        void (async () => {
            if (next.sessions)
                await refreshSessions();
            if (next.messages)
                await refreshMessages();
            emitState();
        })().catch((error) => {
            pushLog("main", "error", formatOpencodeError(error));
        });
    }, 75);
}
function applyEvent(event) {
    if (event.type === "session.created" || event.type === "session.updated" || event.type === "session.deleted") {
        queueSync({ sessions: true, messages: event.type !== "session.deleted" });
        return;
    }
    if (event.type === "session.status" || event.type === "session.idle") {
        queueSync({ sessions: true, messages: event.properties.sessionID === currentSessionID });
        return;
    }
    if (event.type === "message.updated") {
        queueSync({ sessions: true, messages: event.properties.info.sessionID === currentSessionID });
        return;
    }
    if (event.type === "message.removed") {
        queueSync({ messages: event.properties.sessionID === currentSessionID });
        return;
    }
    if (event.type === "message.part.updated") {
        queueSync({ messages: event.properties.part.sessionID === currentSessionID });
        return;
    }
    if (event.type === "message.part.removed") {
        queueSync({ messages: event.properties.sessionID === currentSessionID });
        return;
    }
    if (event.type === "session.error") {
        pushLog("host", "error", formatOpencodeError(event.properties.error));
        queueSync({ sessions: true, messages: event.properties.sessionID === currentSessionID });
        return;
    }
}
async function openEventStream() {
    eventAbort?.abort();
    const controller = new AbortController();
    eventAbort = controller;
    const stream = await clientOrThrow().event.subscribe(requestArgs(), { signal: controller.signal });
    void (async () => {
        for await (const event of stream.stream) {
            applyEvent(event);
            if (controller.signal.aborted)
                break;
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
    })().catch((error) => {
        if (!controller.signal.aborted) {
            pushLog("main", "error", formatOpencodeError(error));
        }
    });
}
async function stopLocalHost() {
    eventAbort?.abort();
    eventAbort = null;
    if (syncTimer) {
        clearTimeout(syncTimer);
        syncTimer = null;
    }
    pendingSync.sessions = false;
    pendingSync.messages = false;
    connection = { kind: "none" };
    resetSnapshot();
    activeClient = null;
    activeDirectory = undefined;
    sessionStatuses.clear();
    if (!localOpencode)
        return;
    localOpencode.server.close();
    localOpencode = null;
    pushLog("host", "info", "Embedded opencode server stopped");
}
async function connectLocal(workspacePath) {
    await stopLocalHost();
    pushLog("host", "info", `Starting embedded opencode for ${workspacePath}`);
    localOpencode = await createOpencode({ hostname: "127.0.0.1", port: 0 });
    activeClient = createOpencodeClient({ baseUrl: localOpencode.server.url, headers: localServerHeaders() });
    const health = await activeClient.global.health();
    if (health.error || health.data?.healthy !== true) {
        throw new Error(formatOpencodeError(health.error ?? "Embedded opencode health check failed"));
    }
    activeDirectory = workspacePath;
    connection = { kind: "local", workspacePath, url: localOpencode.server.url };
    resetSnapshot();
    await refreshSessions();
    await refreshMessages();
    await openEventStream();
    emitState();
    pushLog("host", "info", `Embedded opencode ready at ${localOpencode.server.url}`);
    pushLog("main", "info", `Connected local workspace ${workspacePath}`);
    await saveConnection();
    return snapshot();
}
async function connectRemote(urlInput, token) {
    await stopLocalHost();
    const url = urlInput.trim().replace(/\/$/, "");
    const trimmedToken = token.trim();
    const headers = trimmedToken ? { Authorization: `Bearer ${trimmedToken}` } : undefined;
    const client = createOpencodeClient({ baseUrl: url, headers });
    const health = await client.global.health();
    if (health.error || health.data?.healthy !== true) {
        throw new Error(formatOpencodeError(health.error ?? `Remote opencode health check failed for ${url}`));
    }
    activeClient = client;
    activeDirectory = undefined;
    connection = { kind: "remote", url, token: trimmedToken };
    resetSnapshot();
    await refreshSessions();
    await refreshMessages();
    await openEventStream();
    emitState();
    pushLog("main", "info", `Connected remote ${connection.url}`);
    await saveConnection();
    return snapshot();
}
async function runMainSmokeFlow(promptValue) {
    const created = await clientOrThrow().session.create(requestArgs({ title: "Smoke chat" }));
    if (created.error || !created.data) {
        throw new Error(formatOpencodeError(created.error ?? "Smoke session create failed"));
    }
    currentSessionID = created.data.id;
    await refreshSessions();
    await refreshMessages();
    pushLog("main", "info", `Smoke created session ${created.data.id}`);
    const prompt = await clientOrThrow().session.promptAsync(requestArgs({
        sessionID: created.data.id,
        parts: [{ type: "text", text: promptValue }],
    }));
    if (prompt.error)
        throw new Error(formatOpencodeError(prompt.error));
    pushLog("main", "info", `Smoke prompt submitted for ${created.data.id}`);
    await waitForAssistantReply(created.data.id);
    emitState();
}
async function waitForAssistantReply(sessionID, timeoutMs = 30_000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        currentSessionID = sessionID;
        await refreshMessages();
        await refreshSessions();
        const done = messages.some((message) => (message.role === "assistant" || message.role === "error") && message.text.trim().length > 0);
        if (done) {
            pushLog("main", "info", `Assistant reply observed for ${sessionID}`);
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    pushLog("main", "error", `Assistant reply timeout for ${sessionID}; last messages=${JSON.stringify(messages)}`);
    throw new Error(`Timed out waiting for assistant reply for session ${sessionID}`);
}
async function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1400,
        height: 920,
        webPreferences: {
            contextIsolation: true,
            preload: path.resolve(__dirname, "preload.cjs"),
        },
    });
    if (process.env.OPENWORK_LABS_DEV === "1") {
        await mainWindow.loadURL(rendererUrl);
    }
    else {
        await mainWindow.loadFile(path.resolve(packageRoot, "dist", "index.html"));
    }
}
ipcMain.handle("ow:getSnapshot", () => snapshot());
ipcMain.handle("ow:getLogs", () => logs);
ipcMain.handle("ow:createWorkspace", async () => {
    const result = await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] });
    if (result.canceled || result.filePaths.length === 0)
        return snapshot();
    return connectLocal(result.filePaths[0]);
});
ipcMain.handle("ow:connectRemote", async (_event, payload) => {
    return connectRemote(payload.url, payload.token);
});
ipcMain.handle("ow:createSession", async () => {
    const created = await clientOrThrow().session.create(requestArgs({}));
    if (created.error || !created.data) {
        throw new Error(formatOpencodeError(created.error ?? "Session create failed"));
    }
    currentSessionID = created.data.id;
    await refreshSessions();
    await refreshMessages();
    emitState();
    return snapshot();
});
ipcMain.handle("ow:selectSession", async (_event, sessionID) => {
    currentSessionID = sessionID;
    await refreshMessages();
    emitState();
    return snapshot();
});
ipcMain.handle("ow:sendPrompt", async (_event, payload) => {
    pushLog("main", "info", `Sending prompt for ${payload.sessionID}`);
    const result = await clientOrThrow().session.promptAsync(requestArgs({
        sessionID: payload.sessionID,
        parts: [{ type: "text", text: payload.prompt }],
    }));
    if (result.error)
        throw new Error(formatOpencodeError(result.error));
    await refreshSessions();
    await refreshMessages();
    return snapshot();
});
ipcMain.handle("ow:abortSession", async (_event, sessionID) => {
    const result = await clientOrThrow().session.abort(requestArgs({ sessionID }));
    if (result.error)
        throw new Error(formatOpencodeError(result.error));
    await refreshSessions();
    await refreshMessages();
    return snapshot();
});
ipcMain.on("ow:rendererLog", (_event, payload) => {
    pushLog("renderer", payload.level === "error" ? "error" : "info", payload.message);
});
app.on("before-quit", () => {
    void stopLocalHost();
});
app.whenReady().then(async () => {
    await mkdir(configDir, { recursive: true });
    pushLog("main", "info", "Labs shell ready");
    await createWindow();
    const persisted = await loadConnection();
    if (persisted?.kind === "local") {
        try {
            await connectLocal(persisted.workspacePath);
        }
        catch (error) {
            pushLog("main", "error", `Failed to restore local workspace: ${String(error)}`);
            connection = { kind: "none" };
            await saveConnection();
        }
    }
    if (persisted?.kind === "remote") {
        try {
            await connectRemote(persisted.url, persisted.token);
        }
        catch (error) {
            pushLog("main", "error", `Failed to restore remote workspace: ${String(error)}`);
            connection = { kind: "none" };
            await saveConnection();
        }
    }
    if (smokeWorkspaceDir) {
        try {
            await connectLocal(smokeWorkspaceDir);
            pushLog("main", "info", `Smoke connected local workspace ${smokeWorkspaceDir}`);
            if (smokePrompt.trim()) {
                await runMainSmokeFlow(smokePrompt);
                pushLog("main", "info", `Smoke prompt completed`);
            }
            emitState();
        }
        catch (error) {
            pushLog("main", "error", `Smoke flow failed: ${String(error)}`);
        }
    }
    emitState();
});

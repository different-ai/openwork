import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { access, appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { app, BrowserWindow, dialog, ipcMain } from "electron";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(packageRoot, "..", "..");
const hostPackageRoot = path.resolve(repoRoot, "apps", "openwork-host");
const hostEntry = path.resolve(hostPackageRoot, "dist", "index.js");
const rendererUrl = process.env.OPENWORK_LABS_RENDERER_URL ?? "http://127.0.0.1:4174";
const smokeWorkspaceDir = process.env.OPENWORK_LABS_SMOKE_WORKSPACE_DIR ?? "";
const smokePrompt = process.env.OPENWORK_LABS_SMOKE_PROMPT ?? "";
const configDir = path.join(app.getPath("userData"), "labs");
const configFile = path.join(configDir, "workspace.json");
const logFile = path.join(configDir, "runtime.log");
let mainWindow = null;
let localHost = null;
let eventAbort = null;
let connection = { kind: "none" };
let sessions = [];
let currentSessionID = null;
let messages = [];
const logs = [];
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
async function ensureHostBuilt() {
    try {
        await access(hostEntry);
        return;
    }
    catch {
        pushLog("main", "info", "Building openwork-host before launch");
        const child = spawn("pnpm", ["--filter", "openwork-host", "build"], {
            cwd: repoRoot,
            stdio: ["ignore", "pipe", "pipe"],
        });
        child.stdout.on("data", (chunk) => pushLog("main", "info", String(chunk).trim()));
        child.stderr.on("data", (chunk) => pushLog("main", "error", String(chunk).trim()));
        const [code] = (await once(child, "exit"));
        if (code !== 0) {
            throw new Error(`openwork-host build failed with code ${code}`);
        }
    }
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
async function getPort() {
    const server = net.createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    server.close();
    if (!address || typeof address === "string")
        throw new Error("Unable to allocate port");
    return address.port;
}
function baseUrl() {
    if (connection.kind === "local" || connection.kind === "remote")
        return connection.url;
    throw new Error("No active connection");
}
function authHeaders() {
    if (connection.kind === "remote" && connection.token) {
        return { Authorization: `Bearer ${connection.token}` };
    }
    return {};
}
async function api(pathname, init) {
    const response = await fetch(`${baseUrl()}${pathname}`, {
        ...init,
        headers: {
            "content-type": "application/json",
            ...authHeaders(),
            ...(init?.headers ?? {}),
        },
    });
    if (!response.ok) {
        const text = await response.text();
        throw new Error(text || `${response.status} ${response.statusText}`);
    }
    return response.json();
}
async function refreshSessions() {
    const data = (await api("/session", { method: "GET" }));
    sessions = data.sessions;
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
    const data = (await api(`/session/${currentSessionID}/message`, { method: "GET" }));
    messages = data.messages;
}
function upsertSession(summary) {
    const existing = sessions.findIndex((session) => session.id === summary.id);
    if (existing >= 0) {
        sessions[existing] = summary;
    }
    else {
        sessions = [summary, ...sessions];
    }
    sessions = [...sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
function applyHostEvent(event) {
    if (event.type === "session.created") {
        upsertSession(event.session);
        currentSessionID = event.session.id;
        messages = [];
    }
    if (event.type === "session.updated") {
        upsertSession(event.session);
    }
    if (event.type === "message.created" && event.sessionID === currentSessionID) {
        messages = [...messages, event.message];
    }
    if (event.type === "message.delta" && event.sessionID === currentSessionID) {
        messages = messages.map((message) => message.id === event.messageID ? { ...message, text: `${message.text}${event.delta}` } : message);
    }
    if (event.type === "run.failed") {
        pushLog("host", "error", event.error);
    }
    emitState();
}
async function openEventStream() {
    eventAbort?.abort();
    const controller = new AbortController();
    eventAbort = controller;
    const response = await fetch(`${baseUrl()}/event`, {
        method: "GET",
        headers: { Accept: "text/event-stream", ...authHeaders() },
        signal: controller.signal,
    });
    if (!response.ok || !response.body)
        throw new Error(`SSE failed: ${response.status}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const read = async () => {
        while (!controller.signal.aborted) {
            const { done, value } = await reader.read();
            if (done)
                break;
            buffer += decoder.decode(value, { stream: true });
            const frames = buffer.split("\n\n");
            buffer = frames.pop() ?? "";
            for (const frame of frames) {
                const dataLine = frame
                    .split("\n")
                    .find((line) => line.startsWith("data:"));
                if (!dataLine)
                    continue;
                const payload = dataLine.slice(5).trim();
                if (!payload)
                    continue;
                applyHostEvent(JSON.parse(payload));
            }
        }
    };
    void read().catch((error) => {
        if (!controller.signal.aborted)
            pushLog("main", "error", String(error));
    });
}
async function stopLocalHost() {
    eventAbort?.abort();
    eventAbort = null;
    if (!localHost)
        return;
    localHost.kill();
    await once(localHost, "exit").catch(() => undefined);
    localHost = null;
}
async function waitForHealth(url) {
    for (let attempt = 0; attempt < 80; attempt += 1) {
        try {
            const response = await fetch(`${url}/global/health`);
            if (response.ok)
                return;
        }
        catch {
            // Retry until the child is ready.
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error("openwork-host did not become healthy in time");
}
async function connectLocal(workspacePath) {
    await stopLocalHost();
    await ensureHostBuilt();
    const port = await getPort();
    const child = spawn(process.execPath, [hostEntry], {
        cwd: hostPackageRoot,
        env: {
            ...process.env,
            PORT: String(port),
            OPENWORK_HOST_WORKSPACE_DIR: workspacePath,
        },
        stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => pushLog("host", "info", String(chunk).trim()));
    child.stderr.on("data", (chunk) => pushLog("host", "error", String(chunk).trim()));
    child.on("exit", (code, signal) => pushLog("host", code === 0 ? "info" : "error", `host exited code=${code} signal=${signal}`));
    localHost = child;
    const url = `http://127.0.0.1:${port}`;
    await waitForHealth(url);
    connection = { kind: "local", workspacePath, url };
    sessions = [];
    currentSessionID = null;
    messages = [];
    await refreshSessions();
    await refreshMessages();
    await openEventStream();
    emitState();
    pushLog("main", "info", `Connected local workspace ${workspacePath}`);
    await saveConnection();
    return snapshot();
}
async function connectRemote(urlInput, token) {
    await stopLocalHost();
    connection = { kind: "remote", url: urlInput.replace(/\/$/, ""), token };
    sessions = [];
    currentSessionID = null;
    messages = [];
    await refreshSessions();
    await refreshMessages();
    await openEventStream();
    emitState();
    pushLog("main", "info", `Connected remote ${connection.url}`);
    await saveConnection();
    return snapshot();
}
async function runMainSmokeFlow(promptValue) {
    const data = (await api("/session", { method: "POST", body: JSON.stringify({ title: "Smoke chat" }) }));
    currentSessionID = data.session.id;
    messages = [];
    upsertSession(data.session);
    pushLog("main", "info", `Smoke created session ${data.session.id}`);
    await api(`/session/${data.session.id}/prompt_async`, {
        method: "POST",
        body: JSON.stringify({ prompt: promptValue }),
    });
    pushLog("main", "info", `Smoke prompt submitted for ${data.session.id}`);
    await waitForAssistantReply(data.session.id);
    emitState();
}
async function waitForAssistantReply(sessionID, timeoutMs = 30_000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        currentSessionID = sessionID;
        await refreshMessages();
        await refreshSessions();
        const done = messages.some((message) => message.role === "assistant" && message.text.trim().length > 0);
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
    const data = (await api("/session", { method: "POST", body: JSON.stringify({}) }));
    currentSessionID = data.session.id;
    messages = [];
    upsertSession(data.session);
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
    await api(`/session/${payload.sessionID}/prompt_async`, {
        method: "POST",
        body: JSON.stringify({ prompt: payload.prompt }),
    });
    return snapshot();
});
ipcMain.handle("ow:abortSession", async (_event, sessionID) => {
    await api(`/session/${sessionID}/abort`, { method: "POST", body: JSON.stringify({}) });
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

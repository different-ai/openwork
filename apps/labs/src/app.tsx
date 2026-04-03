import { FormEvent, useEffect, useMemo, useState } from "react";
import type { LogEntry, Snapshot } from "./types";

const emptySnapshot: Snapshot = {
  connection: { kind: "none" },
  sessions: [],
  currentSessionID: null,
  messages: [],
};

export function App() {
  const [snapshot, setSnapshot] = useState<Snapshot>(emptySnapshot);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [remoteUrl, setRemoteUrl] = useState("http://127.0.0.1:8787");
  const [remoteToken, setRemoteToken] = useState("");
  const [prompt, setPrompt] = useState("");
  const currentSession = useMemo(
    () => snapshot.sessions.find((session) => session.id === snapshot.currentSessionID) ?? null,
    [snapshot.currentSessionID, snapshot.sessions],
  );

  useEffect(() => {
    void window.openwork.getSnapshot().then(setSnapshot);
    void window.openwork.getLogs().then(setLogs);
    const offState = window.openwork.onState(setSnapshot);
    const offLog = window.openwork.onLog((entry) => setLogs((current) => [...current, entry].slice(-500)));
    return () => {
      offState();
      offLog();
    };
  }, []);

  async function onConnectRemote(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await window.openwork.connectRemote(remoteUrl, remoteToken);
  }

  async function onSubmitPrompt(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!snapshot.currentSessionID || !prompt.trim()) return;
    const value = prompt;
    setPrompt("");
    await window.openwork.sendPrompt(snapshot.currentSessionID, value);
  }

  return (
    <div className="shell">
      <section className="sidebar card">
        <div className="section-title">OpenWork Labs</div>
        {snapshot.connection.kind === "none" ? (
          <>
            <button className="primary" onClick={() => void window.openwork.createWorkspace()}>
              Open local workspace
            </button>
            <form className="stack" onSubmit={onConnectRemote}>
              <input value={remoteUrl} onChange={(event) => setRemoteUrl(event.target.value)} placeholder="Remote URL" />
              <input value={remoteToken} onChange={(event) => setRemoteToken(event.target.value)} placeholder="Bearer token (optional)" />
              <button type="submit">Connect to opencode</button>
            </form>
          </>
        ) : (
          <>
            <div className="connection">
              <div>{snapshot.connection.kind === "local" ? "Embedded opencode" : "Remote opencode"}</div>
              <code>{snapshot.connection.kind === "local" ? snapshot.connection.workspacePath : snapshot.connection.url}</code>
            </div>
            <button className="primary" onClick={() => void window.openwork.createSession()}>
              New chat
            </button>
            <div className="section-title">Sessions</div>
            <div className="session-list">
              {snapshot.sessions.map((session) => (
                <button
                  key={session.id}
                  className={session.id === snapshot.currentSessionID ? "session active" : "session"}
                  onClick={() => void window.openwork.selectSession(session.id)}
                >
                  <span>{session.title}</span>
                  <small>{session.active ? "running" : new Date(session.updatedAt).toLocaleTimeString()}</small>
                </button>
              ))}
            </div>
          </>
        )}
      </section>

      <section className="thread card">
        <div className="thread-header">
          <div>
            <div className="section-title">Thread</div>
            <div className="muted">{currentSession ? currentSession.title : "No active chat"}</div>
          </div>
          {currentSession?.active ? (
            <button onClick={() => void window.openwork.abortSession(currentSession.id)}>Abort</button>
          ) : null}
        </div>
        <div className="messages">
          {snapshot.messages.length === 0 ? <div className="empty">Create a chat and send a prompt.</div> : null}
          {snapshot.messages.map((message) => (
            <article key={message.id} className={`message ${message.role}`}>
              <header>{message.role}</header>
              <pre>{message.text || (currentSession?.active && message.role === "assistant" ? "Streaming..." : "")}</pre>
            </article>
          ))}
        </div>
        <form className="composer" onSubmit={onSubmitPrompt}>
          <textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder={snapshot.currentSessionID ? "Send a prompt" : "Create a chat first"}
            disabled={!snapshot.currentSessionID}
          />
          <button className="primary" type="submit" disabled={!snapshot.currentSessionID || !prompt.trim()}>
            Send
          </button>
        </form>
      </section>

      <section className="logs card">
        <div className="section-title">Debug log</div>
        <div className="log-list">
          {logs.map((entry) => (
            <div key={entry.id} className={`log ${entry.level}`}>
              <span>[{entry.scope}]</span>
              <code>{entry.message}</code>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

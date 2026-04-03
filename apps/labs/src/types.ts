export type Role = "user" | "assistant" | "error";

export type Message = {
  id: string;
  role: Role;
  text: string;
  createdAt: string;
};

export type SessionSummary = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  active: boolean;
};

export type ConnectionState =
  | { kind: "none" }
  | { kind: "local"; workspacePath: string; url: string }
  | { kind: "remote"; url: string; token: string };

export type Snapshot = {
  connection: ConnectionState;
  sessions: SessionSummary[];
  currentSessionID: string | null;
  messages: Message[];
};

export type LogEntry = {
  id: string;
  scope: "renderer" | "main" | "host";
  level: "info" | "error";
  message: string;
  at: string;
};

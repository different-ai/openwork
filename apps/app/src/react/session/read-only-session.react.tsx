/** @jsxImportSource react */
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import type { OpenworkServerClient, OpenworkSessionMessage } from "../../app/lib/openwork-server";

type ReadOnlySessionProps = {
  client: OpenworkServerClient;
  workspaceId: string;
  sessionId: string;
};

function partText(part: Record<string, unknown>) {
  if (typeof part.text === "string" && part.text.trim()) return part.text.trim();
  if (typeof part.reasoning === "string" && part.reasoning.trim()) return part.reasoning.trim();
  try {
    return JSON.stringify(part, null, 2);
  } catch {
    return "[unsupported part]";
  }
}

function roleLabel(role: string) {
  if (role === "user") return "You";
  if (role === "assistant") return "OpenWork";
  return role;
}

function MessageCard(props: { message: OpenworkSessionMessage }) {
  const role = props.message.info.role;
  const bubbleClass =
    role === "user"
      ? "border-blue-6/35 bg-blue-3/25 text-gray-12"
      : "border-dls-border bg-dls-surface text-gray-12";

  return (
    <article className={`mx-auto flex w-full max-w-[760px] ${role === "user" ? "justify-end" : "justify-start"}`}>
      <div className={`w-full rounded-[24px] border px-5 py-4 shadow-[var(--dls-card-shadow)] ${bubbleClass}`}>
        <div className="mb-2 text-[11px] uppercase tracking-[0.18em] text-dls-secondary">
          {roleLabel(role)}
        </div>
        <div className="space-y-3">
          {props.message.parts.map((part) => (
            <div key={part.id} className="text-sm leading-7 whitespace-pre-wrap break-words">
              {partText(part as Record<string, unknown>)}
            </div>
          ))}
        </div>
      </div>
    </article>
  );
}

export function ReadOnlySessionView(props: ReadOnlySessionProps) {
  const key = useMemo(
    () => ["react-session-snapshot", props.workspaceId, props.sessionId],
    [props.workspaceId, props.sessionId],
  );

  const query = useQuery({
    queryKey: key,
    queryFn: async () =>
      (await props.client.getSessionSnapshot(props.workspaceId, props.sessionId, { limit: 140 })).item,
    staleTime: 1_500,
  });

  if (query.isLoading) {
    return (
      <div className="px-6 py-16">
        <div className="mx-auto max-w-sm rounded-3xl border border-dls-border bg-dls-hover/60 px-8 py-10 text-center">
          <div className="text-sm text-dls-secondary">Loading React session view...</div>
        </div>
      </div>
    );
  }

  if (query.isError || !query.data) {
    return (
      <div className="px-6 py-16">
        <div className="mx-auto max-w-xl rounded-3xl border border-red-6/40 bg-red-3/20 px-6 py-5 text-sm text-red-11">
          {query.error instanceof Error ? query.error.message : "Failed to load React session view."}
        </div>
      </div>
    );
  }

  if (query.data.messages.length === 0) {
    return (
      <div className="px-6 py-16">
        <div className="mx-auto max-w-sm rounded-3xl border border-dls-border bg-dls-hover/60 px-8 py-10 text-center">
          <div className="text-sm text-dls-secondary">No transcript yet.</div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4 pb-4">
      {query.data.messages.map((message) => (
        <MessageCard key={message.info.id} message={message} />
      ))}
    </div>
  );
}

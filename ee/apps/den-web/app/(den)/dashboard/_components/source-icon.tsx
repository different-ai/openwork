import { CalendarDays, Mail, MessagesSquare, Plug } from "lucide-react";
import type { MemberAgentSource } from "@openwork/types/den/workbot-proactive";

/** A source with nothing connected behind it yet: what it is, not a blank square. */
export function SourceIcon({ kind }: { kind: MemberAgentSource["kind"] }) {
  const Icon = kind === "calendar" ? CalendarDays : kind === "email" ? Mail : kind === "chat" ? MessagesSquare : Plug;
  return (
    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-gray-100 bg-gray-50 text-gray-500" aria-hidden>
      <Icon size={14} strokeWidth={1.5} />
    </span>
  );
}

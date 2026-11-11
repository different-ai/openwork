import { MessagesSquare } from "lucide-react";
import { DenTable } from "../../../../_components/ui/table";
import { getMySessionsRoute } from "../../../../_lib/den-org";
import { defineFeatureIntro } from "../types";
import { OPENWORK_DOCS_URL } from "./docs";

/** Facts My Sessions reports from the list it already loads (`GET /v1/sessions`). Missing means "not loaded yet". */
export type SessionsFacts = {
  sessions?: number;
};

function MySessionsExample() {
  return <DenTable columns={[
    { key: "session", header: "Session", render: (row) => row.title },
    { key: "computer", header: "Computer", render: (row) => row.computer },
    { key: "state", header: "State", render: (row) => row.state },
  ]} rows={[
    { id: "waiting", title: "Update the release notes", computer: "Work laptop", state: "Needs you" },
    { id: "running", title: "Summarize this week's tickets", computer: "Mac mini", state: "Working" },
    { id: "idle", title: "Draft the launch email", computer: "Work laptop", state: "Idle" },
  ]} getRowKey={(row) => row.id} density="compact" />;
}

/*
 * The page lists what each computer already lets this account's other devices
 * reach. The copy never says the page gives access: that choice is made on
 * the computer, within what the organization allows.
 */
export const sessionsIntros = [defineFeatureIntro<SessionsFacts>({
  key: "my-sessions", version: 1, match: { path: getMySessionsRoute() }, icon: MessagesSquare,
  title: "My Sessions", summary: "Follow the sessions on your computers, and answer them, from any browser.",
  body: "Tasks you start on another computer show up here with what they are doing. Open one to read it, send a follow-up, stop it, or answer a question or permission it waits on. Sessions started on a computer appear once that computer allows all sessions, in Settings › Devices on that computer.",
  docsUrl: OPENWORK_DOCS_URL,
  example: { Component: MySessionsExample, alt: "Example of your sessions: one on your work laptop needs you, one on your Mac mini is working, and one is idle." },
  ctas: [{ when: () => true, label: "Open OpenWork Desktop", href: "openwork://open" }],
  setupState: (ctx) => {
    if (ctx.facts.sessions === undefined) return "done";
    return ctx.facts.sessions > 0 ? "done" : "none";
  },
})];

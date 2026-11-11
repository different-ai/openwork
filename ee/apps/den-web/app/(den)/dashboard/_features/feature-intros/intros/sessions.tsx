import { MessageSquare, MessagesSquare } from "lucide-react";
import { getMySessionsRoute } from "../../../../_lib/den-org";
import { StatusDot } from "../../computers/computer-parts";
import { LANE, ListRow, RowLane, RowLaneLabel, RowList, RowListHeader } from "../../computers/computer-rows";
import { sessionStateDot } from "../../sessions/sessions-model";
import { defineFeatureIntro } from "../types";
import { OPENWORK_DOCS_URL } from "./docs";

/** Facts My Sessions reports from the list it already loads (`GET /v1/sessions`). Missing means "not loaded yet". */
export type SessionsFacts = {
  sessions?: number;
};

const EXAMPLE_SESSIONS = [
  { id: "waiting", title: "Update the release notes", where: "Work laptop", state: "waiting" },
  { id: "running", title: "Summarize this week's tickets", where: "Mac mini", state: "running" },
  { id: "idle", title: "Draft the launch email", where: "Work laptop", state: "idle" },
] as const;

/** The page's own rows with sample data: a title over where it runs, then its state as a dot and a word. */
function MySessionsExample() {
  return <RowList label="Example of your sessions" header={<RowListHeader lead="Session"><RowLaneLabel lane={LANE.state}>State</RowLaneLabel></RowListHeader>}>
    {EXAMPLE_SESSIONS.map((session) => {
      const state = sessionStateDot(session.state);
      return <ListRow key={session.id} icon={MessageSquare} name={session.title} secondLine={session.where}
        lanes={<RowLane lane={LANE.state} className="items-center gap-2">{state ? <><StatusDot tone={state.tone} /><span className="truncate">{state.label}</span></> : null}</RowLane>} />;
    })}
  </RowList>;
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

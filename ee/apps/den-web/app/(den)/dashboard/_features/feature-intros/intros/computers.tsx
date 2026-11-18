import { Cloud, Laptop, MonitorSmartphone, Server } from "lucide-react";
import { LANE, ListRow, OwnerLane, RemoteAccessBelow, RemoteAccessLane, RowLaneLabel, RowList, RowListHeader, StatusLane } from "../../computers/computer-rows";
import { REMOTE_ACCESS_LABEL } from "../../computers/remote-access";
import { defineFeatureIntro } from "../types";

/* The examples are the pages' own rows with sample data: a tile, a name over what it is, then the lanes. */

/** The owner lane, kept on at the example's width: who owns each computer is the point of the team list. */
const EXAMPLE_OWNER_LANE = "flex w-[72px]";

function ComputersExample() {
  return <RowList label="Example of a team's computers" header={<RowListHeader lead="Computer">
    <RowLaneLabel lane={EXAMPLE_OWNER_LANE}>Owner</RowLaneLabel>
    <RowLaneLabel lane={LANE.status}>Status</RowLaneLabel>
  </RowListHeader>}>
    <ListRow icon={Laptop} name="Design laptop" secondLine="Mac" lanes={<>
      <OwnerLane lane={EXAMPLE_OWNER_LANE} device={{ owner: { name: "Alex", email: null }, shared: false }} />
      <StatusLane label="Online" tone="success" />
    </>} />
    <ListRow icon={Cloud} name="Research computer" secondLine="Workbot's computer" lanes={<>
      <OwnerLane lane={EXAMPLE_OWNER_LANE} device={{ owner: { name: "Sam", email: null }, shared: false }} />
      <StatusLane label="Paused" tone="neutral" />
    </>} />
  </RowList>;
}

function MyComputersExample() {
  // As on the page: what other devices can do on a desktop is a lane where there is room, and a line under the row where there is not.
  const workLaptop = { effective: "created", chosen: true, reason: null } as const;
  return <RowList label="Example of your computers" header={<RowListHeader lead="Computer">
    <RowLaneLabel lane={LANE.status}>Status</RowLaneLabel>
    <RowLaneLabel lane={LANE.remoteAccess}>{REMOTE_ACCESS_LABEL}</RowLaneLabel>
  </RowListHeader>}>
    <ListRow icon={Laptop} name="Work laptop" secondLine="Mac" below={<RemoteAccessBelow access={workLaptop} />}
      lanes={<><StatusLane label="Online" tone="success" /><RemoteAccessLane access={workLaptop} /></>} />
    <ListRow icon={Server} name="Research computer" secondLine="Shared with your organization"
      lanes={<><StatusLane label="Not checked yet" tone="neutral" /><RemoteAccessLane access={null} /></>} />
  </RowList>;
}

export const computersIntros = [defineFeatureIntro({
  key: "computers", version: 1, match: { path: "/dashboard/computers" }, icon: Laptop,
  title: "Computers", summary: "Know which computers your team has connected to OpenWork.",
  body: "See your team’s registered desktops, virtual computers and OpenWork instances, with owners and the latest reported inventory. Computers appear when a member signs in to Desktop, adds an existing virtual computer in Desktop Settings → Devices, or uses Workbot’s cloud computer. Registration does not provision a machine or grant remote access.",
  docsUrl: "https://docs.openworklabs.com",
  example: { Component: ComputersExample, alt: "Example team inventory: Alex’s design laptop is online and Sam’s research computer is paused." },
  ctas: [
    { when: (ctx) => !ctx.can("canViewComputers"), label: "Open OpenWork Desktop", href: "openwork://open", locked: { reason: "Ask an organization owner or admin for the View team computers permission." } },
    { when: () => true, label: "Open OpenWork Desktop", href: "openwork://open" },
  ],
  setupState: (ctx) => typeof ctx.facts.computers === "number" && ctx.facts.computers > 0 ? "done" : "none",
}), defineFeatureIntro({
  // Every member's own view; the team-wide list above needs the View team computers permission.
  key: "my-computers", version: 1, match: { path: "/dashboard/my-computers" }, icon: MonitorSmartphone,
  title: "My Computers", summary: "See the computers you have connected to OpenWork, and the ones shared with your organization.",
  body: "Your desktops, Workbot’s cloud computers and virtual computers you added appear here with whether each can be reached, what your other devices can do on it, when it was last heard from and its OpenWork version. A computer appears when you sign in to OpenWork Desktop on it, add an existing virtual computer in Desktop Settings → Devices, or use Workbot’s cloud computer. Being listed does not start a computer or grant access to it.",
  docsUrl: "https://docs.openworklabs.com",
  example: { Component: MyComputersExample, alt: "Example of your computers: your work laptop is online and other devices can start tasks on it, and a research computer shared with your organization has not been checked yet." },
  ctas: [{ when: () => true, label: "Open OpenWork Desktop", href: "openwork://open" }],
  setupState: (ctx) => typeof ctx.facts.computers === "number" && ctx.facts.computers > 0 ? "done" : "none",
})];

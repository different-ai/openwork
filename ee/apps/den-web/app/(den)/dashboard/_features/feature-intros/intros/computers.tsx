import { Laptop, MonitorSmartphone } from "lucide-react";
import { DenTable } from "../../../../_components/ui/table";
import { defineFeatureIntro } from "../types";

function ComputersExample() {
  return <DenTable columns={[
    { key: "computer", header: "Computer", render: (row) => row.name },
    { key: "owner", header: "Owner", render: (row) => row.owner },
    { key: "status", header: "Availability", render: (row) => row.status },
  ]} rows={[
    { id: "desktop", name: "Design laptop", owner: "Alex", status: "Online" },
    { id: "virtual", name: "Research computer", owner: "Sam", status: "Paused" },
  ]} getRowKey={(row) => row.id} density="compact" />;
}

function MyComputersExample() {
  return <DenTable columns={[
    { key: "computer", header: "Computer", render: (row) => row.name },
    { key: "belongs", header: "Belongs to", render: (row) => row.belongs },
    { key: "status", header: "Availability", render: (row) => row.status },
  ]} rows={[
    { id: "desktop", name: "Work laptop", belongs: "You", status: "Online" },
    { id: "shared", name: "Research computer", belongs: "Shared with your organization", status: "Not checked yet" },
  ]} getRowKey={(row) => row.id} density="compact" />;
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
  body: "Your desktops, Workbot’s cloud computers and virtual computers you added appear here with whether each can be reached, when it was last heard from and its OpenWork version. A computer appears when you sign in to OpenWork Desktop on it, add an existing virtual computer in Desktop Settings → Devices, or use Workbot’s cloud computer. Being listed does not start a computer or grant access to it.",
  docsUrl: "https://docs.openworklabs.com",
  example: { Component: MyComputersExample, alt: "Example of your computers: your work laptop is online, and a research computer shared with your organization has not been checked yet." },
  ctas: [{ when: () => true, label: "Open OpenWork Desktop", href: "openwork://open" }],
  setupState: (ctx) => typeof ctx.facts.computers === "number" && ctx.facts.computers > 0 ? "done" : "none",
})];

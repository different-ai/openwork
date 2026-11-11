import { Laptop } from "lucide-react";
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
})];

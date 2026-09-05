"use client";

import { Laptop, Users, LogIn, LockKeyhole, SlidersHorizontal } from "lucide-react";

export type WorkspaceIntent = "personal" | "team" | "join";
export type DesktopSetup = "flexible" | "restricted";

export function WorkspaceIntentChoices({ intent, onChange, disabled }: {
  intent: WorkspaceIntent | null;
  onChange: (intent: WorkspaceIntent) => void;
  disabled: boolean;
}) {
  return <fieldset disabled={disabled} className="grid gap-3">
    <legend className="mb-3 text-sm font-medium text-gray-700">How will you use OpenWork?</legend>
    {([
      { id: "personal", icon: Laptop, title: "On my own", copy: "A place for your tools and work. Invite others later if you need to." },
      { id: "team", icon: Users, title: "Create a team", copy: "Share tools and connections, then choose what members can change in the desktop app." },
      { id: "join", icon: LogIn, title: "Join a team", copy: "Use an invitation from your team. Their tools and permissions come with you." },
    ] satisfies Array<{ id: WorkspaceIntent; icon: typeof Laptop; title: string; copy: string }>).map((option) => <label key={option.id} className={`flex cursor-pointer items-start gap-3 rounded-xl border p-4 transition-colors ${intent === option.id ? "border-gray-900 bg-gray-50" : "border-gray-200 bg-white hover:bg-gray-50"}`}>
      <input type="radio" name="workspace-intent" value={option.id} checked={intent === option.id} onChange={() => onChange(option.id)} className="mt-1 accent-gray-900" />
      <span><span className="flex items-center gap-2 text-sm font-medium text-gray-950"><option.icon className="h-4 w-4" />{option.title}</span><span className="mt-1 block text-sm leading-5 text-gray-500">{option.copy}</span></span>
    </label>)}
  </fieldset>;
}

export function DesktopSetupChoices({ mode, onChange, disabled }: {
  mode: DesktopSetup | null;
  onChange: (mode: DesktopSetup) => void;
  disabled: boolean;
}) {
  return <fieldset disabled={disabled} className="grid gap-3" aria-describedby="desktop-setup-help">
    <legend className="mb-3 text-sm font-medium text-gray-700">How should your team’s desktop app work?</legend>
    {([
      { id: "flexible", icon: SlidersHorizontal, title: "Flexible", copy: "Start with the existing app defaults: members can add workspaces, providers and local tools, and change settings." },
      { id: "restricted", icon: LockKeyhole, title: "Set up Restricted", copy: "Review a policy that blocks extra workspaces, custom providers, settings changes, local and built-in extensions, OpenCode models and Alpha updates." },
    ] satisfies Array<{ id: DesktopSetup; icon: typeof Laptop; title: string; copy: string }>).map((option) => <label key={option.id} className={`flex cursor-pointer items-start gap-3 rounded-xl border p-4 ${mode === option.id ? "border-gray-900 bg-gray-50" : "border-gray-200 bg-white"}`}>
      <input type="radio" name="desktop-setup" value={option.id} checked={mode === option.id} onChange={() => onChange(option.id)} className="mt-1 accent-gray-900" />
      <span><span className="flex items-center gap-2 text-sm font-medium text-gray-950"><option.icon className="h-4 w-4" />{option.title}</span><span className="mt-1 block text-sm leading-5 text-gray-500">{option.copy}</span></span>
    </label>)}
    <p id="desktop-setup-help" className="text-xs leading-5 text-gray-500">Restricted requires Enterprise and takes effect only after you save the policy. Members can still chat and use available organization tools. Cloud roles and existing files are unchanged.</p>
  </fieldset>;
}

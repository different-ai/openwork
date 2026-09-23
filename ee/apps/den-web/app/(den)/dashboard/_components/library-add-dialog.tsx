"use client";

import { Dialog } from "@base-ui/react/dialog";
import { Boxes, FileText, Plug, X, type LucideIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { DenButton } from "../../_components/ui/button";
import { ConnectorLogo } from "./item-logo";

export type LibraryAddChoice = "connector" | "skill" | "plugin";

const CHOICES: { value: LibraryAddChoice; title: string; description: string; icon: LucideIcon }[] = [
  { value: "connector", title: "Connector", description: "Let your AI work in Slack, Notion, Linear and more.", icon: Plug },
  { value: "skill", title: "Skill", description: "Teach the AI how you do a task, in plain words.", icon: FileText },
  { value: "plugin", title: "Plugin", description: "A set of skills, commands and connectors, added in one go.", icon: Boxes },
];

const CONNECTOR_LOGOS = ["Slack", "Notion", "Microsoft 365", "Linear"];

/** Brand tiles that say "connectors" without a word of explanation. */
export function ConnectorLogoStrip({ size = "xs" }: { size?: "xs" | "md" }) {
  return (
    <span className={`flex items-center ${size === "md" ? "gap-2" : "gap-1.5"}`} aria-hidden>
      {CONNECTOR_LOGOS.map((name) => <ConnectorLogo key={name} name={name} size={size} />)}
    </span>
  );
}

export function LibraryAddDialog({ open, onOpenChange, hrefFor }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  hrefFor: (choice: LibraryAddChoice) => string;
}) {
  const router = useRouter();
  const [choice, setChoice] = useState<LibraryAddChoice>("connector");

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-gray-950/20" />
        <Dialog.Popup
          data-testid="library-add-dialog"
          className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-[560px] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-2xl border border-gray-100 bg-white outline-none"
        >
          <div className="flex items-start justify-between gap-4 px-6 pb-3 pt-6">
            <div>
              <Dialog.Title className="text-[18px] font-semibold leading-6 text-gray-900">Add to your Library</Dialog.Title>
              <Dialog.Description className="mt-1 text-[13px] leading-[18px] text-gray-500">
                Connect the tools your AI works in, or teach it how you work.
              </Dialog.Description>
            </div>
            <Dialog.Close aria-label="Close" className="flex h-8 w-8 items-center justify-center rounded-full bg-gray-100 text-gray-600 transition-colors hover:bg-gray-200 hover:text-gray-900">
              <X className="h-4 w-4" aria-hidden />
            </Dialog.Close>
          </div>
          <div role="radiogroup" aria-label="What to add" className="flex flex-col gap-1 px-3 pb-3">
            {CHOICES.map((entry) => {
              const selected = entry.value === choice;
              const Icon = entry.icon;
              return (
                <button
                  key={entry.value}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  data-testid={`library-add-${entry.value}`}
                  onClick={() => setChoice(entry.value)}
                  onDoubleClick={() => router.push(hrefFor(entry.value))}
                  className={`flex w-full items-start gap-3.5 rounded-xl px-3 py-3 text-left transition-colors ${selected ? "bg-gray-50" : "hover:bg-gray-50"}`}
                >
                  <span aria-hidden className={`mt-2 flex h-4 w-4 shrink-0 items-center justify-center rounded-full ${selected ? "bg-gray-900" : "border-[1.5px] border-gray-300"}`}>
                    {selected ? (
                      <svg width="10" height="10" viewBox="0 0 12 12"><path d="M2.5 6.2l2.2 2.2L9.5 3.6" fill="none" stroke="#FFFFFF" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
                    ) : null}
                  </span>
                  <span aria-hidden className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-gray-100 bg-white text-gray-500">
                    <Icon className="h-4 w-4" strokeWidth={1.8} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[14px] font-medium leading-5 text-gray-900">{entry.title}</span>
                    <span className="block text-[13px] leading-[18px] text-gray-500">{entry.description}</span>
                    {entry.value === "connector" ? <span className="mt-2 block"><ConnectorLogoStrip /></span> : null}
                  </span>
                </button>
              );
            })}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-gray-100 px-4 py-3">
            <p className="pl-1 text-[12px] leading-4 text-gray-500">New things start just for you. Share them whenever you like.</p>
            <div className="flex items-center gap-2">
              <Dialog.Close className="inline-flex h-9 items-center rounded-lg border border-gray-200 bg-white px-4 text-[13px] font-medium text-gray-700 transition-colors hover:bg-gray-50">
                Cancel
              </Dialog.Close>
              <DenButton size="sm" className="h-9 px-4 text-[13px]" onClick={() => router.push(hrefFor(choice))}>Continue</DenButton>
            </div>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

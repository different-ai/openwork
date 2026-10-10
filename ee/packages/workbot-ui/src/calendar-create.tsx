"use client";

import {
  automationNameFrom,
  DEFAULT_SLOT_REPEAT,
  slotLabel,
  slotScheduleOptions,
  timeZoneLabel,
  formatTime,
  type CalendarSlot,
  type SlotRepeat,
} from "@openwork/calendar";
import { Popover } from "@base-ui/react/popover";
import { useMemo, useRef, useState } from "react";
import type { AutomationModel } from "@openwork/types/automations";
import { CLOUD_DEFAULT_MODEL, useAutomationModels, useCreateAutomation } from "./calendar-data";
import { ModelPicker } from "./model-picker";

/**
 * "New automation" from an empty slot or the toolbar (Paper: "4c · Calendar — add an automation from an empty
 * slot"). The person says what to do and picks how it repeats from the slot; it runs in the cloud.
 */

export type CreateAnchor = { slot: CalendarSlot; x: number; y: number };

export function CreateAutomationCard({ anchor, assistantName, canSchedule, onClose, onCreated }: {
  anchor: CreateAnchor;
  assistantName: string;
  canSchedule: boolean;
  onClose: () => void;
  onCreated: (automationId: string) => void;
}) {
  const [instructions, setInstructions] = useState("");
  const [repeat, setRepeat] = useState<SlotRepeat>(DEFAULT_SLOT_REPEAT);
  const create = useCreateAutomation();
  // The cloud default first, as Workbot's own scheduling uses; any model this member may use can replace it.
  const { models, isLoading: modelsLoading } = useAutomationModels({ includeCloudDefault: true });
  const [model, setModel] = useState<AutomationModel>(CLOUD_DEFAULT_MODEL);
  const field = useRef<HTMLTextAreaElement | null>(null);
  const options = slotScheduleOptions(anchor.slot);
  const chosen = options.find((option) => option.id === repeat) ?? options[0];
  // The clicked slot is a virtual anchor; Base UI tracks viewport changes and shifts the actual card, not
  // a guessed height. Shift on both axes lets a short screen use its full height instead of half of it.
  // The card stays touching its anchor, so a slot point left outside a rotated or resized window is pulled back inside the 12px inset.
  const positionAnchor = useMemo(() => ({
    getBoundingClientRect: () => new DOMRect(
      Math.max(12, Math.min(anchor.x, window.innerWidth - 12)),
      Math.max(12, Math.min(anchor.y, window.innerHeight - 12)),
      0,
      0,
    ),
  }), [anchor.x, anchor.y]);
  const ready = canSchedule && instructions.trim().length > 0 && !create.isPending;
  const submit = () => {
    if (!ready || !chosen) return;
    create.mutate({ name: automationNameFrom(instructions), instructions: instructions.trim(), schedule: chosen.schedule, model }, {
      onSuccess: (detail) => onCreated(detail.automation.id),
    });
  };
  return (
    <Popover.Root open modal onOpenChange={(open) => { if (!open) onClose(); }}>
      <Popover.Portal>
        <Popover.Backdrop className="fixed inset-0 z-40" />
        <Popover.Positioner anchor={positionAnchor} positionMethod="fixed" side="bottom" align="start" collisionPadding={12} collisionAvoidance={{ side: "shift", align: "shift" }} className="z-50">
          <Popover.Popup initialFocus={field} data-calendar-create className="workbot flex max-h-[min(calc(100dvh-24px),var(--available-height,calc(100dvh-24px)))] w-[min(22rem,calc(100vw-24px))] flex-col rounded-xl bg-[var(--wb-surface)] text-[var(--wb-text)] shadow-[var(--wb-panel-shadow)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]">
            <form className="flex min-h-0 flex-col" onSubmit={(event) => { event.preventDefault(); submit(); }}>
              <div className="flex shrink-0 flex-col gap-0.5 px-4 pb-3 pt-4">
                <span className="text-[12px] leading-4 text-[var(--wb-muted)]">{slotLabel(anchor.slot)}</span>
                <Popover.Title render={<h2 />} className="text-[15px] font-semibold leading-5 tracking-[-0.01em] text-[var(--wb-text)]">New automation</Popover.Title>
              </div>
              <div className="flex min-h-0 flex-col gap-3.5 overflow-y-auto px-4 pb-1" data-calendar-form-body>
                <label className="flex flex-col gap-1.5">
                  <span className="text-[12px] font-medium leading-4 text-[var(--wb-text)]">What should {assistantName} do?</span>
                  <textarea
                    ref={field}
                    value={instructions}
                    onChange={(event) => setInstructions(event.currentTarget.value)}
                    onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); submit(); } }}
                    rows={3}
                    maxLength={100_000}
                    placeholder="Pull this week's press kit comments from Notion and draft a reply list"
                    className="min-h-[72px] resize-none rounded-lg bg-[var(--wb-surface)] px-2.5 py-2 text-[13px] leading-[19px] text-[var(--wb-text)] shadow-[inset_0_0_0_1px_var(--wb-ring)] placeholder:text-[var(--wb-muted)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]"
                  />
                </label>
                <div className="flex flex-col gap-1.5">
                  <span id="calendar-create-repeats" className="text-[12px] font-medium leading-4 text-[var(--wb-text)]">Repeats</span>
                  <div className="flex gap-1.5" role="radiogroup" aria-labelledby="calendar-create-repeats">
                    {options.map((option) => (
                      <button
                        key={option.id}
                        type="button"
                        role="radio"
                        aria-checked={repeat === option.id}
                        onClick={() => setRepeat(option.id)}
                        className={`flex h-7 flex-1 basis-0 items-center justify-center whitespace-nowrap rounded-[7px] px-1 text-[12px] font-medium focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)] ${repeat === option.id ? "bg-[var(--wb-ink)] text-[var(--wb-on-ink)]" : "text-[var(--wb-text)] shadow-[inset_0_0_0_1px_var(--wb-ring)] hover:bg-[var(--wb-chip)]"}`}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                  <span className="text-[12px] leading-4 text-[var(--wb-muted)]">
                    {canSchedule
                      ? `At ${formatTime(anchor.slot.at, anchor.slot.timeZone)} ${timeZoneLabel(anchor.slot.timeZone, anchor.slot.at)}. Runs on ${assistantName}'s cloud computer.`
                      : "Your organization's cloud doesn't run automations yet. An admin can turn it on."}
                  </span>
                </div>
                <div className="flex flex-col gap-1.5">
                  <span className="text-[12px] font-medium leading-4 text-[var(--wb-text)]">Model</span>
                  <ModelPicker value={model} options={models} loading={modelsLoading} onChange={setModel} />
                </div>
                {create.isError ? <p role="alert" className="text-[12px] leading-4 text-[var(--wb-danger)]">{create.error.message}</p> : null}
              </div>
              <div className="flex shrink-0 gap-2 p-4" data-calendar-form-actions>
                <Popover.Close className="h-8.5 flex-1 rounded-lg text-[13px] font-medium text-[var(--wb-text)] shadow-[0_0_0_1px_var(--wb-ring)] hover:bg-[var(--wb-chip)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]">Cancel</Popover.Close>
                <button type="submit" disabled={!ready} className="h-8.5 flex-[1.4] rounded-lg bg-[var(--wb-ink)] text-[13px] font-medium text-[var(--wb-on-ink)] hover:opacity-90 disabled:opacity-50">
                  {create.isPending ? "Creating…" : "Create automation"}
                </button>
              </div>
            </form>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

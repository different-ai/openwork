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
import { useEffect, useRef, useState } from "react";
import { useCreateAutomation } from "./calendar-data";

/**
 * "New automation" from an empty slot or the toolbar (Paper: "4c · Calendar — add an automation from an empty
 * slot"). The person says what to do and picks how it repeats from the slot; it runs in the cloud.
 */

const CARD_WIDTH = 352;
const CARD_HEIGHT = 360;

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
  const field = useRef<HTMLTextAreaElement | null>(null);
  const options = slotScheduleOptions(anchor.slot);
  const chosen = options.find((option) => option.id === repeat) ?? options[0];
  useEffect(() => { field.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const left = Math.max(12, Math.min(anchor.x, window.innerWidth - CARD_WIDTH - 12));
  const top = Math.max(12, Math.min(anchor.y, window.innerHeight - CARD_HEIGHT - 12));
  const ready = canSchedule && instructions.trim().length > 0 && !create.isPending;
  const submit = () => {
    if (!ready || !chosen) return;
    create.mutate({ name: automationNameFrom(instructions), instructions: instructions.trim(), schedule: chosen.schedule }, {
      onSuccess: (detail) => onCreated(detail.automation.id),
    });
  };
  return (
    <>
      <div className="fixed inset-0 z-40" aria-hidden onClick={onClose} />
      <form
        role="dialog"
        aria-label="New automation"
        data-calendar-create
        className="fixed z-50 flex flex-col gap-3.5 rounded-xl bg-white p-4 shadow-[var(--wb-panel-shadow)]"
        style={{ left, top, width: CARD_WIDTH }}
        onSubmit={(event) => { event.preventDefault(); submit(); }}
      >
        <div className="flex flex-col gap-0.5">
          <span className="text-[12px] leading-4 text-[#687076]">{slotLabel(anchor.slot)}</span>
          <h2 className="text-[15px] font-semibold leading-5 tracking-[-0.01em] text-black">New automation</h2>
        </div>
        <label className="flex flex-col gap-1.5">
          <span className="text-[12px] font-medium leading-4 text-[#11181C]">What should {assistantName} do?</span>
          <textarea
            ref={field}
            value={instructions}
            onChange={(event) => setInstructions(event.currentTarget.value)}
            onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); submit(); } }}
            rows={3}
            maxLength={100_000}
            placeholder="Pull this week's press kit comments from Notion and draft a reply list"
            className="min-h-[72px] resize-none rounded-lg bg-white px-2.5 py-2 text-[13px] leading-[19px] text-[#11181C] shadow-[inset_0_0_0_1px_#0116271F] placeholder:text-[#9BA1A6] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]"
          />
        </label>
        <div className="flex flex-col gap-1.5">
          <span id="calendar-create-repeats" className="text-[12px] font-medium leading-4 text-[#11181C]">Repeats</span>
          <div className="flex gap-1.5" role="radiogroup" aria-labelledby="calendar-create-repeats">
            {options.map((option) => (
              <button
                key={option.id}
                type="button"
                role="radio"
                aria-checked={repeat === option.id}
                onClick={() => setRepeat(option.id)}
                className={`flex h-7 flex-1 basis-0 items-center justify-center whitespace-nowrap rounded-[7px] px-1 text-[12px] font-medium focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)] ${repeat === option.id ? "bg-[#011627] text-[#E6EDF3]" : "text-[#11181C] shadow-[inset_0_0_0_1px_#0116271F] hover:bg-[#F4F6F7]"}`}
              >
                {option.label}
              </button>
            ))}
          </div>
          <span className="text-[12px] leading-4 text-[#687076]">
            {canSchedule
              ? `At ${formatTime(anchor.slot.at, anchor.slot.timeZone)} ${timeZoneLabel(anchor.slot.timeZone, anchor.slot.at)}. Runs on ${assistantName}'s cloud computer.`
              : "Your organization's cloud doesn't run automations yet. An admin can turn it on."}
          </span>
        </div>
        {create.isError ? <p role="alert" className="text-[12px] leading-4 text-[var(--wb-danger)]">{create.error.message}</p> : null}
        <div className="flex gap-2 pt-0.5">
          <button type="button" onClick={onClose} className="h-8.5 flex-1 rounded-lg text-[13px] font-medium text-black shadow-[0_0_0_1px_#0116271F] hover:bg-[#F4F6F7]">Cancel</button>
          <button type="submit" disabled={!ready} className="h-8.5 flex-[1.4] rounded-lg bg-[#011627] text-[13px] font-medium text-[#E6EDF3] hover:opacity-90 disabled:opacity-50">
            {create.isPending ? "Creating…" : "Create automation"}
          </button>
        </div>
      </form>
    </>
  );
}

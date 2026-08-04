import type { ReactNode } from "react";

export type DenActionRowProps = {
  /** Plain-language explanation of when this action is the right one. */
  description: ReactNode;
  /** The control itself, usually a DenButton. */
  action: ReactNode;
  className?: string;
};

/**
 * DenActionRow
 *
 * Pairs a control with a sentence describing when to use it.
 *
 * Use this instead of a bare row of buttons wherever the consequence of
 * pressing one is not obvious from its label — billing, destructive
 * operations, anything that reaches a third party. The description carries the
 * meaning, so it is the wider column; the action sits in a fixed slot so
 * buttons line up across rows regardless of how long the text is.
 */
export function DenActionRow({ description, action, className = "" }: DenActionRowProps) {
  return (
    <div className={`flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:gap-4 ${className}`}>
      <p className="flex-1 text-[13px] leading-5 text-gray-600">{description}</p>
      <div className="flex shrink-0 sm:w-[200px] sm:justify-end">{action}</div>
    </div>
  );
}

export type DenActionListProps = {
  children: ReactNode;
  className?: string;
};

/** Stacks DenActionRows with the dividers that separate one choice from the next. */
export function DenActionList({ children, className = "" }: DenActionListProps) {
  return (
    <div
      className={`flex flex-col border-t border-gray-200 [&>*+*]:border-t [&>*+*]:border-gray-100 ${className}`}
    >
      {children}
    </div>
  );
}

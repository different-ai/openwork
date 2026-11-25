import type { ReactNode } from "react";

export type DenActionRowProps = {
  description: ReactNode;
  action: ReactNode;
  className?: string;
};

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

export function DenActionList({ children, className = "" }: DenActionListProps) {
  return (
    <div
      className={`flex flex-col border-t border-gray-200 [&>*+*]:border-t [&>*+*]:border-gray-100 ${className}`}
    >
      {children}
    </div>
  );
}

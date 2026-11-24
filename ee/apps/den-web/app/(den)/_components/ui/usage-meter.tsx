import type { ReactNode } from "react";

export type DenUsageMeterProps = {
  label: string;
  used: number;
  total: number;
  readout?: string;
  caption?: ReactNode;
  className?: string;
};

export function DenUsageMeter({ label, used, total, readout, caption, className = "" }: DenUsageMeterProps) {
  const safeTotal = Math.max(0, total);
  const safeUsed = Math.max(0, used);
  const overflow = Math.max(0, safeUsed - safeTotal);

  return (
    <div className={`flex flex-col gap-2.5 ${className}`}>
      <div className="flex items-baseline gap-2">
        <span className="flex-1 text-[13px] font-medium text-gray-700">{label}</span>
        <span className="font-mono text-[13px] font-medium text-gray-950">
          {readout ?? `${safeUsed}/${safeTotal}`}
        </span>
      </div>
      <div className="flex h-1.5 gap-1" role="presentation">
        {overflow > 0 ? (
          <>
            <span className="rounded-full bg-gray-900" style={{ flexGrow: safeTotal }} />
            <span className="rounded-full bg-gray-400" style={{ flexGrow: overflow }} />
          </>
        ) : (
          Array.from({ length: safeTotal }, (_, index) => (
            <span
              key={index}
              className={`flex-1 rounded-full ${index < safeUsed ? "bg-gray-900" : "bg-gray-200"}`}
            />
          ))
        )}
      </div>
      {caption ? <p className="text-[12px] leading-4 text-gray-500">{caption}</p> : null}
    </div>
  );
}

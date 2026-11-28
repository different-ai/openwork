import type { ReactNode, Ref } from "react";

export function ComposerFrame({ children, panelRef, topAccessory }: {
  children: ReactNode;
  panelRef?: Ref<HTMLDivElement>;
  topAccessory?: ReactNode;
}) {
  return (
    <div ref={panelRef} className="@container/composer relative overflow-visible rounded-[18px] border border-dls-border bg-dls-surface transition-all">
      {topAccessory ? <div className="relative z-10">{topAccessory}</div> : null}
      {children}
    </div>
  );
}

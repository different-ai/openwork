import type { ReactNode } from "react";
import { DenShell } from "./_components/den-shell";
import { DenFlowProvider } from "./_providers/den-flow-provider";

export default function DenLayout({ children }: { children: ReactNode }) {
  return (
    <DenFlowProvider>
      <DenShell>{children}</DenShell>
    </DenFlowProvider>
  );
}

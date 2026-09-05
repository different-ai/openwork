import { useParams, useNavigate, useSearchParams, Navigate } from "react-router";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AppArtifact } from "./app-artifact";
import { useAppsClient } from "./use-apps";

/** Retain old app links, with Dashboard as the only library. */
export function AppsPage({ onNewApp }: { onNewApp: (prompt: string) => Promise<void> }) {
  const { appId } = useParams();
  const { scope } = useAppsClient();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  if (!appId) return <Navigate to="/dashboard" replace />;
  return <div className="mx-auto flex h-full w-full max-w-5xl flex-col gap-4 p-6">
    <div><Button variant="ghost" onClick={() => navigate("/dashboard")}><ArrowLeft className="size-4" />Dashboard</Button></div>
    <div className="min-h-0 flex-1 overflow-hidden rounded-xl border">
      <AppArtifact key={JSON.stringify([scope, appId, params.get("revisionId"), params.get("receiptId")])}
        appId={appId} revisionId={params.get("revisionId") ?? undefined} receiptId={params.get("receiptId") ?? undefined} onAsk={onNewApp} />
    </div>
  </div>;
}

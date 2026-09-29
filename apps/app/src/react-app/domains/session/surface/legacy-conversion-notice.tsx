/** @jsxImportSource react */
import { useEffect, useRef, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { createClientV2, type LegacyConversionReport } from "@/app/lib/opencode-v2-adapter";
import { unwrap } from "@/app/lib/opencode";

export function LegacyConversionNotice(props: {
  baseUrl: string; directory: string; token?: string; sessionId: string;
  onConverted: (sessionID: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<LegacyConversionReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function convert() {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(null);
    try {
      const client = createClientV2(props.baseUrl, props.directory, { token: props.token });
      const preview = report ?? unwrap(await client.prepareLegacyConversion(props.sessionId));
      setReport(preview);
      // A separate labeled action acknowledges known omissions before native import.
      if (!report && preview.warnings.length) return;
      const result = unwrap(await client.continueLegacyConversion(props.sessionId, preview.warnings.length > 0));
      if (mounted.current) props.onConverted(result.sessionID);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Conversion failed. Retry to continue this chat.");
    } finally { pending.current = false; setBusy(false); }
  }
  return <Alert className="mx-3 mb-2 w-auto" data-testid="legacy-conversion-notice">
    <AlertTitle>Convert this v1 chat before sending</AlertTitle>
    <AlertDescription className="gap-2">
      <p>You can read this history now. Convert it to OpenCode v2 to continue. Your original v1 chat stays unchanged and your draft will carry over.</p>
      <p>V2 permissions will use their defaults. V1 revert state will reset.</p>
      <p>Related parent and child chats are copied to preserve their conversation links.</p>
      {report?.warnings.length ? <div data-testid="legacy-conversion-omissions">
        <p className="font-medium">Some history will be omitted:</p>
        <ul className="list-disc ps-4">{[...new Set(report.warnings)].map(message => <li key={message}>{message}</li>)}</ul>
      </div> : null}
      {report && report.sessions > 1 ? <p>This also converts {report.sessions - 1} related chats to preserve their conversation links.</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      <Button size="sm" variant="outline" disabled={busy} onClick={() => void convert()}>
        {busy ? "Converting…" : report?.warnings.length ? "Continue with omissions" : "Convert to v2"}
      </Button>
    </AlertDescription>
  </Alert>;
}

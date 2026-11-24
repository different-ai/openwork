import { useState } from "react";
import { createDenClient, readDenSettings } from "@/app/lib/den";
import { autoAccessRefreshEvent } from "@/app/lib/inference-access";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function FreeEmailVerification({ email }: { email: string }) {
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [verified, setVerified] = useState(false);

  async function submit(send: boolean) {
    if (busy) return;
    setBusy(true);
    setMessage("");
    const settings = readDenSettings();
    const client = createDenClient({ ...settings, token: settings.authToken });
    try {
      if (send) {
        await client.sendAccountVerificationCode(email);
        setSent(true);
        setCode("");
        setMessage(`Code sent to ${email}.`);
      } else {
        await client.verifyAccountEmail(email, code.trim());
        setVerified(true);
        window.dispatchEvent(new Event(autoAccessRefreshEvent));
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Verification failed. Try again.");
    } finally {
      setBusy(false);
    }
  }

  if (verified) return <span role="status">Email verified. You can retry your request.</span>;
  return <div className="flex flex-wrap items-center gap-2">
    {sent && <Input aria-label="Six-digit email code" autoComplete="one-time-code" inputMode="numeric"
      maxLength={6} value={code} onChange={event => setCode(event.target.value)} className="w-28" />}
    {sent && <Button type="button" size="xs" disabled={busy || !/^\d{6}$/.test(code)} onClick={() => void submit(false)}>Verify code</Button>}
    <Button type="button" size="xs" variant="outline" disabled={busy} onClick={() => void submit(true)}>
      {sent ? "Resend code" : "Email me a code"}
    </Button>
    <span role="status" className="text-xs">{message}</span>
  </div>;
}

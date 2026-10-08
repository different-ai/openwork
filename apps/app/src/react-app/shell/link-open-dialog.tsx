import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { toast } from "@/components/ui/sonner";
import { t } from "@/i18n";
import { useLocal } from "../kernel/local-provider";
import type { LinkOpenDestination } from "../kernel/local-preferences-storage";

type LinkRequest = { id: string; url: string };

export function LinkOpenDialog() {
  const { prefs, setPrefs } = useLocal();
  const [request, setRequest] = useState<LinkRequest | null>(null);
  const [dontAskAgain, setDontAskAgain] = useState(true);
  const requestRef = useRef<LinkRequest | null>(null);
  const responding = useRef(false);

  useEffect(() => {
    const browser = window.__OPENWORK_ELECTRON__?.browser;
    const unsubscribe = browser?.onLinkOpenRequest?.((next) => {
      requestRef.current = next;
      setRequest(next);
      if (next) setDontAskAgain(true);
    });
    return () => {
      unsubscribe?.();
      if (requestRef.current) void browser?.chooseLinkDestination?.(requestRef.current.id, null);
    };
  }, []);

  const choose = async (destination: LinkOpenDestination | null) => {
    const current = requestRef.current;
    if (!current || responding.current) return;
    responding.current = true;
    try {
      const accepted = await window.__OPENWORK_ELECTRON__?.browser?.chooseLinkDestination?.(current.id, destination);
      if (accepted && destination) {
        setPrefs((previous) => ({
          ...previous,
          linkOpenDestination: destination,
          askBeforeOpeningLinks: !dontAskAgain,
        }));
      }
    } catch {
      toast.error(t("links.open_failed"));
    } finally {
      if (requestRef.current?.id === current.id) requestRef.current = null;
      setRequest((pending) => pending?.id === current.id ? null : pending);
      responding.current = false;
    }
  };

  return (
    <Dialog open={request !== null} onOpenChange={(open) => { if (!open) void choose(null); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("links.choose_destination")}</DialogTitle>
        </DialogHeader>
        <p className="truncate text-muted-foreground" title={request?.url}>{request?.url}</p>
        <Field orientation="horizontal">
          <Checkbox id="link-dont-ask-again" checked={dontAskAgain} onCheckedChange={setDontAskAgain} />
          <FieldLabel htmlFor="link-dont-ask-again">{t("links.dont_ask_again")}</FieldLabel>
        </Field>
        <DialogFooter>
          <Button variant={prefs.linkOpenDestination === "external" ? "default" : "outline"} onClick={() => void choose("external")}>
            {t("links.open_external")}
          </Button>
          <Button variant={prefs.linkOpenDestination === "openwork" ? "default" : "outline"} onClick={() => void choose("openwork")}>
            {t("links.open_openwork")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

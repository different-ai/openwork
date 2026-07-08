/** @jsxImportSource react */
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { t } from "@/i18n";
import { TextInput } from "../../../design-system/text-input";
import {
  displayCustomControlPlaneUrl,
  formatControlPlaneHost,
  isValidControlPlaneUrl,
} from "./control-plane-url";

type OrganizationServerAffordanceProps = {
  busy: boolean;
  error: string | null;
  onSave: (url: string) => Promise<boolean>;
  url: string;
};

export function OrganizationServerAffordance(props: OrganizationServerAffordanceProps) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const customUrl = displayCustomControlPlaneUrl(props.url);
  const connectedHost = customUrl ? formatControlPlaneHost(customUrl) : "";

  useEffect(() => {
    if (open) setDraft(customUrl);
  }, [customUrl, open]);

  const submit = async () => {
    const ok = await props.onSave(draft);
    if (ok) setOpen(false);
  };

  return (
    <div className="flex justify-center">
      {customUrl ? (
        <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 rounded-lg border border-border bg-muted/40 px-3 py-2 text-center text-sm text-muted-foreground">
          <span>{t("welcome.organization_server_connected", { host: connectedHost })}</span>
          <Button
            type="button"
            variant="link"
            className="h-auto p-0 text-sm"
            onClick={() => setOpen(true)}
          >
            {t("welcome.organization_server_change")}
          </Button>
        </div>
      ) : (
        <Button
          type="button"
          variant="link"
          className="h-auto p-0 text-sm text-muted-foreground"
          onClick={() => setOpen(true)}
        >
          {t("welcome.organization_server_link")}
        </Button>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("welcome.organization_server_dialog_title")}</DialogTitle>
            <DialogDescription>{t("welcome.organization_server_dialog_desc")}</DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            <TextInput
              label={t("welcome.organization_server_url_label")}
              value={draft}
              onChange={(event) => setDraft(event.currentTarget.value)}
              placeholder={t("welcome.organization_server_url_placeholder")}
              disabled={props.busy}
            />
            {props.error ? (
              <p className="text-xs text-destructive">{props.error}</p>
            ) : null}
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
              disabled={props.busy}
            >
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              onClick={() => void submit()}
              disabled={props.busy || !isValidControlPlaneUrl(draft)}
            >
              {t("common.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

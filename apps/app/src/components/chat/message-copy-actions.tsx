import { useCallback, useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MessageAction } from "@/components/ui/message";
import type { MenuAction } from "@/components/ui/action-menu-model";
import { copyMessage, type MessageCopyRequest } from "./message-clipboard";

export function messageCopyActions(request: MessageCopyRequest, onPortableCopy?: () => void): MenuAction[] {
  if (!request.markdown) return [];
  return [{
    type: "item", id: "copy", label: "Copy", icon: <Copy className="size-4" />,
    onSelect: async () => { if (await copyMessage(request) === "rich") onPortableCopy?.(); },
  }];
}

export function MessageCopyButton({ request, onPortableCopy }: { request: MessageCopyRequest; onPortableCopy?: () => void }) {
  const [copied, setCopied] = useState(false);
  const onCopy = useCallback(async () => {
    if (!request.markdown) return;
    try {
      const format = await copyMessage(request);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
      if (format === "rich") onPortableCopy?.();
    } catch {
      // Preserve the existing quiet handling if even the Markdown fallback fails.
    }
  }, [request, onPortableCopy]);
  if (!request.markdown) return null;
  return (
    <MessageAction tooltip={copied ? "Copied!" : "Copy"}>
      <Button variant="ghost" size="icon" aria-label="Copy message" onClick={() => void onCopy()}>
        {copied ? <Check /> : <Copy />}
      </Button>
    </MessageAction>
  );
}

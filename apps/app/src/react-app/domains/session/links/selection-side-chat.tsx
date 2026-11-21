/** @jsxImportSource react */
import { Columns2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent } from "@/components/ui/popover";
import { t } from "@/i18n";
import { replySelection } from "./selection-quote";

export function SelectionSideChat({ scope, onStart }: {
  scope: HTMLElement | null;
  onStart: (text: string) => void;
}) {
  const [picked, setPicked] = useState<{ text: string; range: Range } | null>(null);

  useEffect(() => {
    if (!scope) return;
    let timer = 0;
    const settle = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setPicked(replySelection(document.getSelection(), scope)), 0);
    };
    const clear = () => {
      if (document.getSelection()?.isCollapsed !== false) setPicked(null);
    };
    scope.addEventListener("pointerup", settle);
    scope.addEventListener("keyup", settle);
    document.addEventListener("selectionchange", clear);
    return () => {
      window.clearTimeout(timer);
      scope.removeEventListener("pointerup", settle);
      scope.removeEventListener("keyup", settle);
      document.removeEventListener("selectionchange", clear);
      setPicked(null);
    };
  }, [scope]);

  const anchor = useMemo(() => {
    if (!picked || !scope) return null;
    let last = picked.range.getBoundingClientRect();
    return {
      contextElement: scope,
      getBoundingClientRect: () => {
        const rect = picked.range.getBoundingClientRect();
        if (rect.width > 0 || rect.height > 0) last = rect;
        return last;
      },
    };
  }, [picked, scope]);

  if (!picked || !anchor) return null;
  return (
    <Popover open onOpenChange={(open) => { if (!open) setPicked(null); }}>
      <PopoverContent
        anchor={anchor}
        side="top"
        align="center"
        sideOffset={6}
        initialFocus={false}
        finalFocus={false}
        data-selection-side-chat=""
        onMouseDown={(event) => event.preventDefault()}
        className="w-auto gap-0 rounded-lg p-1 data-open:animate-none data-closed:animate-none"
      >
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 px-2 text-[13px]"
          onClick={() => {
            onStart(picked.text);
            document.getSelection()?.removeAllRanges();
            setPicked(null);
          }}
        >
          <Columns2 className="size-4" />
          {t("session_tree.start_side_chat")}
        </Button>
      </PopoverContent>
    </Popover>
  );
}

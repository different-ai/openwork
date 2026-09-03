/** @jsxImportSource react */
import { Info } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

/**
 * Ajuda contextual da gestão de Obras (domínio Engenharia).
 * Textos definidos na FASE 04.2-B; componentes nativos (Popover/Button).
 */

export function ObraHelpButton() {
  return (
    <Popover>
      <PopoverTrigger
        render={<Button type="button" variant="ghost" size="icon" />}
        aria-label="Ajuda: Obras"
      >
        <Info className="size-4" aria-hidden="true" />
      </PopoverTrigger>
      <PopoverContent className="w-80" align="start">
        <div className="flex flex-col gap-3">
          <div className="text-sm font-semibold">Obras</div>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Obras são os projetos de trabalho registrados neste domínio.
          </p>
          <div className="text-sm font-semibold">Nova obra</div>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Crie a identificação básica da obra. Informações técnicas
            detalhadas podem ser preenchidas posteriormente.
          </p>
        </div>
      </PopoverContent>
    </Popover>
  );
}

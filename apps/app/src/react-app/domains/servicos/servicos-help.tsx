/** @jsxImportSource react */
import { Info } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

/** Seções de ajuda da capacidade de Serviços (genérica). */
export const SERVICOS_HELP_SECTIONS = [
  {
    question: "O que é?",
    answer:
      "Serviços são os trabalhos (nível 3) da EAP com duração, datas e caminho crítico derivados do planejamento.",
  },
  {
    question: "Para que serve?",
    answer:
      "Permite acompanhar cada serviço da obra, sua duração, período de execução e se é crítico para o cronograma.",
  },
  {
    question: "Como funciona?",
    answer:
      "Os dados são derivados automaticamente da EAP e do planejamento da obra. Não há entrada manual nesta visão.",
  },
  {
    question: "O que devo fazer?",
    answer:
      "Nesta fase, apenas visualize. Orçamento, medição e indicadores completos serão adicionados em fase futura.",
  },
] as const;

export function ServicosHelp() {
  return (
    <Popover>
      <PopoverTrigger
        render={<Button type="button" variant="ghost" size="icon" />}
        aria-label="Ajuda: Serviços"
      >
        <Info className="size-4" aria-hidden="true" />
      </PopoverTrigger>
      <PopoverContent className="w-80" align="start">
        <div className="flex flex-col gap-3">
          <div className="text-sm font-semibold">Serviços</div>
          {SERVICOS_HELP_SECTIONS.map((section) => (
            <div key={section.question} className="flex flex-col gap-0.5">
              <div className="text-xs font-semibold">{section.question}</div>
              <p className="text-xs leading-relaxed text-muted-foreground">
                {section.answer}
              </p>
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

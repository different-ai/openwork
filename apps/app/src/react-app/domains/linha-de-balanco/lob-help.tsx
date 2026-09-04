/** @jsxImportSource react */
import { Info } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

/** Seções de ajuda da capacidade de Linha de Balanço (genérica). */
export const LOB_HELP_SECTIONS = [
  {
    question: "O que é?",
    answer:
      "A Linha de Balanço (LOB) é uma visão tempo × serviço que mostra, em semanas, quando cada serviço da obra está em execução.",
  },
  {
    question: "Para que serve?",
    answer:
      "Permite visualizar o ritmo e a continuidade dos serviços ao longo do tempo, identificando serviços críticos e sobreposições.",
  },
  {
    question: "Como funciona?",
    answer:
      "Cada linha representa um serviço com duração; as células ativas indicam as semanas em que o serviço está em execução. Serviços críticos são destacados.",
  },
  {
    question: "O que devo fazer?",
    answer:
      "Os dados são derivados automaticamente do planejamento da obra. Não há entrada manual nesta visão.",
  },
] as const;

export function LobHelp() {
  return (
    <Popover>
      <PopoverTrigger
        render={<Button type="button" variant="ghost" size="icon" />}
        aria-label="Ajuda: Linha de Balanço"
      >
        <Info className="size-4" aria-hidden="true" />
      </PopoverTrigger>
      <PopoverContent className="w-80" align="start">
        <div className="flex flex-col gap-3">
          <div className="text-sm font-semibold">Linha de Balanço</div>
          {LOB_HELP_SECTIONS.map((section) => (
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

/** @jsxImportSource react */
import { Info } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

/**
 * Ajuda contextual da capacidade de Planejamento (V1).
 * O conteúdo é fornecido como DADOS (PlanningHelpSection[]) — o componente é
 * genérico e não conhece domínios. Em fases futuras, cada módulo poderá
 * fornecer o próprio conteúdo sem o Core conhecer o domínio.
 */

export type PlanningHelpSection = {
  question: string;
  answer: string;
};

export const PLANNING_HELP_SECTIONS: PlanningHelpSection[] = [
  {
    question: "O que é?",
    answer: "Uma visão integrada do planejamento.",
  },
  {
    question: "Para que serve?",
    answer:
      "Para acompanhar estrutura, andamento, período e pontos de atenção.",
  },
  {
    question: "Como funciona?",
    answer:
      "A árvore mostra a estrutura; a timeline mostra o período; o resumo mostra indicadores; os alertas destacam situações que merecem atenção.",
  },
  {
    question: "O que devo fazer?",
    answer: "Selecionar um item para consultar seus detalhes.",
  },
];

export function PlanningHelp({
  sections = PLANNING_HELP_SECTIONS,
}: {
  sections?: PlanningHelpSection[];
}) {
  return (
    <Popover>
      <PopoverTrigger
        render={<Button type="button" variant="ghost" size="icon" />}
        aria-label="Ajuda: Planejamento"
      >
        <Info className="size-4" aria-hidden="true" />
      </PopoverTrigger>
      <PopoverContent className="w-80" align="start">
        <div className="flex flex-col gap-3">
          <div className="text-sm font-semibold">Planejamento</div>
          {sections.map((section) => (
            <div key={section.question} className="flex flex-col gap-0.5">
              <div className="text-xs font-medium text-foreground">
                {section.question}
              </div>
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

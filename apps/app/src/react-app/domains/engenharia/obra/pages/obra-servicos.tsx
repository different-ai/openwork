/** @jsxImportSource react */
import { useMemo } from "react";

import { ServicosTable } from "@/react-app/domains/servicos/servicos-table";
import { getEapNodesForObra } from "../obra-eap-repository";
import { getEscopo } from "../obra-escopo-repository";
import { dataInicioEfetiva } from "../obra-planejamento-data";
import { obraEapParaServicos } from "../obra-servicos-adapter";
import type { Obra } from "../obra-types";

/**
 * Página Serviços da casca (FASE 20.x / FASE 21).
 * Adapter: deriva os serviços dos nós reais da EAP + planejamento e delega a
 * renderização à capacidade genérica `ServicosTable`. Preparada para a FASE 22.
 */
export function ObraServicos({ obra }: { obra: Obra }) {
  const data = useMemo(() => {
    const nodes = getEapNodesForObra(obra.id);
    return obraEapParaServicos(nodes, obra.nome, getEscopo(obra.id), dataInicioEfetiva(obra.dataInicio));
  }, [obra]);

  return <ServicosTable data={data} />;
}

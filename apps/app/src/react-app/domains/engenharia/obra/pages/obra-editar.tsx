/** @jsxImportSource react */
import { useState } from "react";
import { useNavigate } from "react-router";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useObraRepository } from "../obra-repository";
import { obraRoute, obrasListRoute } from "../obra-routes";
import type { Obra, ObraStatus } from "../obra-types";

const STATUS_OPTIONS: { value: ObraStatus; label: string }[] = [
  { value: "PROPOSTA", label: "Proposta" },
  { value: "PLANEJAMENTO", label: "Planejamento" },
  { value: "EM_EXECUCAO", label: "Em execução" },
  { value: "CONCLUIDA", label: "Concluída" },
];

/**
 * Edição de identificação da obra (FASE 22).
 * Edita nome, status, dataInicio, dataFim, localização e responsável.
 * `dataInicio` é metadado do cadastro (fonte única do cadastro) — NÃO é
 * sobrescrito pelo Planejamento.
 */
export function ObraEditarPage({ obraId }: { obraId: string }) {
  const navigate = useNavigate();
  const obra = useObraRepository((state) =>
    state.obras.find((candidate) => candidate.id === obraId),
  );
  const updateObra = useObraRepository((state) => state.updateObra);

  const [nome, setNome] = useState(obra?.nome ?? "");
  const [status, setStatus] = useState<ObraStatus>(obra?.status ?? "PROPOSTA");
  const [dataInicio, setDataInicio] = useState(obra?.dataInicio ?? "");
  const [dataFim, setDataFim] = useState(obra?.dataFim ?? "");
  const [localizacao, setLocalizacao] = useState(obra?.localizacao ?? "");
  const [responsavel, setResponsavel] = useState(obra?.responsavel ?? "");
  const [error, setError] = useState<string | null>(null);

  if (!obra) {
    return (
      <div className="flex min-h-[60vh] w-full flex-col items-center justify-center gap-2 p-8 text-center">
        <p className="text-lg font-semibold">Obra não encontrada</p>
        <p className="text-sm text-muted-foreground">{obraId}</p>
      </div>
    );
  }

  const trimmed = nome.trim();

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!trimmed) {
      setError("Informe o nome da obra.");
      return;
    }
    setError(null);
    updateObra(obra.id, {
      nome: trimmed,
      status,
      dataInicio: dataInicio || null,
      dataFim: dataFim || null,
      localizacao: localizacao.trim() || null,
      responsavel: responsavel.trim() || null,
    });
    navigate(obraRoute(obra.id));
  };

  return (
    <div className="flex h-full w-full flex-col overflow-auto p-4">
      <div className="max-w-lg">
        <Card>
          <CardHeader>
            <CardTitle>Editar obra</CardTitle>
            <CardDescription>
              Identificação e metadados da obra. Informações técnicas continuam
              nos módulos específicos.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form className="flex flex-col gap-4" onSubmit={handleSubmit} data-obra-editar>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="obra-nome">Nome</Label>
                <Input
                  id="obra-nome"
                  value={nome}
                  onChange={(event) => {
                    setNome(event.target.value);
                    if (error) setError(null);
                  }}
                  maxLength={120}
                />
                {error ? <p className="text-xs text-destructive">{error}</p> : null}
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="obra-status">Status</Label>
                <select
                  id="obra-status"
                  value={status}
                  onChange={(e) => setStatus(e.target.value as ObraStatus)}
                  className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
                >
                  {STATUS_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="obra-data-inicio">Data de início</Label>
                  <Input
                    id="obra-data-inicio"
                    type="date"
                    value={dataInicio}
                    onChange={(e) => setDataInicio(e.target.value)}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="obra-data-fim">Data de fim</Label>
                  <Input
                    id="obra-data-fim"
                    type="date"
                    value={dataFim}
                    onChange={(e) => setDataFim(e.target.value)}
                  />
                </div>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="obra-localizacao">Localização</Label>
                <Input
                  id="obra-localizacao"
                  value={localizacao}
                  onChange={(e) => setLocalizacao(e.target.value)}
                  placeholder="Ex.: São Paulo, SP"
                  maxLength={120}
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="obra-responsavel">Responsável</Label>
                <Input
                  id="obra-responsavel"
                  value={responsavel}
                  onChange={(e) => setResponsavel(e.target.value)}
                  placeholder="Ex.: Eng. Responsável"
                  maxLength={120}
                />
              </div>

              <div className="flex items-center justify-end gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => navigate(obrasListRoute())}
                >
                  Cancelar
                </Button>
                <Button type="submit" disabled={!trimmed}>
                  Salvar
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

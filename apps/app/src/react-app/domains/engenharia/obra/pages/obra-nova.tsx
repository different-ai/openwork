/** @jsxImportSource react */
import { useState } from "react";
import { useNavigate } from "react-router";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useObraRepository } from "../obra-repository";
import { obraNovaRoute, obraRoute, obrasListRoute } from "../obra-routes";

/**
 * Cadastro mínimo de obra (FASE 04.2-B).
 * Apenas identificação (nome). Caracterização/EAP/planejamento ficam para etapas
 * posteriores. Após criar, abre a nova obra (contexto da obra = obraId na URL).
 */
export function ObraNovaPage() {
  const navigate = useNavigate();
  const createObra = useObraRepository((state) => state.createObra);
  const [nome, setNome] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const trimmed = nome.trim();

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!trimmed) {
      setError("Informe o nome da obra.");
      return;
    }
    setError(null);
    setSubmitting(true);
    const obra = createObra({ nome: trimmed });
    // Preferência da fase: após criar, abrir a nova obra.
    navigate(obraRoute(obra.id), { replace: false });
  };

  return (
    <div className="flex h-full w-full flex-col overflow-auto p-4">
      <div className="max-w-lg">
        <Card>
          <CardHeader>
            <CardTitle>Nova obra</CardTitle>
            <CardDescription>
              Identificação básica. Informações técnicas podem ser preenchidas
              posteriormente.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form className="flex flex-col gap-4" onSubmit={handleSubmit} data-obra-nova>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="obra-nome">Nome</Label>
                <Input
                  id="obra-nome"
                  value={nome}
                  onChange={(event) => {
                    setNome(event.target.value);
                    if (error) setError(null);
                  }}
                  placeholder="Ex.: Obra Demonstrativa 03"
                  autoFocus
                  maxLength={120}
                />
                {error ? (
                  <p className="text-xs text-destructive">{error}</p>
                ) : null}
              </div>

              <div className="flex items-center justify-end gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => navigate(obrasListRoute())}
                >
                  Cancelar
                </Button>
                <Button type="submit" disabled={!trimmed || submitting}>
                  {submitting ? "Criando…" : "Criar obra"}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        Rota atual: <span className="font-mono">{obraNovaRoute()}</span>
      </p>
    </div>
  );
}

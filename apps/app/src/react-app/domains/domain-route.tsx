/** @jsxImportSource react */
import { useParams } from "react-router";
import { getDomain } from "./domain-bootstrap";
import { DomainBackButton } from "./domain-back-button";

/**
 * Rota genérica de domínios: /dominios/:domainId/* (Core).
 * O Core delega a renderização ao domínio registrado; não conhece Engenharia nem Obra.
 *
 * Header genérico: enquanto o usuário está DENTRO de um domínio, expõe uma ação
 * clara de "Voltar ao nível anterior" (derivada da rota + árvore de navegação).
 */
export function DomainRoute() {
  const params = useParams();
  const domainId = params.domainId ?? "";
  const rest = params["*"] ?? "";
  const domain = getDomain(domainId);

  if (!domain) {
    return (
      <div className="flex min-h-[60vh] w-full flex-col items-center justify-center gap-2 p-8 text-center">
        <p className="text-lg font-semibold">Domínio não encontrado</p>
        <p className="text-sm text-muted-foreground">{domainId}</p>
      </div>
    );
  }

  return (
    <div className="flex h-full w-full flex-col">
      <header className="shrink-0 px-3 pt-2">
        <DomainBackButton navigation={domain.navigation} />
      </header>
      <div className="min-h-0 flex-1 overflow-hidden">
        {domain.renderRoute(rest)}
      </div>
    </div>
  );
}

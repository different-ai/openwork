/** @jsxImportSource react */
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * Placeholder funcional dos módulos futuros da obra
 * (Frentes de Serviço, Planejamento, Produção, RDO, IA).
 * Cada módulo será vinculado aos elementos da EAP em fases posteriores.
 */
export function ObraModuloPlaceholder({ titulo, descricao }: { titulo: string; descricao: string }) {
  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle>{titulo}</CardTitle>
        <CardDescription>Módulo em construção.</CardDescription>
      </CardHeader>
      <CardContent className="text-sm text-muted-foreground">{descricao}</CardContent>
    </Card>
  );
}

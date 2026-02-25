import type { AikaTemplate } from "../index";

import derechoMigratorio from "./skills/derecho-migratorio.md?raw";
import documentosMigratorios from "./skills/documentos-migratorios.md?raw";
import consultaVisa from "./commands/consulta-visa.md?raw";
import prepararDocumentos from "./commands/preparar-documentos.md?raw";
import checklistTramite from "./commands/checklist-tramite.md?raw";

const template: AikaTemplate = {
  id: "abogado-migratorio",
  name: "Abogado Migratorio",
  description:
    "Orientación sobre visas, checklists de documentos y borradores de cartas para trámites migratorios.",
  icon: "Plane",
  locale: "es",
  category: "industry",
  audience: "Migrantes, abogados migratorios, empresas con empleados internacionales",
  skills: [
    { slug: "derecho-migratorio", content: derechoMigratorio },
    { slug: "documentos-migratorios", content: documentosMigratorios },
  ],
  commands: [
    { slug: "consulta-visa", content: consultaVisa },
    { slug: "preparar-documentos", content: prepararDocumentos },
    { slug: "checklist-tramite", content: checklistTramite },
  ],
  suggestedMcps: [
    {
      name: "Brave Search",
      package: "@anthropic/brave-search-mcp",
      reason: "Consultar requisitos actualizados de visas y trámites migratorios.",
    },
    {
      name: "Filesystem",
      package: "@anthropic/filesystem-mcp",
      reason: "Guardar borradores de documentos y checklists.",
    },
  ],
};

export default template;

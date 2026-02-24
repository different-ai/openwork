import type { AikaTemplate } from "../index";

import reclutamientoSeleccion from "./skills/reclutamiento-seleccion.md?raw";
import politicasInternas from "./skills/politicas-internas.md?raw";
import crearVacante from "./commands/crear-vacante.md?raw";
import evaluarCandidato from "./commands/evaluar-candidato.md?raw";
import generarPolitica from "./commands/generar-politica.md?raw";

const template: AikaTemplate = {
  id: "recursos-humanos",
  name: "Recursos Humanos",
  description:
    "Reclutamiento, evaluaciones de desempeño y políticas internas.",
  icon: "Users",
  locale: "es",
  category: "function",
  audience: "Departamentos de RRHH, reclutadores",
  skills: [
    { slug: "reclutamiento-seleccion", content: reclutamientoSeleccion },
    { slug: "politicas-internas", content: politicasInternas },
  ],
  commands: [
    { slug: "crear-vacante", content: crearVacante },
    { slug: "evaluar-candidato", content: evaluarCandidato },
    { slug: "generar-politica", content: generarPolitica },
  ],
  suggestedMcps: [
    {
      name: "Notion",
      package: "@anthropic/notion-mcp",
      reason: "Gestionar base de datos de candidatos y políticas internas.",
    },
    {
      name: "Google Drive",
      package: "@anthropic/gdrive-mcp",
      reason: "Almacenar CVs, evaluaciones y documentos de onboarding.",
    },
  ],
};

export default template;

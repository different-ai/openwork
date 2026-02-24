import type { AikaTemplate } from "../index";

import disenoCurricular from "./skills/diseno-curricular.md?raw";
import evaluacionEducativa from "./skills/evaluacion-educativa.md?raw";
import crearPlanClase from "./commands/crear-plan-clase.md?raw";
import generarExamen from "./commands/generar-examen.md?raw";
import crearRubrica from "./commands/crear-rubrica.md?raw";

const template: AikaTemplate = {
  id: "educacion",
  name: "Educación",
  description:
    "Planes de clase, evaluaciones y material didáctico para instituciones educativas.",
  icon: "GraduationCap",
  locale: "es",
  category: "industry",
  audience: "Escuelas, universidades, tutores",
  skills: [
    { slug: "diseno-curricular", content: disenoCurricular },
    { slug: "evaluacion-educativa", content: evaluacionEducativa },
  ],
  commands: [
    { slug: "crear-plan-clase", content: crearPlanClase },
    { slug: "generar-examen", content: generarExamen },
    { slug: "crear-rubrica", content: crearRubrica },
  ],
  suggestedMcps: [
    {
      name: "Google Drive",
      package: "@anthropic/gdrive-mcp",
      reason: "Acceder a materiales didácticos y compartir planes de clase.",
    },
    {
      name: "Notion",
      package: "@anthropic/notion-mcp",
      reason: "Organizar banco de reactivos y planeaciones por materia.",
    },
  ],
};

export default template;

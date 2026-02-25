import type { AikaTemplate } from "../index";

import disenoCurricular from "./skills/diseno-curricular.md?raw";
import evaluacionAcademica from "./skills/evaluacion-academica.md?raw";
import crearSyllabus from "./commands/crear-syllabus.md?raw";
import generarExamen from "./commands/generar-examen.md?raw";
import crearRubrica from "./commands/crear-rubrica.md?raw";

const template: AikaTemplate = {
  id: "profesor-universitario",
  name: "Profesor Universitario",
  description:
    "Syllabus, exámenes, rúbricas y retroalimentación académica con taxonomía de Bloom.",
  icon: "GraduationCap",
  locale: "es",
  category: "industry",
  audience: "Profesores universitarios, coordinadores académicos, tutores",
  skills: [
    { slug: "diseno-curricular", content: disenoCurricular },
    { slug: "evaluacion-academica", content: evaluacionAcademica },
  ],
  commands: [
    { slug: "crear-syllabus", content: crearSyllabus },
    { slug: "generar-examen", content: generarExamen },
    { slug: "crear-rubrica", content: crearRubrica },
  ],
  suggestedMcps: [
    {
      name: "Filesystem",
      package: "@anthropic/filesystem-mcp",
      reason: "Guardar syllabus, exámenes y rúbricas en archivos.",
    },
    {
      name: "Brave Search",
      package: "@anthropic/brave-search-mcp",
      reason: "Buscar bibliografía actualizada y recursos académicos.",
    },
  ],
};

export default template;

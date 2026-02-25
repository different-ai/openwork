import type { AikaTemplate } from "../index";

import planificacionProyectos from "./skills/planificacion-proyectos.md?raw";
import reportesAvance from "./skills/reportes-avance.md?raw";
import crearRoadmap from "./commands/crear-roadmap.md?raw";
import reporteAvance from "./commands/reporte-avance.md?raw";
import desglosarTarea from "./commands/desglosar-tarea.md?raw";

const template: AikaTemplate = {
  id: "planificador-proyectos",
  name: "Planificador de Proyectos",
  description:
    "Roadmaps, desglose de tareas, estimaciones y reportes de avance para equipos y freelancers.",
  icon: "GanttChart",
  locale: "es",
  category: "function",
  audience: "Project managers, startups, freelancers, equipos de desarrollo",
  skills: [
    { slug: "planificacion-proyectos", content: planificacionProyectos },
    { slug: "reportes-avance", content: reportesAvance },
  ],
  commands: [
    { slug: "crear-roadmap", content: crearRoadmap },
    { slug: "reporte-avance", content: reporteAvance },
    { slug: "desglosar-tarea", content: desglosarTarea },
  ],
  suggestedMcps: [
    {
      name: "GitHub",
      package: "@anthropic/github-mcp",
      reason: "Crear issues, gestionar PRs y trackear progreso en repositorios.",
    },
    {
      name: "Notion",
      package: "@anthropic/notion-mcp",
      reason: "Gestionar tableros de proyecto y documentación.",
    },
    {
      name: "Google Calendar",
      package: "@anthropic/google-calendar-mcp",
      reason: "Programar hitos y deadlines en el calendario.",
    },
  ],
};

export default template;

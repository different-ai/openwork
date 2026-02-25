import type { AikaTemplate } from "../index";

import contenidoRedes from "./skills/contenido-redes.md?raw";
import calendarioEditorial from "./skills/calendario-editorial.md?raw";
import crearPost from "./commands/crear-post.md?raw";
import generarCalendario from "./commands/generar-calendario.md?raw";
import adaptarContenido from "./commands/adaptar-contenido.md?raw";

const template: AikaTemplate = {
  id: "creador-contenido",
  name: "Creador de Contenido",
  description:
    "Posts para X, LinkedIn e Instagram, calendario editorial y adaptación multiplataforma.",
  icon: "PenLine",
  locale: "es",
  category: "function",
  audience: "Community managers, freelancers, emprendedores, marcas personales",
  skills: [
    { slug: "contenido-redes", content: contenidoRedes },
    { slug: "calendario-editorial", content: calendarioEditorial },
  ],
  commands: [
    { slug: "crear-post", content: crearPost },
    { slug: "generar-calendario", content: generarCalendario },
    { slug: "adaptar-contenido", content: adaptarContenido },
  ],
  suggestedMcps: [
    {
      name: "X (Twitter)",
      package: "@enescinar/twitter-mcp",
      reason: "Publicar tweets y buscar tendencias directamente.",
    },
    {
      name: "Brave Search",
      package: "@anthropic/brave-search-mcp",
      reason: "Investigar tendencias y temas del momento.",
    },
    {
      name: "Notion",
      package: "@anthropic/notion-mcp",
      reason: "Gestionar calendario editorial y banco de ideas.",
    },
  ],
};

export default template;

import type { AikaTemplate } from "../index";

import diagnosticoTickets from "./skills/diagnostico-tickets.md?raw";
import baseConocimiento from "./skills/base-conocimiento.md?raw";
import diagnosticarTicket from "./commands/diagnosticar-ticket.md?raw";
import crearKbArticle from "./commands/crear-kb-article.md?raw";
import escalarCaso from "./commands/escalar-caso.md?raw";

const template: AikaTemplate = {
  id: "soporte-tecnico",
  name: "Soporte Técnico",
  description:
    "Diagnóstico de tickets, base de conocimiento y escalamiento para help desks.",
  icon: "Headphones",
  locale: "es",
  category: "function",
  audience: "Help desks, equipos de soporte SaaS",
  skills: [
    { slug: "diagnostico-tickets", content: diagnosticoTickets },
    { slug: "base-conocimiento", content: baseConocimiento },
  ],
  commands: [
    { slug: "diagnosticar-ticket", content: diagnosticarTicket },
    { slug: "crear-kb-article", content: crearKbArticle },
    { slug: "escalar-caso", content: escalarCaso },
  ],
  suggestedMcps: [
    {
      name: "Slack",
      package: "@anthropic/slack-mcp",
      reason: "Recibir y responder tickets desde canales de Slack.",
    },
    {
      name: "GitHub",
      package: "@anthropic/github-mcp",
      reason: "Crear issues para bugs confirmados y rastrear fixes.",
    },
    {
      name: "Notion",
      package: "@anthropic/notion-mcp",
      reason: "Publicar y mantener artículos de base de conocimiento.",
    },
  ],
};

export default template;

import type { AikaTemplate } from "../index";

import gestionVault from "./skills/gestion-vault.md?raw";
import resumenSemanal from "./skills/resumen-semanal.md?raw";
import buscarNotas from "./commands/buscar-notas.md?raw";
import crearNota from "./commands/crear-nota.md?raw";
import revisionSemanal from "./commands/revision-semanal.md?raw";

const template: AikaTemplate = {
  id: "asistente-obsidian",
  name: "Asistente Obsidian",
  description:
    "Lee tu vault, conecta notas, genera resúmenes semanales y mantiene tu segundo cerebro organizado.",
  icon: "Brain",
  locale: "es",
  category: "function",
  audience: "Usuarios de Obsidian, investigadores, profesionales del conocimiento",
  skills: [
    { slug: "gestion-vault", content: gestionVault },
    { slug: "resumen-semanal", content: resumenSemanal },
  ],
  commands: [
    { slug: "buscar-notas", content: buscarNotas },
    { slug: "crear-nota", content: crearNota },
    { slug: "revision-semanal", content: revisionSemanal },
  ],
  suggestedMcps: [
    {
      name: "Obsidian",
      package: "obsidian-mcp-server",
      reason:
        "Acceso completo al vault: leer, escribir, buscar notas, gestionar tags y frontmatter.",
    },
    {
      name: "Filesystem",
      package: "@anthropic/filesystem-mcp",
      reason: "Acceso directo a archivos del vault si no usas el plugin REST API.",
    },
  ],
};

export default template;

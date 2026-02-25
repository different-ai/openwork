import type { AikaTemplate } from "../index";

import gestionCorreo from "./skills/gestion-correo.md?raw";
import plantillasEmail from "./skills/plantillas-email.md?raw";
import redactarCorreo from "./commands/redactar-correo.md?raw";
import clasificarCorreos from "./commands/clasificar-correos.md?raw";
import seguimientoEmail from "./commands/seguimiento-email.md?raw";

const template: AikaTemplate = {
  id: "gestor-email",
  name: "Gestor de Email",
  description:
    "Redacta, clasifica y da seguimiento a correos profesionales con tono adaptado a LATAM.",
  icon: "Mail",
  locale: "es",
  category: "function",
  audience: "Profesionales, ejecutivos, equipos comerciales",
  skills: [
    { slug: "gestion-correo", content: gestionCorreo },
    { slug: "plantillas-email", content: plantillasEmail },
  ],
  commands: [
    { slug: "redactar-correo", content: redactarCorreo },
    { slug: "clasificar-correos", content: clasificarCorreos },
    { slug: "seguimiento-email", content: seguimientoEmail },
  ],
  suggestedMcps: [
    {
      name: "Gmail",
      package: "@anthropic/google-gmail-mcp",
      reason: "Leer y enviar correos directamente desde Gmail.",
    },
    {
      name: "Google Calendar",
      package: "@anthropic/google-calendar-mcp",
      reason: "Programar reuniones mencionadas en correos.",
    },
  ],
};

export default template;

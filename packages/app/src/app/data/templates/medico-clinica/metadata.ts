import type { AikaTemplate } from "../index";

import documentacionClinica from "./skills/documentacion-clinica.md?raw";
import comunicacionPaciente from "./skills/comunicacion-paciente.md?raw";
import notaClinica from "./commands/nota-clinica.md?raw";
import referimiento from "./commands/referimiento.md?raw";
import indicacionesPaciente from "./commands/indicaciones-paciente.md?raw";

const template: AikaTemplate = {
  id: "medico-clinica",
  name: "Médico / Clínica",
  description:
    "Notas clínicas SOAP, referimientos a especialistas e indicaciones para pacientes en lenguaje claro.",
  icon: "Stethoscope",
  locale: "es",
  category: "industry",
  audience: "Médicos generales, especialistas, clínicas privadas",
  skills: [
    { slug: "documentacion-clinica", content: documentacionClinica },
    { slug: "comunicacion-paciente", content: comunicacionPaciente },
  ],
  commands: [
    { slug: "nota-clinica", content: notaClinica },
    { slug: "referimiento", content: referimiento },
    { slug: "indicaciones-paciente", content: indicacionesPaciente },
  ],
  suggestedMcps: [
    {
      name: "Filesystem",
      package: "@anthropic/filesystem-mcp",
      reason: "Guardar notas clínicas y plantillas de documentos médicos.",
    },
    {
      name: "Google Calendar",
      package: "@anthropic/google-calendar-mcp",
      reason: "Programar citas de seguimiento y recordatorios.",
    },
  ],
};

export default template;

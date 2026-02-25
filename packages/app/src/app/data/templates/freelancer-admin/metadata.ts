import type { AikaTemplate } from "../index";

import administracionFreelance from "./skills/administracion-freelance.md?raw";
import gestionClientes from "./skills/gestion-clientes.md?raw";
import crearCotizacion from "./commands/crear-cotizacion.md?raw";
import contratoServicio from "./commands/contrato-servicio.md?raw";
import reporteFinanciero from "./commands/reporte-financiero.md?raw";

const template: AikaTemplate = {
  id: "freelancer-admin",
  name: "Freelancer Admin",
  description:
    "Cotizaciones, contratos, control financiero y gestión de clientes para independientes.",
  icon: "Briefcase",
  locale: "es",
  category: "function",
  audience: "Freelancers, consultores independientes, profesionales autónomos",
  skills: [
    { slug: "administracion-freelance", content: administracionFreelance },
    { slug: "gestion-clientes", content: gestionClientes },
  ],
  commands: [
    { slug: "crear-cotizacion", content: crearCotizacion },
    { slug: "contrato-servicio", content: contratoServicio },
    { slug: "reporte-financiero", content: reporteFinanciero },
  ],
  suggestedMcps: [
    {
      name: "Gmail",
      package: "@anthropic/google-gmail-mcp",
      reason: "Enviar cotizaciones y dar seguimiento a clientes por email.",
    },
    {
      name: "Google Calendar",
      package: "@anthropic/google-calendar-mcp",
      reason: "Programar entregas, reuniones con clientes y fechas de cobro.",
    },
    {
      name: "Filesystem",
      package: "@anthropic/filesystem-mcp",
      reason: "Guardar cotizaciones, contratos y reportes financieros.",
    },
  ],
};

export default template;

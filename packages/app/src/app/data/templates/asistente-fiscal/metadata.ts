import type { AikaTemplate } from "../index";

import normativaFiscalLatam from "./skills/normativa-fiscal-latam.md?raw";
import calculosTributarios from "./skills/calculos-tributarios.md?raw";
import calcularImpuesto from "./commands/calcular-impuesto.md?raw";
import calendarioFiscal from "./commands/calendario-fiscal.md?raw";
import revisarFactura from "./commands/revisar-factura.md?raw";

const template: AikaTemplate = {
  id: "asistente-fiscal",
  name: "Asistente Fiscal LATAM",
  description:
    "Cálculos de impuestos, calendario de obligaciones y revisión de facturas para México, Colombia, Argentina, Chile y Perú.",
  icon: "Receipt",
  locale: "es",
  category: "industry",
  audience: "Contadores independientes, PyMEs, emprendedores",
  skills: [
    { slug: "normativa-fiscal-latam", content: normativaFiscalLatam },
    { slug: "calculos-tributarios", content: calculosTributarios },
  ],
  commands: [
    { slug: "calcular-impuesto", content: calcularImpuesto },
    { slug: "calendario-fiscal", content: calendarioFiscal },
    { slug: "revisar-factura", content: revisarFactura },
  ],
  suggestedMcps: [
    {
      name: "Google Calendar",
      package: "@anthropic/google-calendar-mcp",
      reason: "Programar recordatorios de fechas límite fiscales.",
    },
    {
      name: "Brave Search",
      package: "@anthropic/brave-search-mcp",
      reason: "Consultar actualizaciones de normativa fiscal vigente.",
    },
    {
      name: "Filesystem",
      package: "@anthropic/filesystem-mcp",
      reason: "Guardar cálculos y reportes fiscales en archivos locales.",
    },
  ],
};

export default template;

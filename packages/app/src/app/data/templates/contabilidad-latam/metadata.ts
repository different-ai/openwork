import type { AikaTemplate } from "../index";

import normativaFiscal from "./skills/normativa-fiscal.md?raw";
import conciliacionBancaria from "./skills/conciliacion-bancaria.md?raw";
import generarReporteFiscal from "./commands/generar-reporte-fiscal.md?raw";
import conciliarCuentas from "./commands/conciliar-cuentas.md?raw";
import calcularImpuestos from "./commands/calcular-impuestos.md?raw";

const template: AikaTemplate = {
  id: "contabilidad-latam",
  name: "Contabilidad LATAM",
  description:
    "Reportes fiscales, conciliación de cuentas y cumplimiento tributario para LATAM.",
  icon: "Calculator",
  locale: "es",
  category: "industry",
  audience: "Contadores, PyMEs, firmas contables",
  skills: [
    { slug: "normativa-fiscal", content: normativaFiscal },
    { slug: "conciliacion-bancaria", content: conciliacionBancaria },
  ],
  commands: [
    { slug: "generar-reporte-fiscal", content: generarReporteFiscal },
    { slug: "conciliar-cuentas", content: conciliarCuentas },
    { slug: "calcular-impuestos", content: calcularImpuestos },
  ],
  suggestedMcps: [
    {
      name: "Google Sheets",
      package: "@anthropic/gsheets-mcp",
      reason: "Leer y actualizar hojas de cálculo con datos contables.",
    },
    {
      name: "Notion",
      package: "@anthropic/notion-mcp",
      reason: "Gestionar base de datos de clientes y obligaciones fiscales.",
    },
  ],
};

export default template;

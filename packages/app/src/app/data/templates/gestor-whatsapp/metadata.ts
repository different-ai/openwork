import type { AikaTemplate } from "../index";

import comunicacionWhatsapp from "./skills/comunicacion-whatsapp.md?raw";
import catalogoVentas from "./skills/catalogo-ventas.md?raw";
import respuestaCliente from "./commands/respuesta-cliente.md?raw";
import crearCatalogo from "./commands/crear-catalogo.md?raw";
import mensajeCobranza from "./commands/mensaje-cobranza.md?raw";

const template: AikaTemplate = {
  id: "gestor-whatsapp",
  name: "Gestor de WhatsApp Business",
  description:
    "Respuestas rápidas, catálogos de productos y flujos de venta por WhatsApp.",
  icon: "MessageCircle",
  locale: "es",
  category: "function",
  audience: "PyMEs, tiendas online, negocios locales, vendedores independientes",
  skills: [
    { slug: "comunicacion-whatsapp", content: comunicacionWhatsapp },
    { slug: "catalogo-ventas", content: catalogoVentas },
  ],
  commands: [
    { slug: "respuesta-cliente-wa", content: respuestaCliente },
    { slug: "crear-catalogo-wa", content: crearCatalogo },
    { slug: "mensaje-cobranza", content: mensajeCobranza },
  ],
  suggestedMcps: [
    {
      name: "Filesystem",
      package: "@anthropic/filesystem-mcp",
      reason: "Guardar catálogos y plantillas de mensajes para reutilizar.",
    },
  ],
};

export default template;

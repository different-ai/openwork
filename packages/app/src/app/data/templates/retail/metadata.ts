import type { AikaTemplate } from "../index";

import gestionCatalogo from "./skills/gestion-catalogo.md?raw";
import atencionCliente from "./skills/atencion-cliente.md?raw";
import crearProducto from "./commands/crear-producto.md?raw";
import analizarInventario from "./commands/analizar-inventario.md?raw";
import responderCliente from "./commands/responder-cliente.md?raw";

const template: AikaTemplate = {
  id: "retail",
  name: "Retail / E-commerce",
  description:
    "Gestión de catálogo, inventario y atención al cliente para tiendas en línea.",
  icon: "ShoppingCart",
  locale: "es",
  category: "industry",
  audience: "Tiendas online, marketplaces, comercio minorista",
  skills: [
    { slug: "gestion-catalogo", content: gestionCatalogo },
    { slug: "atencion-cliente", content: atencionCliente },
  ],
  commands: [
    { slug: "crear-producto", content: crearProducto },
    { slug: "analizar-inventario", content: analizarInventario },
    { slug: "responder-cliente", content: responderCliente },
  ],
  suggestedMcps: [
    {
      name: "Notion",
      package: "@anthropic/notion-mcp",
      reason: "Gestionar catálogo de productos y base de datos de clientes.",
    },
    {
      name: "Slack",
      package: "@anthropic/slack-mcp",
      reason: "Recibir alertas de pedidos y consultas de clientes.",
    },
  ],
};

export default template;

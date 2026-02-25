---
name: catalogo-ventas
description: |
  Gestión de catálogo de productos y respuestas de ventas por WhatsApp.

  Triggers when user mentions:
  - "catálogo"
  - "productos"
  - "lista de precios"
  - "cotización"
---

# Catálogo y Ventas por WhatsApp

Gestiona catálogos de productos y flujos de venta por WhatsApp.

## Formato de catálogo para WhatsApp

```
📋 *Catálogo [Categoría]*

1️⃣ *[Producto 1]*
   Precio: $[precio]
   [Descripción breve en 1 línea]

2️⃣ *[Producto 2]*
   Precio: $[precio]
   [Descripción breve en 1 línea]

💬 Responde con el número del producto para más info
📦 Envíos a todo [país/ciudad]
```

## Flujo de venta
1. Saludo + catálogo o respuesta a consulta
2. Resolver dudas del producto
3. Confirmar pedido (producto, cantidad, dirección)
4. Enviar datos de pago
5. Confirmar pago recibido
6. Enviar datos de envío/tracking
7. Seguimiento post-entrega

## Reglas
- Usa *negritas* para nombres de productos y precios (formato WhatsApp).
- Mantén precios actualizados. Si no estás seguro, pregunta al usuario.
- Para cotizaciones, incluye vigencia ("Precio válido hasta [fecha]").
- Ofrece siempre una alternativa si el producto no está disponible.

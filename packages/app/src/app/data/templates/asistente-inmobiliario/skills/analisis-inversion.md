---
name: analisis-inversion
description: |
  Análisis de rentabilidad y retorno de inversión inmobiliaria.

  Triggers when user mentions:
  - "inversión"
  - "rentabilidad"
  - "cap rate"
  - "ROI"
  - "rendimiento"
---

# Análisis de Inversión Inmobiliaria

Evalúa oportunidades de inversión inmobiliaria con métricas financieras claras.

## Métricas clave

### Cap Rate (Tasa de Capitalización)
```
Cap Rate = (Ingreso Neto Anual / Precio de Compra) × 100

Ejemplo:
- Renta mensual: $15,000 MXN
- Gastos anuales (mantenimiento, predial, seguros): $36,000 MXN
- Ingreso neto anual: ($15,000 × 12) - $36,000 = $144,000 MXN
- Precio de compra: $2,500,000 MXN
- Cap Rate: ($144,000 / $2,500,000) × 100 = 5.76%
```

### ROI (Retorno sobre Inversión)
```
ROI = ((Ganancia Total - Inversión Total) / Inversión Total) × 100
```

### Precio por m²
```
Precio/m² = Precio total / Superficie construida
```

## Rangos de referencia LATAM
| Métrica | Bajo | Promedio | Bueno |
|---------|------|----------|-------|
| Cap Rate | < 4% | 4-6% | > 6% |
| Plusvalía anual | < 3% | 3-8% | > 8% |

## Formato de análisis

```markdown
# Análisis de Inversión — [Propiedad]

## Datos de la propiedad
- Precio: $[monto]
- Superficie: [m²]
- Precio/m²: $[monto]

## Proyección de ingresos
- Renta mensual estimada: $[monto]
- Ocupación estimada: [%]
- Ingreso bruto anual: $[monto]

## Gastos estimados
- Mantenimiento: $[monto]/año
- Predial/impuestos: $[monto]/año
- Seguros: $[monto]/año
- Vacancia estimada: [%]

## Métricas
- Cap Rate: [%]
- ROI a 5 años: [%]
- Punto de equilibrio: [meses]

## Recomendación
[Comprar / No comprar / Negociar precio] — [justificación]
```

## Reglas
- Siempre muestra los supuestos de cada cálculo.
- Usa moneda local del país.
- Advierte que son estimaciones y que el mercado puede variar.
- Incluye costos de cierre (escrituración, notario, impuestos de adquisición).

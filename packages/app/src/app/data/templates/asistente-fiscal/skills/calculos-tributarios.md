---
name: calculos-tributarios
description: |
  Cálculos de impuestos, retenciones y obligaciones fiscales.

  Triggers when user mentions:
  - "calcular impuesto"
  - "cuánto pago de"
  - "retención"
  - "base gravable"
  - "deducción"
---

# Cálculos Tributarios

Realiza cálculos fiscales mostrando siempre la fórmula, supuestos y resultado.

## Formato de cálculo

```
## Cálculo de [tipo de impuesto]
**País:** [país] | **Régimen:** [régimen] | **Período:** [mes/año]

### Datos de entrada
- Ingreso bruto: $[monto] [moneda]
- Deducciones aplicables: $[monto]
- [Otros datos relevantes]

### Cálculo
1. Base gravable = Ingreso bruto - Deducciones = $[resultado]
2. Tasa aplicable = [%] (según [tabla/artículo])
3. Impuesto = Base gravable × Tasa = $[resultado]
4. Retenciones previas = $[monto]
5. **Impuesto a pagar = $[resultado]**

### Supuestos
- [Supuesto 1]
- [Supuesto 2]

### ⚠️ Nota
Este cálculo es orientativo. Consulta con tu contador para la declaración oficial.
```

## Reglas
- Siempre muestra el paso a paso, no solo el resultado.
- Usa la moneda local del país (MXN, COP, ARS, CLP, PEN).
- Si hay tablas progresivas (como ISR México), muestra en qué rango cae.
- Redondea al centavo más cercano.
- Incluye fechas límite de pago si las conoces.

---
name: conciliacion-bancaria
description: |
  Proceso de conciliación bancaria y detección de discrepancias.

  Se activa cuando el usuario menciona:
  - "conciliar cuentas"
  - "estado de cuenta"
  - "diferencias bancarias"
  - "partidas en tránsito"
---

# Conciliación Bancaria

Proceso sistemático para comparar los registros contables internos contra los estados de cuenta bancarios.

## Proceso

### Paso 1: Recopilar información
- Estado de cuenta bancario del período
- Libro mayor o auxiliar de bancos del mismo período
- Conciliación del período anterior (saldo inicial)

### Paso 2: Comparar saldos
1. Anotar saldo según libros contables al cierre del período.
2. Anotar saldo según estado de cuenta bancario al cierre del período.
3. Si son iguales, la conciliación está limpia. Si no, continuar.

### Paso 3: Identificar partidas de conciliación

**Partidas en libros NO en banco:**
- Cheques en tránsito (girados pero no cobrados)
- Depósitos en tránsito (registrados pero no acreditados)
- Errores en registro contable

**Partidas en banco NO en libros:**
- Comisiones bancarias no registradas
- Intereses ganados/cobrados
- Transferencias electrónicas no registradas
- Cargos por devolución de cheques
- Domiciliaciones automáticas

### Paso 4: Ajustes
- Registrar en libros las partidas del banco que faltan (comisiones, intereses, etc.)
- Las partidas en tránsito se documentan pero no requieren ajuste contable.

## Formato de salida

```
CONCILIACIÓN BANCARIA
Empresa: [Razón social]
Cuenta: [Número de cuenta] - [Banco]
Período: [Mes/Año]

SALDO SEGÚN ESTADO DE CUENTA:          $XX,XXX.XX

(+) Depósitos en tránsito:
    - [Fecha] [Concepto]                $X,XXX.XX
    Subtotal:                           $X,XXX.XX

(-) Cheques en tránsito:
    - [No. cheque] [Fecha] [Beneficiario]  $X,XXX.XX
    Subtotal:                              $X,XXX.XX

(±) Errores bancarios:
    - [Descripción]                     $X,XXX.XX

SALDO CONCILIADO:                       $XX,XXX.XX

SALDO SEGÚN LIBROS:                     $XX,XXX.XX

(+) Notas de crédito no registradas:
    - [Concepto]                        $X,XXX.XX

(-) Notas de cargo no registradas:
    - [Comisiones] [Concepto]           $X,XXX.XX

(±) Errores en libros:
    - [Descripción]                     $X,XXX.XX

SALDO CONCILIADO:                       $XX,XXX.XX

DIFERENCIA:                             $0.00
```

## Reglas

- Los dos saldos conciliados DEBEN ser iguales. Si no lo son, hay un error que debe encontrarse.
- Documentar cada partida con fecha, concepto y monto.
- Las partidas en tránsito de más de 30 días deben investigarse.
- Mantener archivo de conciliaciones mensuales consecutivas.

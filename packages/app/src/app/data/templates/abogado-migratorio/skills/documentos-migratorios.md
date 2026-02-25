---
name: documentos-migratorios
description: |
  Preparación de documentos y cartas para trámites migratorios.

  Triggers when user mentions:
  - "carta"
  - "declaración jurada"
  - "carta de invitación"
  - "carta de empleo"
  - "documentos"
---

# Documentos Migratorios

Genera borradores de documentos comunes en trámites migratorios.

## Tipos de documentos

### Carta de invitación
Para visas de turista o visita familiar. Incluye:
- Datos del invitante (nombre, estatus migratorio, dirección)
- Datos del invitado
- Propósito y duración de la visita
- Compromiso de manutención (si aplica)

### Carta de empleo / sponsor
Para visas de trabajo. Incluye:
- Datos de la empresa
- Puesto y salario ofrecido
- Justificación de por qué se necesita al trabajador extranjero
- Compromiso de la empresa

### Declaración jurada (affidavit)
Para diversos trámites. Incluye:
- Identificación del declarante
- Hechos declarados bajo juramento
- Firma y fecha

### Carta de motivos
Para solicitudes de visa o residencia. Incluye:
- Quién es el solicitante
- Por qué solicita el trámite
- Vínculos con el país de origen (para demostrar intención de retorno, si aplica)
- Plan en el país de destino

## Reglas
- Todos los documentos son **borradores** que deben ser revisados por un abogado.
- Usa lenguaje formal y preciso.
- Incluye todos los datos que la autoridad migratoria requiere.
- Para documentos en inglés, genera versión bilingüe si el usuario lo necesita.

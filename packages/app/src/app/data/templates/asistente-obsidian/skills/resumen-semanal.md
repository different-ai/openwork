---
name: resumen-semanal
description: |
  Genera resúmenes semanales y extrae action items del vault de Obsidian.

  Triggers when user mentions:
  - "resumen semanal"
  - "weekly review"
  - "qué hice esta semana"
  - "pendientes"
  - "action items"
---

# Resúmenes Semanales y Extracción de Pendientes

Eres un asistente que ayuda a hacer revisiones periódicas del vault de Obsidian.

## Resumen semanal

Cuando el usuario pida un resumen semanal:

1. **Busca** notas creadas o modificadas en los últimos 7 días
2. **Agrupa** por proyecto o área de vida
3. **Extrae** decisiones tomadas, ideas nuevas y pendientes
4. **Genera** un reporte con este formato:

```markdown
# Resumen Semanal — [fecha inicio] a [fecha fin]

## Notas nuevas/modificadas: [N]

## Por proyecto
### [Proyecto 1]
- Lo que avanzó
- Decisiones tomadas
- Pendientes

### [Proyecto 2]
...

## Action Items
- [ ] [Tarea extraída de nota X]
- [ ] [Tarea extraída de nota Y]

## Ideas capturadas
- [Idea 1] (de [[nota]])
- [Idea 2] (de [[nota]])

## Notas huérfanas detectadas
- [[nota sin enlaces]]
```

## Reglas
- No modifiques notas existentes sin permiso explícito.
- Si no hay daily notes, trabaja con las notas modificadas recientemente.
- Distingue entre tareas completadas y pendientes.
- Sugiere conexiones entre notas que podrían estar relacionadas.

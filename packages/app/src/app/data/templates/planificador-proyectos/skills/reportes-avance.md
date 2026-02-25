---
name: reportes-avance
description: |
  Genera reportes de avance y detecta riesgos en proyectos.

  Triggers when user mentions:
  - "reporte de avance"
  - "status update"
  - "cómo va el proyecto"
  - "bloqueos"
  - "riesgos"
---

# Reportes de Avance y Gestión de Riesgos

Genera reportes claros y accionables sobre el estado de proyectos.

## Formato de reporte semanal

```markdown
# Status Update — [Proyecto] — Semana [N]
**Fecha:** [fecha] | **Salud del proyecto:** 🟢 En tiempo / 🟡 En riesgo / 🔴 Atrasado

## Resumen ejecutivo
[2-3 oraciones sobre el estado general]

## Completado esta semana
- ✅ [Tarea completada]
- ✅ [Tarea completada]

## En progreso
- 🔄 [Tarea] — [% avance] — [responsable]

## Próxima semana
- [ ] [Tarea planeada]

## Bloqueos
- 🚫 [Bloqueo] — **Impacto:** [qué se atrasa] — **Acción:** [qué se necesita]

## Riesgos identificados
| Riesgo | Probabilidad | Impacto | Mitigación |
|--------|-------------|---------|------------|

## Métricas
- Tareas completadas: [N] de [total]
- Velocidad: [puntos/semana o tareas/semana]
- Días para deadline: [N]
```

## Reglas
- Sé honesto sobre atrasos. Mejor detectar temprano.
- Cada bloqueo debe tener una acción propuesta.
- Adapta el nivel de detalle al público (ejecutivo vs equipo técnico).

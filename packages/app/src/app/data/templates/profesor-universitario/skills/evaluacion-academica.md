---
name: evaluacion-academica
description: |
  Creación de exámenes, rúbricas y retroalimentación académica.

  Triggers when user mentions:
  - "examen"
  - "rúbrica"
  - "calificar"
  - "retroalimentación"
  - "evaluación"
---

# Evaluación Académica

Diseña instrumentos de evaluación alineados con objetivos de aprendizaje.

## Tipos de evaluación

### Exámenes
- **Opción múltiple**: Para evaluar conocimiento factual. 4 opciones, 1 correcta.
- **Respuesta corta**: Para evaluar comprensión. Respuesta en 2-3 oraciones.
- **Desarrollo**: Para evaluar análisis y síntesis. Respuesta de 1-2 páginas.
- **Caso práctico**: Para evaluar aplicación. Situación real + preguntas.

### Rúbricas
```markdown
# Rúbrica — [Nombre de la actividad]

| Criterio | Excelente (10) | Bueno (8) | Suficiente (6) | Insuficiente (4) |
|----------|---------------|-----------|----------------|------------------|
| [Criterio 1] | [Descripción] | [Descripción] | [Descripción] | [Descripción] |
| [Criterio 2] | [Descripción] | [Descripción] | [Descripción] | [Descripción] |

**Puntaje total:** ___/[total]
```

### Retroalimentación
Formato para retroalimentación constructiva:
1. **Qué hiciste bien** (refuerzo positivo específico)
2. **Qué puedes mejorar** (áreas de oportunidad concretas)
3. **Cómo mejorarlo** (sugerencias accionables)
4. **Calificación** con justificación basada en la rúbrica

## Reglas
- Cada pregunta de examen debe estar alineada con un objetivo de aprendizaje.
- Las rúbricas deben tener criterios observables y medibles.
- La retroalimentación debe ser específica, no genérica ("buen trabajo" no es suficiente).
- Varía los niveles de Bloom en los exámenes (no todo memorización).

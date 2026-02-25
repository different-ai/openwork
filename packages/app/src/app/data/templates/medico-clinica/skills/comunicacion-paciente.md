---
name: comunicacion-paciente
description: |
  Comunicación clara con pacientes: explicaciones, indicaciones y seguimiento.

  Triggers when user mentions:
  - "explicar al paciente"
  - "indicaciones"
  - "consentimiento"
  - "seguimiento"
---

# Comunicación con Pacientes

Traduce información médica a lenguaje comprensible para pacientes.

## Principios
1. **Claridad**: Evita jerga médica. Usa analogías simples.
2. **Empatía**: Reconoce las preocupaciones del paciente.
3. **Accionable**: Toda comunicación debe terminar con pasos claros.
4. **Cultural**: Adapta al contexto sociocultural del paciente.

## Tipos de comunicación

### Indicaciones post-consulta
```
Hola [nombre],

Estas son las indicaciones de tu consulta del [fecha]:

💊 Medicamentos:
- [Medicamento]: [dosis], [frecuencia], [duración]
  Tómalo [con/sin alimentos]

📋 Cuidados:
- [Indicación 1]
- [Indicación 2]

⚠️ Acude a urgencias si:
- [Señal de alarma 1]
- [Señal de alarma 2]

📅 Próxima cita: [fecha]

¿Tienes alguna duda? Estamos para ayudarte.
```

### Explicación de diagnóstico (lenguaje simple)
- Qué es la condición (en 2-3 oraciones simples)
- Por qué ocurre
- Qué se va a hacer al respecto
- Qué puede esperar el paciente
- Cuándo debe preocuparse

## Reglas
- Nunca minimices las preocupaciones del paciente.
- Si el médico no ha dado un diagnóstico, no lo inventes.
- Para consentimientos informados, incluye riesgos y beneficios en lenguaje claro.
- Respeta la autonomía del paciente.

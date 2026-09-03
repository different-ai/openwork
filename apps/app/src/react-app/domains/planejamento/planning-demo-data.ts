// Dados DEMONSTRATIVOS da capacidade de Planejamento (V1).
// Declarativos, locais, determinísticos e NEUTROS — nenhum conceito específico
// de construção ou de um domínio consumidor aparece aqui. Este arquivo será
// substituído por dados reais (adapter do domínio) em fase futura, sem tocar
// na Dashboard.
import type { PlanningDashboardData } from "./planning-types";

/**
 * Dataset ilustrativo: hierarquia Grupo → Pacote → Atividade com datas no
 * período Jun–Set de 2026 e data de referência fixa (alertas determinísticos).
 */
export const PLANNING_DEMO_DATA: PlanningDashboardData = {
  context: {
    title: "Planejamento",
    subtitle: "Cronograma ilustrativo (dados de demonstração)",
    referenceDate: "2026-08-15",
  },
  items: [
    // Grupo A
    {
      id: "grupo-a",
      parentId: null,
      name: "Grupo A",
      level: 0,
      status: "planejado",
      progress: 0,
    },
    {
      id: "pacote-a-1",
      parentId: "grupo-a",
      name: "Pacote A.1",
      level: 1,
      status: "em_andamento",
      progress: 55,
      start: "2026-06-15",
      end: "2026-08-20",
    },
    {
      id: "atividade-01",
      parentId: "pacote-a-1",
      name: "Atividade 01",
      level: 2,
      status: "em_andamento",
      progress: 80,
      start: "2026-06-15",
      end: "2026-07-30",
    },
    {
      id: "atividade-02",
      parentId: "pacote-a-1",
      name: "Atividade 02",
      level: 2,
      status: "concluido",
      progress: 100,
      start: "2026-07-01",
      end: "2026-07-25",
    },
    {
      id: "atividade-03",
      parentId: "pacote-a-1",
      name: "Atividade 03",
      level: 2,
      status: "atrasado",
      progress: 40,
      start: "2026-07-20",
      end: "2026-08-10",
    },
    {
      id: "pacote-a-2",
      parentId: "grupo-a",
      name: "Pacote A.2",
      level: 1,
      status: "planejado",
      progress: 0,
      start: "2026-08-05",
      end: "2026-09-30",
    },
    {
      id: "atividade-04",
      parentId: "pacote-a-2",
      name: "Atividade 04",
      level: 2,
      status: "planejado",
      progress: 0,
      start: "2026-08-05",
      end: "2026-09-05",
    },
    {
      id: "atividade-05",
      parentId: "pacote-a-2",
      name: "Atividade 05",
      level: 2,
      status: "planejado",
      progress: 0,
    },
    // Grupo B
    {
      id: "grupo-b",
      parentId: null,
      name: "Grupo B",
      level: 0,
      status: "planejado",
      progress: 0,
    },
    {
      id: "pacote-b-1",
      parentId: "grupo-b",
      name: "Pacote B.1",
      level: 1,
      status: "concluido",
      progress: 100,
      start: "2026-06-01",
      end: "2026-06-30",
    },
    {
      id: "atividade-06",
      parentId: "pacote-b-1",
      name: "Atividade 06",
      level: 2,
      status: "concluido",
      progress: 100,
      start: "2026-06-01",
      end: "2026-06-28",
    },
    {
      id: "pacote-b-2",
      parentId: "grupo-b",
      name: "Pacote B.2",
      level: 1,
      status: "planejado",
      progress: 0,
    },
    {
      id: "atividade-07",
      parentId: "pacote-b-2",
      name: "Atividade 07",
      level: 2,
      status: "em_andamento",
      progress: 35,
    },
  ],
};

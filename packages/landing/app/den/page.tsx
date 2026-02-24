import { SiteFooter } from "../../components/site-footer";
import { SiteNav } from "../../components/site-nav";
import { getGithubData } from "../../lib/github";

export const metadata = {
  title: "AikaOS — Nube",
  description:
    "Workers hospedados en la nube para tu equipo. Accede desde escritorio, Slack o Telegram.",
};

export default async function Den() {
  const github = await getGithubData();

  return (
    <div className="min-h-screen">
      <SiteNav stars={github.stars} active="den" />

      <main className="pb-24 pt-20">
        <div className="content-max-width px-6">
          <div className="animate-fade-up">
            <div className="mb-3 text-[12px] font-bold uppercase tracking-wider text-gray-500">
              AikaOS Nube
            </div>
            <h1 className="mb-3 text-4xl font-bold tracking-tight">Nube</h1>
            <h2 className="mb-8 text-[34px] font-bold leading-tight tracking-tight text-black">
              Workers hospedados para tu equipo
            </h2>
            <p className="max-w-3xl text-[18px] leading-relaxed text-gray-600">
              AikaOS Nube le da a tu equipo workers aislados en la nube que
              puedes acceder desde la app de escritorio, Slack o Telegram.
              Todos tus skills, agentes e integraciones MCP están disponibles
              de inmediato.
            </p>
          </div>

          <div className="mb-12 mt-10 flex flex-wrap items-center gap-3">
            <a
              href="/enterprise#contacto"
              className="doc-button"
            >
              Contactar ventas
              <svg
                className="h-4 w-4"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2"
                  d="M14 5l7 7m0 0l-7 7m7-7H3"
                />
              </svg>
            </a>
          </div>

          <div className="mb-8 text-[20px] font-semibold text-black">
            Incluido en el plan Profesional — $49 USD/mes por worker.
          </div>
          <p className="mb-12 max-w-3xl text-[15px] leading-relaxed text-gray-600">
            Los primeros usuarios reciben onboarding prioritario y
            configuración personalizada de flujos de trabajo.
          </p>

          <div className="mb-14 grid grid-cols-1 gap-6 sm:grid-cols-2 md:grid-cols-3">
            <div className="feature-card">
              <h4 className="mb-2 text-[14px] font-bold">
                Workers aislados en la nube
              </h4>
              <p className="text-[13px] leading-relaxed text-gray-500">
                Cada worker corre en un entorno aislado para que tu equipo
                automatice de forma segura sin administrar infraestructura.
              </p>
            </div>
            <div className="feature-card">
              <h4 className="mb-2 text-[14px] font-bold">
                Acceso desde escritorio, Slack y Telegram
              </h4>
              <p className="text-[13px] leading-relaxed text-gray-500">
                Ejecuta y monitorea los mismos workers desde la app de
                escritorio AikaOS o directamente en los chats de tu equipo.
              </p>
            </div>
            <div className="feature-card">
              <h4 className="mb-2 text-[14px] font-bold">
                Skills, agentes y MCP incluidos
              </h4>
              <p className="text-[13px] leading-relaxed text-gray-500">
                Trae tu configuración existente de AikaOS y todo estará
                disponible de inmediato en cada worker hospedado.
              </p>
            </div>
          </div>

          <SiteFooter />
        </div>
      </main>
    </div>
  );
}

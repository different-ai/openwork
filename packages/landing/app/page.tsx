/* eslint-disable @next/next/no-img-element */

export default function Home() {
  return (
    <>
      {/* Background Layer */}
      <div className="fixed inset-0 z-0 pointer-events-none">
        <img
          src="https://hoirqrkdgbmvpwutwuwj.supabase.co/storage/v1/object/public/assets/assets/bfd2f4cf-65ed-4b1a-86d1-a1710619267b_1600w.png"
          alt="Sky Background"
          className="absolute inset-0 w-full h-full object-cover opacity-80 mix-blend-multiply"
        />
        <div className="absolute inset-0 bg-gradient-to-b from-[#A6CBE8]/20 via-[#BFD9EF]/40 to-[#EAE3D6]/60" />
        <img
          src="https://hoirqrkdgbmvpwutwuwj.supabase.co/storage/v1/object/public/assets/assets/4734259a-bad7-422f-981e-ce01e79184f2_1600w.jpg"
          className="absolute top-[20%] -left-[10%] w-[50%] opacity-40 mix-blend-screen blur-xl pointer-events-none"
          alt="cloud"
        />
        <img
          src="https://hoirqrkdgbmvpwutwuwj.supabase.co/storage/v1/object/public/assets/assets/917d6f93-fb36-439a-8c48-884b67b35381_1600w.jpg"
          className="absolute top-[30%] -right-[10%] w-[50%] opacity-40 mix-blend-screen blur-xl pointer-events-none"
          alt="cloud"
        />
      </div>

      {/* Content Wrapper */}
      <div className="relative z-10 flex flex-col min-h-screen">
        {/* Navigation */}
        <nav className="w-full px-6 py-6 md:px-12 flex items-center justify-between max-w-7xl mx-auto animate-fade-in">
          <div className="flex items-center gap-2">
            <span className="font-mono text-xl font-bold text-aika-teal">{">_"}</span>
            <span className="text-xl font-semibold text-slate-900 tracking-tight font-nunito">
              AikaOS
            </span>
          </div>

          <div className="hidden md:flex items-center gap-8 text-[15px] font-medium text-slate-700/80">
            <a href="#como-funciona" className="hover:text-black transition-colors">
              Cómo funciona
            </a>
            <a href="#por-que-local" className="hover:text-black transition-colors">
              Por qué local
            </a>
            <a href="#sectores" className="hover:text-black transition-colors">
              Sectores
            </a>
            <a href="#planes" className="hover:text-black transition-colors">
              Planes
            </a>
            <a href="#faq" className="hover:text-black transition-colors">
              FAQ
            </a>
          </div>

          <div>
            <a
              href="#planes"
              className="bg-[#1A1A1A] text-white text-[15px] font-normal px-6 py-2.5 rounded-full hover:bg-black transition-all shadow-[0_8px_16px_rgba(0,0,0,0.15)] hover:shadow-[0_12px_20px_rgba(0,0,0,0.2)] hover:-translate-y-0.5 border border-white/10"
            >
              Ver planes
            </a>
          </div>
        </nav>

        {/* Hero Section */}
        <main className="flex-grow flex flex-col items-center pt-16 pb-20 px-4 md:px-6 w-full max-w-7xl mx-auto">
          {/* Hero Text */}
          <div
            className="text-center max-w-4xl mx-auto mb-16 animate-slide-up"
            style={{ animationDelay: "0.1s" }}
          >
            <h1 className="md:text-[80px] leading-[1] text-6xl font-medium text-[#1A1A1A] tracking-tight font-nunito mb-8 drop-shadow-sm">
              Tu equipo de IA privado,
              <br />
              listo para trabajar.
            </h1>
            <p className="md:text-[19px] leading-relaxed text-lg font-normal text-slate-600 font-sans max-w-3xl mx-auto mb-4">
              AikaOS es un sistema de agentes inteligentes que corre directamente
              en tu computadora. Automatiza contratos, reportes fiscales,
              campañas, soporte y más — sin que tus datos salgan de tu empresa.
              Nosotros lo instalamos, configuramos y mantenemos actualizado.
            </p>
            <p className="text-sm text-slate-500 font-medium mb-10">
              Disponible para macOS con Apple Silicon (M1/M2/M3/M4). Windows y
              Linux en desarrollo.
            </p>

            <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
              <a
                href="#planes"
                className="text-[17px] hover:bg-black transition-all hover:shadow-[0_15px_30px_rgba(0,0,0,0.2)] hover:-translate-y-0.5 sm:w-auto font-normal text-white bg-[#1A1A1A] w-full rounded-full pt-3.5 pr-8 pb-3.5 pl-8 shadow-[0_10px_20px_rgba(0,0,0,0.15)] border border-white/10 text-center"
              >
                Ver planes desde $20/mes
              </a>
            </div>
          </div>

          {/* Product Video */}
          <div
            className="w-full max-w-[1300px] bg-white/60 backdrop-blur-2xl rounded-t-[40px] shadow-[0_50px_100px_-20px_rgba(0,0,0,0.15),0_30px_60px_-30px_rgba(0,0,0,0.1),inset_0_2px_0_rgba(255,255,255,0.8)] border border-white/80 overflow-hidden relative animate-slide-up group"
            style={{ animationDelay: "0.3s" }}
          >
            {/* AikaOS overlay on video */}
            <div className="absolute left-0 top-0 z-10 flex items-center gap-2 bg-[#1e1e2e] px-6 py-2 min-w-[260px] rounded-br-2xl">
              <span className="font-mono text-sm font-bold text-aika-teal">{">_"}</span>
              <span className="text-sm font-semibold text-white">AikaOS</span>
            </div>
            <video
              autoPlay
              loop
              muted
              playsInline
              className="w-full block"
            >
              <source src="/app-demo.mp4" type="video/mp4" />
            </video>
          </div>

          <p className="mt-4 text-center text-[13px] text-slate-500 font-medium">
            Interfaz real de AikaOS — crea tareas, ejecuta skills y automatiza
            flujos desde tu escritorio.
          </p>
        </main>

        {/* MCP Integrations Marquee */}
        <div className="w-full py-10 relative overflow-hidden">
          <p className="text-center text-xs font-semibold tracking-widest text-slate-600 uppercase mb-6 font-sans">
            Integraciones MCP compatibles
          </p>
          {/* Fade edges */}
          <div className="absolute inset-y-0 left-0 w-16 md:w-32 bg-gradient-to-r from-[#ABCDE9] to-transparent z-20 pointer-events-none" />
          <div className="absolute inset-y-0 right-0 w-16 md:w-32 bg-gradient-to-l from-[#ABCDE9] to-transparent z-20 pointer-events-none" />
          <div className="flex animate-scroll-integrations w-max gap-8 px-4">
            {/* Set 1 */}
            <div className="flex gap-8 items-center">
              <IntegrationBadge icon="simple-icons:google" label="Google" />
              <IntegrationBadge icon="simple-icons:gmail" label="Gmail" />
              <IntegrationBadge icon="simple-icons:googlecalendar" label="Calendar" />
              <IntegrationBadge icon="simple-icons:googledrive" label="Drive" />
              <IntegrationBadge icon="simple-icons:googlesheets" label="Sheets" />
              <IntegrationBadge icon="simple-icons:slack" label="Slack" />
              <IntegrationBadge icon="simple-icons:whatsapp" label="WhatsApp" />
              <IntegrationBadge icon="simple-icons:telegram" label="Telegram" />
              <IntegrationBadge icon="simple-icons:notion" label="Notion" />
              <IntegrationBadge icon="simple-icons:brave" label="Brave" />
              <IntegrationBadge icon="simple-icons:ollama" label="Ollama" />
              <IntegrationBadge icon="simple-icons:openai" label="OpenAI" />
              <IntegrationBadge icon="simple-icons:anthropic" label="Claude" />
              <IntegrationBadge icon="simple-icons:github" label="GitHub" />
              <IntegrationBadge icon="simple-icons:discord" label="Discord" />
              <IntegrationBadge icon="simple-icons:postgresql" label="PostgreSQL" />
              <IntegrationBadge icon="simple-icons:docker" label="Docker" />
              <IntegrationBadge icon="simple-icons:linear" label="Linear" />
              <IntegrationBadge icon="simple-icons:figma" label="Figma" />
              <IntegrationBadge icon="simple-icons:trello" label="Trello" />
              <IntegrationBadge icon="simple-icons:airtable" label="Airtable" />
              <IntegrationBadge icon="simple-icons:zapier" label="Zapier" />
              <IntegrationBadge icon="simple-icons:stripe" label="Stripe" />
              <IntegrationBadge icon="simple-icons:jira" label="Jira" />
              <IntegrationBadge icon="simple-icons:microsoftteams" label="Teams" />
            </div>
            {/* Set 2 (duplicate for seamless loop) */}
            <div className="flex gap-8 items-center">
              <IntegrationBadge icon="simple-icons:google" label="Google" />
              <IntegrationBadge icon="simple-icons:gmail" label="Gmail" />
              <IntegrationBadge icon="simple-icons:googlecalendar" label="Calendar" />
              <IntegrationBadge icon="simple-icons:googledrive" label="Drive" />
              <IntegrationBadge icon="simple-icons:googlesheets" label="Sheets" />
              <IntegrationBadge icon="simple-icons:slack" label="Slack" />
              <IntegrationBadge icon="simple-icons:whatsapp" label="WhatsApp" />
              <IntegrationBadge icon="simple-icons:telegram" label="Telegram" />
              <IntegrationBadge icon="simple-icons:notion" label="Notion" />
              <IntegrationBadge icon="simple-icons:brave" label="Brave" />
              <IntegrationBadge icon="simple-icons:ollama" label="Ollama" />
              <IntegrationBadge icon="simple-icons:openai" label="OpenAI" />
              <IntegrationBadge icon="simple-icons:anthropic" label="Claude" />
              <IntegrationBadge icon="simple-icons:github" label="GitHub" />
              <IntegrationBadge icon="simple-icons:discord" label="Discord" />
              <IntegrationBadge icon="simple-icons:postgresql" label="PostgreSQL" />
              <IntegrationBadge icon="simple-icons:docker" label="Docker" />
              <IntegrationBadge icon="simple-icons:linear" label="Linear" />
              <IntegrationBadge icon="simple-icons:figma" label="Figma" />
              <IntegrationBadge icon="simple-icons:trello" label="Trello" />
              <IntegrationBadge icon="simple-icons:airtable" label="Airtable" />
              <IntegrationBadge icon="simple-icons:zapier" label="Zapier" />
              <IntegrationBadge icon="simple-icons:stripe" label="Stripe" />
              <IntegrationBadge icon="simple-icons:jira" label="Jira" />
              <IntegrationBadge icon="simple-icons:microsoftteams" label="Teams" />
            </div>
          </div>
        </div>

        {/* Cómo funciona Section */}
        <section
          id="como-funciona"
          className="w-full max-w-7xl mx-auto px-4 md:px-6 py-24 relative z-10"
        >
          <div className="text-center max-w-3xl mx-auto mb-16 animate-fade-in">
            <span className="text-xs font-semibold tracking-widest text-slate-600 uppercase mb-4 block font-sans">
              Cómo funciona
            </span>
            <h2 className="md:text-5xl text-3xl font-medium text-[#1A1A1A] tracking-tight font-nunito mb-6 drop-shadow-sm">
              Puesta en marcha profesional
            </h2>
            <p className="text-lg text-slate-700 font-medium font-sans max-w-2xl mx-auto">
              AikaOS se instala en tu computadora y se conecta al modelo de IA
              que tú elijas. Nosotros nos encargamos de todo el despliegue.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
            <div className="bg-white/40 backdrop-blur-2xl rounded-[32px] p-8 border border-white/60 shadow-[0_20px_40px_-15px_rgba(0,0,0,0.05),inset_0_1px_0_rgba(255,255,255,0.8)] hover:shadow-[0_30px_60px_-15px_rgba(0,0,0,0.1)] hover:-translate-y-2 transition-all duration-500 group relative overflow-hidden">
              <div className="absolute inset-0 bg-gradient-to-br from-white/60 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none" />
              <div className="w-14 h-14 rounded-[16px] bg-gradient-to-b from-white to-white/60 border border-white shadow-[0_8px_16px_rgba(0,0,0,0.06),inset_0_-3px_6px_rgba(0,0,0,0.02)] flex items-center justify-center mb-6 text-slate-800 text-2xl group-hover:scale-110 group-hover:-translate-y-1 transition-all duration-500 relative z-10">
                {/* @ts-expect-error iconify-icon is a web component */}
                <iconify-icon icon="solar:clipboard-list-linear" />
              </div>
              <h3 className="text-xl font-semibold text-[#1A1A1A] font-nunito mb-3 relative z-10">
                1. Elige tu plan
              </h3>
              <p className="text-[14px] leading-relaxed text-slate-700 font-medium relative z-10">
                Selecciona el plan que se adapte a tu empresa (desde $20
                USD/mes). Nuestro equipo te contactará para coordinar la
                instalación.
              </p>
            </div>

            <div className="bg-white/40 backdrop-blur-2xl rounded-[32px] p-8 border border-white/60 shadow-[0_20px_40px_-15px_rgba(0,0,0,0.05),inset_0_1px_0_rgba(255,255,255,0.8)] hover:shadow-[0_30px_60px_-15px_rgba(0,0,0,0.1)] hover:-translate-y-2 transition-all duration-500 group relative overflow-hidden">
              <div className="absolute inset-0 bg-gradient-to-br from-white/60 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none" />
              <div className="w-14 h-14 rounded-[16px] bg-gradient-to-b from-white to-white/60 border border-white shadow-[0_8px_16px_rgba(0,0,0,0.06),inset_0_-3px_6px_rgba(0,0,0,0.02)] flex items-center justify-center mb-6 text-slate-800 text-2xl group-hover:scale-110 group-hover:-translate-y-1 transition-all duration-500 relative z-10">
                {/* @ts-expect-error iconify-icon is a web component */}
                <iconify-icon icon="solar:cpu-linear" />
              </div>
              <h3 className="text-xl font-semibold text-[#1A1A1A] font-nunito mb-3 relative z-10">
                2. Conecta tu modelo
              </h3>
              <p className="text-[14px] leading-relaxed text-slate-700 font-medium relative z-10">
                AikaOS funciona con tu API key (Claude, OpenAI) o modelos
                locales con Ollama. Te asistimos en la integración técnica.
              </p>
            </div>

            <div className="bg-white/40 backdrop-blur-2xl rounded-[32px] p-8 border border-white/60 shadow-[0_20px_40px_-15px_rgba(0,0,0,0.05),inset_0_1px_0_rgba(255,255,255,0.8)] hover:shadow-[0_30px_60px_-15px_rgba(0,0,0,0.1)] hover:-translate-y-2 transition-all duration-500 group relative overflow-hidden">
              <div className="absolute inset-0 bg-gradient-to-br from-white/60 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none" />
              <div className="w-14 h-14 rounded-[16px] bg-gradient-to-b from-white to-white/60 border border-white shadow-[0_8px_16px_rgba(0,0,0,0.06),inset_0_-3px_6px_rgba(0,0,0,0.02)] flex items-center justify-center mb-6 text-slate-800 text-2xl group-hover:scale-110 group-hover:-translate-y-1 transition-all duration-500 relative z-10">
                {/* @ts-expect-error iconify-icon is a web component */}
                <iconify-icon icon="solar:box-linear" />
              </div>
              <h3 className="text-xl font-semibold text-[#1A1A1A] font-nunito mb-3 relative z-10">
                3. Recibe tu sistema
              </h3>
              <p className="text-[14px] leading-relaxed text-slate-700 font-medium relative z-10">
                Te entregamos AikaOS instalado y configurado con los expertos y
                skills de tu industria. Listo para trabajar desde el día uno.
              </p>
            </div>

            <div className="bg-white/40 backdrop-blur-2xl rounded-[32px] p-8 border border-white/60 shadow-[0_20px_40px_-15px_rgba(0,0,0,0.05),inset_0_1px_0_rgba(255,255,255,0.8)] hover:shadow-[0_30px_60px_-15px_rgba(0,0,0,0.1)] hover:-translate-y-2 transition-all duration-500 group relative overflow-hidden">
              <div className="absolute inset-0 bg-gradient-to-br from-white/60 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none" />
              <div className="w-14 h-14 rounded-[16px] bg-gradient-to-b from-white to-white/60 border border-white shadow-[0_8px_16px_rgba(0,0,0,0.06),inset_0_-3px_6px_rgba(0,0,0,0.02)] flex items-center justify-center mb-6 text-slate-800 text-2xl group-hover:scale-110 group-hover:-translate-y-1 transition-all duration-500 relative z-10">
                {/* @ts-expect-error iconify-icon is a web component */}
                <iconify-icon icon="solar:refresh-circle-linear" />
              </div>
              <h3 className="text-xl font-semibold text-[#1A1A1A] font-nunito mb-3 relative z-10">
                4. Soporte continuo
              </h3>
              <p className="text-[14px] leading-relaxed text-slate-700 font-medium relative z-10">
                Tu plan incluye actualizaciones con nuevos modelos, integraciones
                avanzadas y soporte técnico personalizado constante.
              </p>
            </div>
          </div>
        </section>
      </div>

      {/* BYOM + Por qué local feature blocks */}
      <section className="md:px-12 z-10 w-full max-w-7xl mr-auto ml-auto pt-12 pr-4 pb-24 pl-4 relative">
        {/* Feature Block 1: BYOM */}
        <div className="flex flex-col lg:flex-row items-center gap-12 lg:gap-24 mb-32">
          {/* Mockup / Visual (Left) */}
          <div className="w-full lg:w-[55%] relative group">
            <div className="absolute inset-0 bg-gradient-to-br from-white/40 to-white/10 backdrop-blur-3xl rounded-[40px] border border-white/60 shadow-[0_30px_60px_-15px_rgba(0,0,0,0.1),inset_0_1px_0_rgba(255,255,255,1)] transform rotate-1 transition-all duration-700 group-hover:rotate-0 group-hover:shadow-[0_40px_80px_-20px_rgba(0,0,0,0.15)]" />
            <div className="md:p-12 transition-transform duration-500 group-hover:scale-[1.02] pt-8 pr-8 pb-8 pl-8 relative z-10">
              <div className="overflow-hidden font-sans bg-white/70 backdrop-blur-xl max-w-lg border-white/80 border rounded-[28px] mr-auto ml-auto shadow-[0_20px_50px_rgba(0,0,0,0.08),inset_0_1px_0_rgba(255,255,255,1)] p-8">
                <h3 className="font-semibold text-lg text-slate-900 mb-6 font-nunito flex items-center gap-2">
                  {/* @ts-expect-error iconify-icon is a web component */}
                  <iconify-icon
                    icon="solar:laptop-minimalistic-linear"
                    class="text-xl text-slate-700"
                  />
                  Requisitos del sistema
                </h3>

                <div className="space-y-3">
                  <div className="flex items-center justify-between p-4 bg-white/60 backdrop-blur-md rounded-2xl border border-white shadow-[0_2px_10px_rgba(0,0,0,0.02)] hover:bg-white/80 transition-colors">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-lg bg-gradient-to-b from-slate-50 to-slate-100 border border-white flex items-center justify-center shadow-sm">
                        {/* @ts-expect-error iconify-icon is a web component */}
                        <iconify-icon
                          icon="solar:monitor-linear"
                          class="text-slate-600 text-lg"
                        />
                      </div>
                      <span className="text-[14px] font-semibold text-slate-800">
                        Sistema Operativo
                      </span>
                    </div>
                    <span className="text-xs font-semibold bg-white/80 px-3 py-1.5 rounded-full border border-slate-200/50 shadow-sm text-slate-700">
                      macOS 12.0+
                    </span>
                  </div>
                  <div className="flex items-center justify-between p-4 bg-white/60 backdrop-blur-md rounded-2xl border border-white shadow-[0_2px_10px_rgba(0,0,0,0.02)] hover:bg-white/80 transition-colors">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-lg bg-gradient-to-b from-slate-50 to-slate-100 border border-white flex items-center justify-center shadow-sm">
                        {/* @ts-expect-error iconify-icon is a web component */}
                        <iconify-icon
                          icon="solar:cpu-linear"
                          class="text-slate-600 text-lg"
                        />
                      </div>
                      <span className="text-[14px] font-semibold text-slate-800">
                        Procesador
                      </span>
                    </div>
                    <span className="text-xs font-semibold bg-white/80 px-3 py-1.5 rounded-full border border-slate-200/50 shadow-sm text-slate-700">
                      Apple M1 a M4
                    </span>
                  </div>
                  <div className="flex items-center justify-between p-4 bg-white/60 backdrop-blur-md rounded-2xl border border-white shadow-[0_2px_10px_rgba(0,0,0,0.02)] hover:bg-white/80 transition-colors">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-lg bg-gradient-to-b from-slate-50 to-slate-100 border border-white flex items-center justify-center shadow-sm">
                        {/* @ts-expect-error iconify-icon is a web component */}
                        <iconify-icon
                          icon="solar:database-linear"
                          class="text-slate-600 text-lg"
                        />
                      </div>
                      <span className="text-[14px] font-semibold text-slate-800">
                        Memoria RAM
                      </span>
                    </div>
                    <span className="text-xs font-semibold bg-white/80 px-3 py-1.5 rounded-full border border-slate-200/50 shadow-sm text-slate-700">
                      8GB min (16GB rec.)
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Content (Right) */}
          <div className="w-full lg:w-[45%]">
            <span className="text-xs font-semibold tracking-widest text-slate-600 uppercase mb-4 block font-sans">
              Flexibilidad total
            </span>
            <h2 className="lg:text-[40px] leading-[1.15] text-4xl font-medium text-[#1A1A1A] tracking-tight font-nunito mb-6 drop-shadow-sm">
              Trae tu propio modelo (BYOM)
            </h2>
            <p className="leading-relaxed text-lg font-medium text-slate-700 font-sans mb-10">
              AikaOS no te obliga a usar un modelo específico. Tú decides qué
              inteligencia artificial potencia tu sistema y nosotros nos
              aseguramos de que corra perfectamente en tu entorno.
            </p>

            <div className="space-y-6">
              <div className="flex items-start gap-4">
                <div className="w-12 h-12 rounded-[14px] bg-white/60 backdrop-blur-md border border-white shadow-[0_4px_10px_rgba(0,0,0,0.05),inset_0_1px_0_rgba(255,255,255,0.8)] flex items-center justify-center shrink-0 mt-1">
                  {/* @ts-expect-error iconify-icon is a web component */}
                  <iconify-icon
                    icon="solar:key-linear"
                    class="text-slate-800 text-xl"
                  />
                </div>
                <div>
                  <h4 className="font-semibold text-slate-900 text-[15px] mb-1">
                    API key propia
                  </h4>
                  <p className="text-sm text-slate-700 font-medium leading-relaxed">
                    Anthropic (Claude), OpenAI (GPT-4), DeepSeek, Google Gemini,
                    o cualquier proveedor compatible.
                  </p>
                </div>
              </div>
              <div className="flex items-start gap-4">
                <div className="w-12 h-12 rounded-[14px] bg-white/60 backdrop-blur-md border border-white shadow-[0_4px_10px_rgba(0,0,0,0.05),inset_0_1px_0_rgba(255,255,255,0.8)] flex items-center justify-center shrink-0 mt-1">
                  {/* @ts-expect-error iconify-icon is a web component */}
                  <iconify-icon
                    icon="solar:server-square-linear"
                    class="text-slate-800 text-xl"
                  />
                </div>
                <div>
                  <h4 className="font-semibold text-slate-900 text-[15px] mb-1">
                    Modelos locales
                  </h4>
                  <p className="text-sm text-slate-700 font-medium leading-relaxed">
                    Ollama con Llama, Mistral, Phi u otros modelos que corren
                    100% en tu máquina sin internet.
                  </p>
                </div>
              </div>
              <div className="flex items-start gap-4">
                <div className="w-12 h-12 rounded-[14px] bg-white/60 backdrop-blur-md border border-white shadow-[0_4px_10px_rgba(0,0,0,0.05),inset_0_1px_0_rgba(255,255,255,0.8)] flex items-center justify-center shrink-0 mt-1">
                  {/* @ts-expect-error iconify-icon is a web component */}
                  <iconify-icon
                    icon="solar:code-circle-linear"
                    class="text-slate-800 text-xl"
                  />
                </div>
                <div>
                  <h4 className="font-semibold text-slate-900 text-[15px] mb-1">
                    OpenCode
                  </h4>
                  <p className="text-sm text-slate-700 font-medium leading-relaxed">
                    Si ya tienes una suscripción de OpenCode, puedes conectarla
                    directamente a AikaOS.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Feature Block 2: Por qué local */}
        <div
          id="por-que-local"
          className="flex flex-col-reverse lg:flex-row items-center gap-12 lg:gap-24"
        >
          {/* Content (Left) */}
          <div className="w-full lg:w-[45%]">
            <span className="text-xs font-semibold tracking-widest text-slate-600 uppercase mb-4 block font-sans">
              Seguridad y Control
            </span>
            <h2 className="lg:text-[40px] leading-[1.15] text-4xl font-medium text-[#1A1A1A] tracking-tight font-nunito mb-6 drop-shadow-sm">
              ¿Por qué correr tu IA en local?
            </h2>
            <p className="text-lg text-slate-700 font-medium mb-8 leading-relaxed font-sans">
              La mayoría de las herramientas de IA procesan tus datos en
              servidores externos. Tus conversaciones y estrategias pasan por
              manos de terceros. AikaOS funciona diferente: todo corre en tu
              máquina.
            </p>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="flex items-start gap-3 p-4 rounded-[20px] border border-white/60 bg-white/40 backdrop-blur-xl shadow-[0_8px_20px_rgba(0,0,0,0.03),inset_0_1px_0_rgba(255,255,255,0.8)] hover:bg-white/60 hover:shadow-[0_12px_30px_rgba(0,0,0,0.08)] hover:-translate-y-1 transition-all duration-300 cursor-default">
                <div className="w-10 h-10 rounded-xl bg-gradient-to-b from-white to-white/60 border border-white flex items-center justify-center shadow-sm shrink-0">
                  {/* @ts-expect-error iconify-icon is a web component */}
                  <iconify-icon
                    icon="solar:shield-check-linear"
                    class="text-slate-800 text-lg"
                  />
                </div>
                <div>
                  <span className="text-[14px] font-semibold text-slate-900 block mb-0.5">
                    Privacidad total
                  </span>
                  <span className="text-[12px] font-medium text-slate-600 leading-tight block">
                    Tus datos nunca salen de tu máquina. Cero fugas.
                  </span>
                </div>
              </div>
              <div className="flex items-start gap-3 p-4 rounded-[20px] border border-white/60 bg-white/40 backdrop-blur-xl shadow-[0_8px_20px_rgba(0,0,0,0.03),inset_0_1px_0_rgba(255,255,255,0.8)] hover:bg-white/60 hover:shadow-[0_12px_30px_rgba(0,0,0,0.08)] hover:-translate-y-1 transition-all duration-300 cursor-default">
                <div className="w-10 h-10 rounded-xl bg-gradient-to-b from-white to-white/60 border border-white flex items-center justify-center shadow-sm shrink-0">
                  {/* @ts-expect-error iconify-icon is a web component */}
                  <iconify-icon
                    icon="solar:wallet-money-linear"
                    class="text-slate-800 text-lg"
                  />
                </div>
                <div>
                  <span className="text-[14px] font-semibold text-slate-900 block mb-0.5">
                    Costos predecibles
                  </span>
                  <span className="text-[12px] font-medium text-slate-600 leading-tight block">
                    Precio fijo. Con modelos locales, $0 en tokens.
                  </span>
                </div>
              </div>
              <div className="flex items-start gap-3 p-4 rounded-[20px] border border-white/60 bg-white/40 backdrop-blur-xl shadow-[0_8px_20px_rgba(0,0,0,0.03),inset_0_1px_0_rgba(255,255,255,0.8)] hover:bg-white/60 hover:shadow-[0_12px_30px_rgba(0,0,0,0.08)] hover:-translate-y-1 transition-all duration-300 cursor-default">
                <div className="w-10 h-10 rounded-xl bg-gradient-to-b from-white to-white/60 border border-white flex items-center justify-center shadow-sm shrink-0">
                  {/* @ts-expect-error iconify-icon is a web component */}
                  <iconify-icon
                    icon="solar:link-broken-linear"
                    class="text-slate-800 text-lg"
                  />
                </div>
                <div>
                  <span className="text-[14px] font-semibold text-slate-900 block mb-0.5">
                    Sin dependencia
                  </span>
                  <span className="text-[12px] font-medium text-slate-600 leading-tight block">
                    Cambia de proveedor (Claude, GPT) sin romper flujos.
                  </span>
                </div>
              </div>
              <div className="flex items-start gap-3 p-4 rounded-[20px] border border-white/60 bg-white/40 backdrop-blur-xl shadow-[0_8px_20px_rgba(0,0,0,0.03),inset_0_1px_0_rgba(255,255,255,0.8)] hover:bg-white/60 hover:shadow-[0_12px_30px_rgba(0,0,0,0.08)] hover:-translate-y-1 transition-all duration-300 cursor-default">
                <div className="w-10 h-10 rounded-xl bg-gradient-to-b from-white to-white/60 border border-white flex items-center justify-center shadow-sm shrink-0">
                  {/* @ts-expect-error iconify-icon is a web component */}
                  <iconify-icon
                    icon="solar:document-text-linear"
                    class="text-slate-800 text-lg"
                  />
                </div>
                <div>
                  <span className="text-[14px] font-semibold text-slate-900 block mb-0.5">
                    Cumplimiento
                  </span>
                  <span className="text-[12px] font-medium text-slate-600 leading-tight block">
                    Cumple automáticamente con GDPR, LGPD y más.
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Visual (Right) */}
          <div className="w-full lg:w-[55%] relative group">
            <div className="absolute inset-0 bg-gradient-to-bl from-white/40 to-white/10 backdrop-blur-3xl rounded-[40px] border border-white/60 shadow-[0_30px_60px_-15px_rgba(0,0,0,0.1),inset_0_1px_0_rgba(255,255,255,1)] transform -rotate-1 transition-all duration-700 group-hover:rotate-0 group-hover:shadow-[0_40px_80px_-20px_rgba(0,0,0,0.15)]" />

            <div className="md:p-12 transition-transform duration-500 group-hover:scale-[1.02] pt-8 pr-8 pb-8 pl-8 relative z-10 flex items-center justify-center">
              <div className="font-sans bg-white/60 backdrop-blur-xl border-white/80 border rounded-full w-64 h-64 flex flex-col items-center justify-center shadow-[0_20px_50px_rgba(0,0,0,0.08),inset_0_2px_0_rgba(255,255,255,1)] relative overflow-hidden">
                {/* Animated rings representing local processing */}
                <div className="absolute inset-0 border-[6px] border-white/40 rounded-full animate-[spin_10s_linear_infinite]" />
                <div className="absolute inset-5 border-[4px] border-blue-100/50 rounded-full animate-[spin_15s_linear_infinite_reverse]" />

                <div className="w-20 h-20 rounded-full bg-gradient-to-b from-white to-slate-50 border border-white shadow-lg flex items-center justify-center mb-3 relative z-10">
                  {/* @ts-expect-error iconify-icon is a web component */}
                  <iconify-icon
                    icon="solar:shield-check-linear"
                    class="text-4xl text-slate-800"
                  />
                </div>
                <span className="font-nunito font-semibold text-slate-900 text-lg relative z-10 tracking-tight">
                  Local-first
                </span>
                <span className="text-xs font-medium text-slate-600 mt-0.5 relative z-10">
                  100% procesado aquí
                </span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Experts + Lo que puedes hacer */}
      <section className="md:px-12 z-10 w-full max-w-7xl mr-auto ml-auto pt-12 pr-4 pb-24 pl-4 relative">
        {/* Top Grid: Large Feature Cards */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 mb-8">
          <div className="bg-white/40 backdrop-blur-2xl rounded-[36px] p-8 md:p-12 flex flex-col justify-between shadow-[0_20px_50px_-15px_rgba(0,0,0,0.05),inset_0_1px_0_rgba(255,255,255,0.8)] border border-white/60 hover:shadow-[0_30px_60px_-15px_rgba(0,0,0,0.1)] transition-all duration-500 hover:-translate-y-2 group relative overflow-hidden">
            <div className="absolute inset-0 bg-gradient-to-br from-white/40 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none" />
            <div className="relative z-10">
              <h3 className="md:text-[32px] leading-tight text-3xl font-medium text-[#1A1A1A] font-nunito max-w-md mb-6 drop-shadow-sm">
                25 expertos preconfigurados para LATAM
              </h3>
              <p className="text-[16px] leading-relaxed text-slate-700 font-medium font-sans mb-10">
                Cada experto incluye skills especializados, comandos listos para
                usar y servidores MCP configurados. Disponibles a partir del
                plan Profesional.
              </p>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
                <ExpertTag icon="solar:diploma-linear" label="Legal LATAM" />
                <ExpertTag icon="solar:chart-square-linear" label="Contabilidad" />
                <ExpertTag icon="solar:cart-large-linear" label="E-commerce" />
                <ExpertTag icon="solar:megaphone-linear" label="Marketing" />
                <ExpertTag icon="solar:square-academic-cap-linear" label="Educación" />
                <ExpertTag icon="solar:buildings-2-linear" label="Gobierno" />
                <ExpertTag icon="solar:heart-pulse-linear" label="Salud" />
                <ExpertTag icon="solar:home-2-linear" label="Inmobiliaria" />
                <ExpertTag icon="solar:routing-2-linear" label="Logística" />
                <ExpertTag icon="solar:leaf-linear" label="Agricultura" />
                <ExpertTag icon="solar:card-linear" label="Fintech" />
                <ExpertTag icon="solar:buildings-linear" label="Construcción" />
                <ExpertTag icon="solar:people-nearby-linear" label="RRHH" />
                <ExpertTag icon="solar:clipboard-text-linear" label="Seguros" />
                <ExpertTag icon="solar:calculator-linear" label="Fiscal" />
                <ExpertTag icon="solar:chat-round-dots-linear" label="Soporte" />
                <ExpertTag icon="solar:bag-4-linear" label="Retail" />
                <ExpertTag icon="solar:document-text-linear" label="Notarial" />
                <ExpertTag icon="solar:graph-up-linear" label="Analítica" />
                <ExpertTag icon="solar:pen-new-square-linear" label="Copywriting" />
                <ExpertTag icon="solar:translation-linear" label="Traductor" />
                <ExpertTag icon="solar:calendar-linear" label="Productividad" />
                <ExpertTag icon="solar:database-linear" label="Datos" />
                <ExpertTag icon="solar:shield-check-linear" label="Compliance" />
                <ExpertTag icon="solar:hand-money-linear" label="Cobranza" />
              </div>
            </div>
          </div>

          <div className="bg-white/40 backdrop-blur-2xl rounded-[36px] p-8 md:p-12 flex flex-col justify-between shadow-[0_20px_50px_-15px_rgba(0,0,0,0.05),inset_0_1px_0_rgba(255,255,255,0.8)] border border-white/60 hover:shadow-[0_30px_60px_-15px_rgba(0,0,0,0.1)] transition-all duration-500 hover:-translate-y-2 group relative overflow-hidden">
            <div className="absolute inset-0 bg-gradient-to-br from-white/40 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none" />
            <div className="relative z-10">
              <h3 className="md:text-[32px] leading-tight text-3xl font-medium text-[#1A1A1A] font-nunito max-w-md mb-6 drop-shadow-sm">
                + 5 expertos premium avanzados
              </h3>
              <p className="text-[16px] leading-relaxed text-slate-700 font-medium font-sans mb-10">
                Expertos avanzados con 3 skills especializados y 5 comandos cada
                uno. Se instalan como workers independientes. Incluidos en
                planes Business.
              </p>
              <div className="flex flex-col gap-4">
                <div className="bg-white/60 backdrop-blur-md p-5 rounded-2xl shadow-[0_4px_15px_rgba(0,0,0,0.03)] border border-white flex flex-col gap-1.5 transition-transform hover:scale-[1.02]">
                  <div className="flex items-center gap-3 font-semibold text-slate-900 text-[15px]">
                    <div className="w-8 h-8 rounded-lg bg-white shadow-sm flex items-center justify-center text-slate-700">
                      {/* @ts-expect-error iconify-icon is a web component */}
                      <iconify-icon icon="solar:global-linear" />
                    </div>
                    Investigador Web
                  </div>
                  <span className="text-[13px] font-medium text-slate-600 pl-11">
                    Fact-checking (SIFT), verificación de fuentes.
                  </span>
                </div>
                <div className="bg-white/60 backdrop-blur-md p-5 rounded-2xl shadow-[0_4px_15px_rgba(0,0,0,0.03)] border border-white flex flex-col gap-1.5 transition-transform hover:scale-[1.02]">
                  <div className="flex items-center gap-3 font-semibold text-slate-900 text-[15px]">
                    <div className="w-8 h-8 rounded-lg bg-white shadow-sm flex items-center justify-center text-slate-700">
                      {/* @ts-expect-error iconify-icon is a web component */}
                      <iconify-icon icon="solar:smartphone-linear" />
                    </div>
                    Creador de Contenido
                  </div>
                  <span className="text-[13px] font-medium text-slate-600 pl-11">
                    Calendarios, hilos virales, copy (AIDA/PAS).
                  </span>
                </div>
                <div className="bg-white/60 backdrop-blur-md p-5 rounded-2xl shadow-[0_4px_15px_rgba(0,0,0,0.03)] border border-white flex flex-col gap-1.5 transition-transform hover:scale-[1.02]">
                  <div className="flex items-center gap-3 font-semibold text-slate-900 text-[15px]">
                    <div className="w-8 h-8 rounded-lg bg-white shadow-sm flex items-center justify-center text-slate-700">
                      {/* @ts-expect-error iconify-icon is a web component */}
                      <iconify-icon icon="solar:handshake-linear" />
                    </div>
                    Ventas B2B Pro
                  </div>
                  <span className="text-[13px] font-medium text-slate-600 pl-11">
                    BANT+MEDDIC, propuestas, manejo de objeciones.
                  </span>
                </div>
                {/* Missing premium experts from original: Asistente Obsidian + Asistente Inmobiliario */}
                <div className="bg-white/60 backdrop-blur-md p-5 rounded-2xl shadow-[0_4px_15px_rgba(0,0,0,0.03)] border border-white flex flex-col gap-1.5 transition-transform hover:scale-[1.02]">
                  <div className="flex items-center gap-3 font-semibold text-slate-900 text-[15px]">
                    <div className="w-8 h-8 rounded-lg bg-white shadow-sm flex items-center justify-center text-slate-700">
                      {/* @ts-expect-error iconify-icon is a web component */}
                      <iconify-icon icon="solar:notebook-linear" />
                    </div>
                    Asistente Obsidian
                  </div>
                  <span className="text-[13px] font-medium text-slate-600 pl-11">
                    Zettelkasten, MOCs, weekly reviews, procesamiento de inbox.
                  </span>
                </div>
                <div className="bg-white/60 backdrop-blur-md p-5 rounded-2xl shadow-[0_4px_15px_rgba(0,0,0,0.03)] border border-white flex flex-col gap-1.5 transition-transform hover:scale-[1.02]">
                  <div className="flex items-center gap-3 font-semibold text-slate-900 text-[15px]">
                    <div className="w-8 h-8 rounded-lg bg-white shadow-sm flex items-center justify-center text-slate-700">
                      {/* @ts-expect-error iconify-icon is a web component */}
                      <iconify-icon icon="solar:home-2-linear" />
                    </div>
                    Asistente Inmobiliario
                  </div>
                  <span className="text-[13px] font-medium text-slate-600 pl-11">
                    Fichas, análisis de inversión (Cap Rate, GRM), contratos por
                    país.
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Bottom Grid: Small Feature Cards (Lo que puedes hacer) */}
        <div className="mb-10 mt-16">
          <h3 className="text-3xl font-medium text-[#1A1A1A] font-nunito drop-shadow-sm">
            Lo que puedes hacer con AikaOS
          </h3>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="bg-white/40 backdrop-blur-2xl rounded-[32px] p-8 flex flex-col items-start gap-5 shadow-[0_15px_30px_-10px_rgba(0,0,0,0.05),inset_0_1px_0_rgba(255,255,255,0.8)] border border-white/60 hover:shadow-[0_25px_50px_-15px_rgba(0,0,0,0.1)] transition-all duration-500 hover:-translate-y-2 group">
            <div className="w-14 h-14 rounded-[16px] bg-gradient-to-b from-white to-white/60 border border-white shadow-[0_8px_16px_rgba(0,0,0,0.06),inset_0_-3px_6px_rgba(0,0,0,0.02)] flex items-center justify-center text-2xl text-slate-800 group-hover:scale-110 transition-transform duration-500">
              {/* @ts-expect-error iconify-icon is a web component */}
              <iconify-icon icon="solar:infinity-linear" />
            </div>
            <h4 className="text-[19px] font-semibold text-slate-900 font-nunito tracking-tight">
              Sin límites de uso
            </h4>
            <p className="text-[14px] font-medium leading-relaxed text-slate-700">
              Herramientas cloud limitan por ventanas de tiempo. Con AikaOS y un
              modelo local, puedes trabajar todo el día sin interrupciones ni
              costos extra por token.
            </p>
          </div>

          <div className="bg-white/40 backdrop-blur-2xl rounded-[32px] p-8 flex flex-col items-start gap-5 shadow-[0_15px_30px_-10px_rgba(0,0,0,0.05),inset_0_1px_0_rgba(255,255,255,0.8)] border border-white/60 hover:shadow-[0_25px_50px_-15px_rgba(0,0,0,0.1)] transition-all duration-500 hover:-translate-y-2 group">
            <div className="w-14 h-14 rounded-[16px] bg-gradient-to-b from-white to-white/60 border border-white shadow-[0_8px_16px_rgba(0,0,0,0.06),inset_0_-3px_6px_rgba(0,0,0,0.02)] flex items-center justify-center text-2xl text-slate-800 group-hover:scale-110 transition-transform duration-500">
              {/* @ts-expect-error iconify-icon is a web component */}
              <iconify-icon icon="solar:wifi-router-minimalistic-linear" />
            </div>
            <h4 className="text-[19px] font-semibold text-slate-900 font-nunito tracking-tight">
              Funciona sin internet
            </h4>
            <p className="text-[14px] font-medium leading-relaxed text-slate-700">
              Con un modelo local (Ollama) instalado, AikaOS funciona
              completamente offline. Especialmente valioso donde no hay acceso
              confiable a internet.
            </p>
          </div>

          <div className="bg-white/40 backdrop-blur-2xl rounded-[32px] p-8 flex flex-col items-start gap-5 shadow-[0_15px_30px_-10px_rgba(0,0,0,0.05),inset_0_1px_0_rgba(255,255,255,0.8)] border border-white/60 hover:shadow-[0_25px_50px_-15px_rgba(0,0,0,0.1)] transition-all duration-500 hover:-translate-y-2 group">
            <div className="w-14 h-14 rounded-[16px] bg-gradient-to-b from-white to-white/60 border border-white shadow-[0_8px_16px_rgba(0,0,0,0.06),inset_0_-3px_6px_rgba(0,0,0,0.02)] flex items-center justify-center text-2xl text-slate-800 group-hover:scale-110 transition-transform duration-500">
              {/* @ts-expect-error iconify-icon is a web component */}
              <iconify-icon icon="solar:layers-linear" />
            </div>
            <h4 className="text-[19px] font-semibold text-slate-900 font-nunito tracking-tight">
              Multitarea paralela
            </h4>
            <p className="text-[14px] font-medium leading-relaxed text-slate-700">
              Ejecuta múltiples hilos en paralelo y cambia de contexto entre
              tareas de navegador y archivos locales al instante. Reutiliza
              skills con tu equipo.
            </p>
          </div>
        </div>
      </section>

      {/* Sectores (Scrolling) */}
      <section
        id="sectores"
        className="w-full relative py-24 z-10 border-t border-white/30 overflow-hidden"
      >
        <div className="max-w-4xl mx-auto px-6 text-center mb-16 relative z-10">
          <span className="text-xs font-semibold tracking-widest text-slate-600 uppercase mb-4 block font-sans">
            Sectores
          </span>
          <h2 className="leading-[1.15] md:text-4xl text-3xl font-medium text-[#1A1A1A] tracking-tight font-nunito drop-shadow-sm">
            Diseñado para las industrias de LATAM
          </h2>
        </div>

        <div className="relative w-full overflow-hidden pb-10">
          {/* Fade gradients on edges */}
          <div className="absolute inset-y-0 left-0 w-16 md:w-32 bg-gradient-to-r from-[#ABCDE9] to-transparent z-20 pointer-events-none mix-blend-overlay" />
          <div className="absolute inset-y-0 right-0 w-16 md:w-32 bg-gradient-to-l from-[#ABCDE9] to-transparent z-20 pointer-events-none mix-blend-overlay" />

          <div className="flex animate-scroll-testimonials w-max gap-6 px-4">
            {/* Set 1 */}
            <div className="flex gap-6">
              <SectorCard icon="solar:diploma-linear" title="Despachos legales" desc="Automatiza contratos, poderes notariales y revisión de documentos en minutos." />
              <SectorCard icon="solar:chart-square-linear" title="Firmas contables" desc="Genera reportes fiscales, concilia cuentas y cumple con normativas locales." />
              <SectorCard icon="solar:cart-large-linear" title="Comercio minorista" desc="Gestiona catálogos, responde clientes y analiza inventario automáticamente." />
              <SectorCard icon="solar:megaphone-linear" title="Agencias de marketing" desc="Crea campañas, genera copy persuasivo y reporta métricas semanales." />
              <SectorCard icon="solar:square-academic-cap-linear" title="Instituciones educativas" desc="Diseña planes de clase, rúbricas y exámenes alineados a estándares." />
              <SectorCard icon="solar:buildings-2-linear" title="Gobierno municipal" desc="Redacta oficios, informes de transparencia y respuestas ciudadanas." />
              <SectorCard icon="solar:heart-pulse-linear" title="Salud y clínicas" desc="Agenda citas, automatiza facturación, resúmenes clínicos y apoya el triaje." />
              <SectorCard icon="solar:home-2-linear" title="Inmobiliaria / PropTech" desc="Publica propiedades, genera contratos de arrendamiento y automatiza valuaciones." />
              <SectorCard icon="solar:routing-2-linear" title="Logística" desc="Predice demanda, rastrea envíos, coordina proveedores y genera reportes." />
              <SectorCard icon="solar:leaf-linear" title="Agricultura" desc="Planifica cultivos, trámites de exportación y analiza datos climáticos offline." />
              <SectorCard icon="solar:card-linear" title="Fintech" desc="Procesa documentos de crédito, automatiza onboarding y analiza riesgo crediticio." />
              <SectorCard icon="solar:buildings-linear" title="Construcción" desc="Prepara licitaciones, documenta avance de obra y automatiza presupuestos de materiales." />
            </div>

            {/* Set 2 (Duplicate for seamless scroll) */}
            <div className="flex gap-6">
              <SectorCard icon="solar:diploma-linear" title="Despachos legales" desc="Automatiza contratos, poderes notariales y revisión de documentos en minutos." />
              <SectorCard icon="solar:chart-square-linear" title="Firmas contables" desc="Genera reportes fiscales, concilia cuentas y cumple con normativas locales." />
              <SectorCard icon="solar:cart-large-linear" title="Comercio minorista" desc="Gestiona catálogos, responde clientes y analiza inventario automáticamente." />
              <SectorCard icon="solar:megaphone-linear" title="Agencias de marketing" desc="Crea campañas, genera copy persuasivo y reporta métricas semanales." />
              <SectorCard icon="solar:square-academic-cap-linear" title="Instituciones educativas" desc="Diseña planes de clase, rúbricas y exámenes alineados a estándares." />
              <SectorCard icon="solar:buildings-2-linear" title="Gobierno municipal" desc="Redacta oficios, informes de transparencia y respuestas ciudadanas." />
              <SectorCard icon="solar:heart-pulse-linear" title="Salud y clínicas" desc="Agenda citas, automatiza facturación, resúmenes clínicos y apoya el triaje." />
              <SectorCard icon="solar:home-2-linear" title="Inmobiliaria / PropTech" desc="Publica propiedades, genera contratos de arrendamiento y automatiza valuaciones." />
              <SectorCard icon="solar:routing-2-linear" title="Logística" desc="Predice demanda, rastrea envíos, coordina proveedores y genera reportes." />
              <SectorCard icon="solar:leaf-linear" title="Agricultura" desc="Planifica cultivos, trámites de exportación y analiza datos climáticos offline." />
              <SectorCard icon="solar:card-linear" title="Fintech" desc="Procesa documentos de crédito, automatiza onboarding y analiza riesgo crediticio." />
              <SectorCard icon="solar:buildings-linear" title="Construcción" desc="Prepara licitaciones, documenta avance de obra y automatiza presupuestos de materiales." />
            </div>
          </div>
        </div>
      </section>

      {/* Comparativa */}
      <section className="w-full relative py-24 z-10 border-t border-white/30">
        <div className="max-w-5xl mx-auto px-4">
          <div className="text-center mb-16">
            <span className="text-xs font-semibold tracking-widest text-slate-600 uppercase mb-4 block font-sans">
              Comparativa
            </span>
            <h2 className="md:text-4xl text-3xl font-medium text-[#1A1A1A] tracking-tight font-nunito mb-6 drop-shadow-sm">
              AikaOS vs la competencia
            </h2>
            <p className="text-slate-700 font-medium max-w-2xl mx-auto">
              Existen otras herramientas agenticas, pero AikaOS está diseñado
              para brindarte privacidad, control y usabilidad nativa.
            </p>
          </div>

          <div className="overflow-x-auto bg-white/50 backdrop-blur-2xl rounded-[32px] border border-white/80 shadow-[0_20px_50px_-15px_rgba(0,0,0,0.05),inset_0_1px_0_rgba(255,255,255,0.9)] p-2">
            <table className="w-full text-left text-[14px] font-medium text-slate-700 font-sans min-w-[800px] border-collapse">
              <thead className="text-slate-900 font-nunito font-semibold text-base">
                <tr>
                  <th className="px-6 py-5 rounded-tl-[24px] w-1/4">
                    Criterio
                  </th>
                  <th className="px-6 py-5 w-1/4 bg-blue-100/50 backdrop-blur-md rounded-t-[20px] text-blue-900 border-x border-t border-blue-200/50">
                    AikaOS
                  </th>
                  <th className="px-6 py-5 w-1/4">OpenClaw</th>
                  <th className="px-6 py-5 rounded-tr-[24px] w-1/4">
                    Claude Cowork
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/40">
                <tr className="hover:bg-white/30 transition-colors">
                  <td className="px-6 py-5 font-semibold text-slate-900">
                    Precio
                  </td>
                  <td className="px-6 py-5 bg-blue-50/40 backdrop-blur-md text-slate-800 border-x border-blue-100/30">
                    Desde $20 USD/mes. Incluye la app, actualizaciones y soporte.
                    Sin costos ocultos.
                  </td>
                  <td className="px-6 py-5">
                    Software gratuito, pero requiere Claude Max ($100-200/mes).
                    Configuración por tu cuenta.
                  </td>
                  <td className="px-6 py-5">
                    $20/mes (Pro) a $200/mes (Max 20x). Pago obligatorio para
                    funciones agenticas.
                  </td>
                </tr>
                <tr className="hover:bg-white/30 transition-colors">
                  <td className="px-6 py-5 font-semibold text-slate-900">
                    Privacidad de datos
                  </td>
                  <td className="px-6 py-5 bg-blue-50/40 backdrop-blur-md text-slate-800 border-x border-blue-100/30">
                    <strong className="text-green-700 bg-green-100/80 px-2 py-0.5 rounded-md mr-1 shadow-sm">
                      Total.
                    </strong>{" "}
                    Corre en tu máquina. Nada sale sin permiso.
                  </td>
                  <td className="px-6 py-5">
                    Parcial. Envía a APIs externas.
                  </td>
                  <td className="px-6 py-5">
                    Limitada. Procesado en servidores ajenos.
                  </td>
                </tr>
                <tr className="hover:bg-white/30 transition-colors">
                  <td className="px-6 py-5 font-semibold text-slate-900">
                    Interfaz
                  </td>
                  <td className="px-6 py-5 bg-blue-50/40 backdrop-blur-md text-slate-800 border-x border-blue-100/30">
                    App de escritorio nativa (GUI) moderna.
                  </td>
                  <td className="px-6 py-5">
                    Terminal, WhatsApp, Telegram.
                  </td>
                  <td className="px-6 py-5">
                    App web/escritorio, conexión constante.
                  </td>
                </tr>
                <tr className="hover:bg-white/30 transition-colors">
                  <td className="px-6 py-5 font-semibold text-slate-900">
                    Modelos de IA
                  </td>
                  <td className="px-6 py-5 bg-blue-50/40 backdrop-blur-md text-slate-800 border-x border-blue-100/30">
                    <strong>BYOM:</strong> Claude, GPT-4, Locales (Ollama).
                  </td>
                  <td className="px-6 py-5">
                    Recomienda Claude Max ($100+/m).
                  </td>
                  <td className="px-6 py-5">Solo Claude.</td>
                </tr>
                <tr className="hover:bg-white/30 transition-colors">
                  <td className="px-6 py-5 font-semibold text-slate-900">
                    Funciona offline
                  </td>
                  <td className="px-6 py-5 bg-blue-50/40 backdrop-blur-md text-slate-800 border-x border-blue-100/30">
                    <strong className="text-green-700 bg-green-100/80 px-2 py-0.5 rounded-md mr-1 shadow-sm">
                      Sí
                    </strong>
                    , usando modelos locales instalados.
                  </td>
                  <td className="px-6 py-5">
                    Parcial, necesita API externa.
                  </td>
                  <td className="px-6 py-5">
                    No. Requiere internet siempre.
                  </td>
                </tr>
                <tr className="hover:bg-white/30 transition-colors">
                  <td className="px-6 py-5 font-semibold text-slate-900">
                    Límites de uso
                  </td>
                  <td className="px-6 py-5 bg-blue-50/40 backdrop-blur-md text-slate-800 border-x border-blue-100/30">
                    Sin límites. Usa todo lo que necesites, cuando lo necesites.
                  </td>
                  <td className="px-6 py-5">
                    Sin límites propios, pero heredas los del modelo.
                  </td>
                  <td className="px-6 py-5">
                    Límites estrictos por ventanas de 5 horas.
                  </td>
                </tr>
                <tr className="hover:bg-white/30 transition-colors">
                  <td className="px-6 py-5 font-semibold text-slate-900">
                    Aprobación de acciones
                  </td>
                  <td className="px-6 py-5 bg-blue-50/40 backdrop-blur-md text-slate-800 border-x border-blue-100/30">
                    Sí. Ves un plan claro antes de cada acción.
                  </td>
                  <td className="px-6 py-5">
                    Limitada. Puede actuar sin permiso.
                  </td>
                  <td className="px-6 py-5">
                    Parcial. Pide permiso solo para eliminar archivos.
                  </td>
                </tr>
                <tr className="hover:bg-white/30 transition-colors">
                  <td className="px-6 py-5 font-semibold text-slate-900">
                    Seguridad
                  </td>
                  <td className="px-6 py-5 bg-blue-50/40 backdrop-blur-md text-slate-800 border-x border-blue-100/30">
                    Sistema cerrado y verificado. Sin skills de terceros no
                    auditados.
                  </td>
                  <td className="px-6 py-5">
                    Riesgoso. Fugas documentadas en skills.
                  </td>
                  <td className="px-6 py-5">
                    No usar para datos regulados.
                  </td>
                </tr>
                <tr className="hover:bg-white/30 transition-colors">
                  <td className="px-6 py-5 font-semibold text-slate-900">
                    Idioma
                  </td>
                  <td className="px-6 py-5 bg-blue-50/40 backdrop-blur-md text-slate-800 border-x border-blue-100/30">
                    Interfaz nativa en español. Expertos para LATAM (SAT, DIAN,
                    AFIP).
                  </td>
                  <td className="px-6 py-5">
                    Solo en inglés. Sin soporte para LATAM.
                  </td>
                  <td className="px-6 py-5">
                    Multiidioma en chat, interfaz en inglés.
                  </td>
                </tr>
                <tr className="hover:bg-white/30 transition-colors">
                  <td className="px-6 py-5 font-semibold text-slate-900">
                    Puesta en marcha
                  </td>
                  <td className="px-6 py-5 bg-blue-50/40 backdrop-blur-md text-slate-800 border-x border-blue-100/30">
                    Nosotros lo instalamos y configuramos. Listo para trabajar.
                  </td>
                  <td className="px-6 py-5">
                    Requiere Node 22+, CLI wizard, configuración avanzada.
                  </td>
                  <td className="px-6 py-5">
                    Descarga la app, inicia sesión con cuenta de pago.
                  </td>
                </tr>
                <tr className="hover:bg-white/30 transition-colors">
                  <td className="px-6 py-5 font-semibold text-slate-900">
                    Actualizaciones
                  </td>
                  <td className="px-6 py-5 bg-blue-50/40 backdrop-blur-md text-slate-800 border-x border-blue-100/30">
                    Incluidas en tu plan. Nuevos modelos e integraciones
                    automáticas.
                  </td>
                  <td className="px-6 py-5">
                    Comunitarias. Sin garantía de estabilidad.
                  </td>
                  <td className="px-6 py-5">
                    De Anthropic. No tienes control sobre qué cambia.
                  </td>
                </tr>
                <tr className="hover:bg-white/30 transition-colors">
                  <td className="px-6 py-5 font-semibold text-slate-900">
                    Servidores MCP
                  </td>
                  <td className="px-6 py-5 bg-blue-50/40 backdrop-blur-md text-slate-800 border-x border-blue-100/30">
                    Incluidos en Profesional+. En Enterprise, MCP a medida.
                  </td>
                  <td className="px-6 py-5">
                    3,000+ skills sin verificación de seguridad.
                  </td>
                  <td className="px-6 py-5">
                    Conectores limitados (Drive, Gmail). No puedes crear los
                    tuyos.
                  </td>
                </tr>
                <tr>
                  <td className="px-6 py-5 font-semibold text-slate-900 rounded-bl-[24px]">
                    Cumplimiento
                  </td>
                  <td className="px-6 py-5 bg-blue-100/50 backdrop-blur-md text-slate-800 border-x border-b border-blue-200/50 rounded-b-[20px]">
                    GDPR/LGPD automático. Ideal datos sensibles.
                  </td>
                  <td className="px-6 py-5">
                    Riesgoso. Fugas documentadas en skills.
                  </td>
                  <td className="px-6 py-5 rounded-br-[24px]">
                    No usar para datos regulados.
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          {/* En resumen callout box */}
          <div className="mt-8 bg-white/50 backdrop-blur-2xl rounded-[28px] border border-white/80 shadow-[0_15px_30px_rgba(0,0,0,0.04),inset_0_1px_0_rgba(255,255,255,0.9)] p-8">
            <h3 className="mb-4 text-lg font-semibold text-slate-900 font-nunito">
              En resumen: ¿por qué AikaOS?
            </h3>
            <ul className="space-y-3 text-[14px] leading-relaxed text-slate-700 font-medium">
              <li>
                <strong className="text-slate-900">vs OpenClaw:</strong> AikaOS
                tiene interfaz gráfica completa (no necesitas terminal ni
                WhatsApp), flujo de aprobación antes de cada acción, sistema
                cerrado y verificado (sin skills de terceros no auditados), y
                puesta en marcha profesional incluida.
              </li>
              <li>
                <strong className="text-slate-900">vs Claude Cowork:</strong>{" "}
                AikaOS funciona offline, no tiene límites de uso, tus datos
                nunca salen de tu máquina, puedes usar cualquier modelo de IA, y
                el precio incluye actualizaciones y soporte — no solo acceso a
                la herramienta.
              </li>
              <li>
                <strong className="text-slate-900">
                  Exclusivo de AikaOS:
                </strong>{" "}
                Interfaz nativa en español, expertos preconfigurados para
                industrias latinoamericanas, normativas locales integradas (SAT,
                DIAN, AFIP), desarrollo de servidores MCP a medida, e
                interconexión entre agentes para empresas.
              </li>
            </ul>
          </div>
        </div>
      </section>

      {/* Planes */}
      <section
        id="planes"
        className="w-full z-10 border-t border-white/30 pt-24 pb-20 relative before:absolute before:inset-0 before:bg-gradient-to-b before:from-transparent before:to-white/30 before:-z-10"
      >
        <div className="max-w-7xl mx-auto px-6">
          <div className="text-center max-w-3xl mx-auto mb-20 animate-fade-in">
            <span className="text-xs font-semibold tracking-widest text-slate-600 uppercase mb-5 block font-sans">
              Precios
            </span>
            <h2 className="md:text-[48px] leading-[1.1] text-4xl font-medium text-[#1A1A1A] tracking-tight font-nunito mb-6 drop-shadow-sm">
              Planes para LATAM
            </h2>
            <p className="text-[16px] leading-relaxed text-slate-700 font-medium font-sans max-w-xl mx-auto">
              Precios en USD. Todos los planes incluyen actualizaciones y
              soporte.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 items-start mb-20">
            {/* Personal */}
            <div className="bg-white/40 backdrop-blur-2xl rounded-[36px] p-8 shadow-[0_20px_40px_-15px_rgba(0,0,0,0.05),inset_0_1px_0_rgba(255,255,255,0.8)] border border-white/60 flex flex-col h-full hover:shadow-[0_30px_60px_-15px_rgba(0,0,0,0.1)] hover:-translate-y-2 transition-all duration-500">
              <h3 className="text-[19px] font-semibold text-slate-900 font-nunito mb-2 tracking-tight">
                Personal
              </h3>
              <div className="text-[40px] font-semibold font-nunito text-[#1A1A1A] tracking-tight mb-4">
                $20
                <span className="text-[15px] text-slate-600 font-medium ml-1">
                  /mes
                </span>
              </div>
              <p className="text-[14px] text-slate-700 font-medium mb-8 leading-relaxed">
                1 instalación para uso personal. La app base sin expertos
                preconfigurados. Ideal para explorar y configurar tus propios
                skills.
              </p>
              <ul className="space-y-3.5 mb-8 flex-1">
                <li className="flex items-start gap-2.5 text-[14px] font-medium text-slate-800">
                  {/* @ts-expect-error iconify-icon is a web component */}
                  <iconify-icon icon="solar:check-circle-linear" class="text-slate-900 mt-0.5 text-lg" />{" "}
                  App de escritorio (macOS)
                </li>
                <li className="flex items-start gap-2.5 text-[14px] font-medium text-slate-800">
                  {/* @ts-expect-error iconify-icon is a web component */}
                  <iconify-icon icon="solar:check-circle-linear" class="text-slate-900 mt-0.5 text-lg" />{" "}
                  Trae tu propio modelo (BYOM)
                </li>
                <li className="flex items-start gap-2.5 text-[14px] font-medium text-slate-800">
                  {/* @ts-expect-error iconify-icon is a web component */}
                  <iconify-icon icon="solar:check-circle-linear" class="text-slate-900 mt-0.5 text-lg" />{" "}
                  Actualizaciones incluidas
                </li>
                <li className="flex items-start gap-2.5 text-[14px] font-medium text-slate-800">
                  {/* @ts-expect-error iconify-icon is a web component */}
                  <iconify-icon icon="solar:check-circle-linear" class="text-slate-900 mt-0.5 text-lg" />{" "}
                  Soporte por documentación
                </li>
              </ul>
              <a href="#planes" className="w-full py-4 rounded-full bg-white/60 backdrop-blur-md border border-white shadow-sm text-slate-900 font-semibold text-[14px] hover:bg-white hover:shadow-md transition-all text-center block">
                Empezar
              </a>
            </div>

            {/* Profesional */}
            <div className="bg-gradient-to-b from-blue-50/80 to-white/60 backdrop-blur-2xl rounded-[36px] p-8 border border-white shadow-[0_30px_60px_-15px_rgba(37,99,235,0.15),inset_0_1px_0_rgba(255,255,255,0.9)] relative flex flex-col h-full lg:-mt-4 lg:mb-4 z-10 hover:-translate-y-2 transition-transform duration-500">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-[19px] font-semibold text-slate-900 font-nunito tracking-tight">
                  Profesional
                </h3>
                <span className="bg-blue-600 text-white text-[10px] font-bold px-2.5 py-1 rounded-full shadow-sm uppercase tracking-wider">
                  Más popular
                </span>
              </div>
              <div className="text-[40px] font-semibold font-nunito text-[#1A1A1A] tracking-tight mb-4">
                $50
                <span className="text-[15px] text-slate-600 font-medium ml-1">
                  /mes
                </span>
              </div>
              <p className="text-[14px] text-slate-700 font-medium mb-8 leading-relaxed">
                1 instalación. Todos los expertos y skills. Sistema listo para
                trabajar.
              </p>
              <ul className="space-y-3.5 mb-8 flex-1">
                <li className="flex items-start gap-2.5 text-[14px] font-medium text-slate-900">
                  {/* @ts-expect-error iconify-icon is a web component */}
                  <iconify-icon icon="solar:check-circle-linear" class="text-blue-600 mt-0.5 text-lg" />{" "}
                  Todo lo de Personal
                </li>
                <li className="flex items-start gap-2.5 text-[14px] font-semibold text-slate-900">
                  {/* @ts-expect-error iconify-icon is a web component */}
                  <iconify-icon icon="solar:check-circle-linear" class="text-blue-600 mt-0.5 text-lg" />{" "}
                  25 expertos preconfigurados
                </li>
                <li className="flex items-start gap-2.5 text-[14px] font-medium text-slate-900">
                  {/* @ts-expect-error iconify-icon is a web component */}
                  <iconify-icon icon="solar:check-circle-linear" class="text-blue-600 mt-0.5 text-lg" />{" "}
                  Todos los skills y comandos
                </li>
                <li className="flex items-start gap-2.5 text-[14px] font-medium text-slate-900">
                  {/* @ts-expect-error iconify-icon is a web component */}
                  <iconify-icon icon="solar:check-circle-linear" class="text-blue-600 mt-0.5 text-lg" />{" "}
                  Servidores MCP incluidos
                </li>
                <li className="flex items-start gap-2.5 text-[14px] font-medium text-slate-900">
                  {/* @ts-expect-error iconify-icon is a web component */}
                  <iconify-icon icon="solar:check-circle-linear" class="text-blue-600 mt-0.5 text-lg" />{" "}
                  Puesta en marcha asistida
                </li>
              </ul>
              <a href="#planes" className="w-full py-4 rounded-full bg-slate-900 text-white font-semibold text-[14px] hover:bg-black shadow-[0_10px_20px_rgba(0,0,0,0.15)] hover:shadow-[0_15px_30px_rgba(0,0,0,0.25)] hover:-translate-y-0.5 transition-all border border-white/10 text-center block">
                Empezar
              </a>
            </div>

            {/* Business */}
            <div className="bg-white/40 backdrop-blur-2xl rounded-[36px] p-8 shadow-[0_20px_40px_-15px_rgba(0,0,0,0.05),inset_0_1px_0_rgba(255,255,255,0.8)] border border-white/60 flex flex-col h-full hover:shadow-[0_30px_60px_-15px_rgba(0,0,0,0.1)] hover:-translate-y-2 transition-all duration-500">
              <h3 className="text-[19px] font-semibold text-slate-900 font-nunito mb-2 tracking-tight">
                Business
              </h3>
              <div className="text-[40px] font-semibold font-nunito text-[#1A1A1A] tracking-tight mb-4">
                $150
                <span className="text-[15px] text-slate-600 font-medium ml-1">
                  /mes
                </span>
              </div>
              <p className="text-[14px] text-slate-700 font-medium mb-8 leading-relaxed">
                Hasta 5 instalaciones. Interconexión y asistencia de modelo.
              </p>
              <ul className="space-y-3.5 mb-8 flex-1">
                <li className="flex items-start gap-2.5 text-[14px] font-medium text-slate-800">
                  {/* @ts-expect-error iconify-icon is a web component */}
                  <iconify-icon icon="solar:check-circle-linear" class="text-slate-900 mt-0.5 text-lg" />{" "}
                  Todo lo de Profesional
                </li>
                <li className="flex items-start gap-2.5 text-[14px] font-medium text-slate-800">
                  {/* @ts-expect-error iconify-icon is a web component */}
                  <iconify-icon icon="solar:check-circle-linear" class="text-slate-900 mt-0.5 text-lg" />{" "}
                  Hasta 5 instalaciones
                </li>
                <li className="flex items-start gap-2.5 text-[14px] font-semibold text-slate-900">
                  {/* @ts-expect-error iconify-icon is a web component */}
                  <iconify-icon icon="solar:check-circle-linear" class="text-slate-900 mt-0.5 text-lg" />{" "}
                  + 5 expertos premium
                </li>
                <li className="flex items-start gap-2.5 text-[14px] font-medium text-slate-800">
                  {/* @ts-expect-error iconify-icon is a web component */}
                  <iconify-icon icon="solar:check-circle-linear" class="text-slate-900 mt-0.5 text-lg" />{" "}
                  Interconexión entre agentes vía MCP
                </li>
                <li className="flex items-start gap-2.5 text-[14px] font-medium text-slate-800">
                  {/* @ts-expect-error iconify-icon is a web component */}
                  <iconify-icon icon="solar:check-circle-linear" class="text-slate-900 mt-0.5 text-lg" />{" "}
                  Asistencia integración modelo
                </li>
                <li className="flex items-start gap-2.5 text-[14px] font-medium text-slate-800">
                  {/* @ts-expect-error iconify-icon is a web component */}
                  <iconify-icon icon="solar:check-circle-linear" class="text-slate-900 mt-0.5 text-lg" />{" "}
                  Soporte prioritario
                </li>
                <li className="flex items-start gap-2.5 text-[14px] font-medium text-slate-800">
                  {/* @ts-expect-error iconify-icon is a web component */}
                  <iconify-icon icon="solar:check-circle-linear" class="text-slate-900 mt-0.5 text-lg" />{" "}
                  Actualizaciones con prioridad
                </li>
              </ul>
              <a href="#planes" className="w-full py-4 rounded-full bg-white/60 backdrop-blur-md border border-white shadow-sm text-slate-900 font-semibold text-[14px] hover:bg-white hover:shadow-md transition-all text-center block">
                Contactar ventas
              </a>
            </div>

            {/* Enterprise */}
            <div className="bg-white/40 backdrop-blur-2xl rounded-[36px] p-8 shadow-[0_20px_40px_-15px_rgba(0,0,0,0.05),inset_0_1px_0_rgba(255,255,255,0.8)] border border-white/60 flex flex-col h-full hover:shadow-[0_30px_60px_-15px_rgba(0,0,0,0.1)] hover:-translate-y-2 transition-all duration-500">
              <h3 className="text-[19px] font-semibold text-slate-900 font-nunito mb-2 tracking-tight">
                Enterprise
              </h3>
              <div className="text-[40px] font-semibold font-nunito text-[#1A1A1A] tracking-tight mb-4">
                $500
                <span className="text-[15px] text-slate-600 font-medium ml-1">
                  /mes
                </span>
              </div>
              <p className="text-[14px] text-slate-700 font-medium mb-8 leading-relaxed">
                10+ instalaciones. Desarrollo MCP a medida y arquitectura
                custom.
              </p>
              <ul className="space-y-3.5 mb-8 flex-1">
                <li className="flex items-start gap-2.5 text-[14px] font-medium text-slate-800">
                  {/* @ts-expect-error iconify-icon is a web component */}
                  <iconify-icon icon="solar:check-circle-linear" class="text-slate-900 mt-0.5 text-lg" />{" "}
                  Todo lo de Business
                </li>
                <li className="flex items-start gap-2.5 text-[14px] font-semibold text-slate-900">
                  {/* @ts-expect-error iconify-icon is a web component */}
                  <iconify-icon icon="solar:check-circle-linear" class="text-slate-900 mt-0.5 text-lg" />{" "}
                  Instalaciones ilimitadas
                </li>
                <li className="flex items-start gap-2.5 text-[14px] font-medium text-slate-800">
                  {/* @ts-expect-error iconify-icon is a web component */}
                  <iconify-icon icon="solar:check-circle-linear" class="text-slate-900 mt-0.5 text-lg" />{" "}
                  Servidores MCP custom
                </li>
                <li className="flex items-start gap-2.5 text-[14px] font-medium text-slate-800">
                  {/* @ts-expect-error iconify-icon is a web component */}
                  <iconify-icon icon="solar:check-circle-linear" class="text-slate-900 mt-0.5 text-lg" />{" "}
                  Integración completa de modelo en tu infra
                </li>
                <li className="flex items-start gap-2.5 text-[14px] font-medium text-slate-800">
                  {/* @ts-expect-error iconify-icon is a web component */}
                  <iconify-icon icon="solar:check-circle-linear" class="text-slate-900 mt-0.5 text-lg" />{" "}
                  Acceso anticipado a nuevas funciones
                </li>
                <li className="flex items-start gap-2.5 text-[14px] font-medium text-slate-800">
                  {/* @ts-expect-error iconify-icon is a web component */}
                  <iconify-icon icon="solar:check-circle-linear" class="text-slate-900 mt-0.5 text-lg" />{" "}
                  Soporte dedicado + videollamada
                </li>
                <li className="flex items-start gap-2.5 text-[14px] font-medium text-slate-800">
                  {/* @ts-expect-error iconify-icon is a web component */}
                  <iconify-icon icon="solar:check-circle-linear" class="text-slate-900 mt-0.5 text-lg" />{" "}
                  Arquitectura personalizada
                </li>
              </ul>
              <a href="#planes" className="w-full py-4 rounded-full bg-white/60 backdrop-blur-md border border-white shadow-sm text-slate-900 font-semibold text-[14px] hover:bg-white hover:shadow-md transition-all text-center block">
                Hablar con ventas
              </a>
            </div>
          </div>
        </div>
      </section>

      {/* FAQ Section */}
      <section
        id="faq"
        className="w-full z-10 border-t border-white/30 py-24 relative bg-white/30 backdrop-blur-3xl"
      >
        <div className="max-w-3xl mx-auto px-6">
          <div className="text-center mb-16">
            <h2 className="md:text-4xl text-3xl font-medium text-[#1A1A1A] tracking-tight font-nunito mb-4 drop-shadow-sm">
              Preguntas frecuentes
            </h2>
          </div>

          <div className="space-y-6">
            <div className="border-b border-white/60 pb-6">
              <h4 className="font-semibold text-slate-900 mb-2 font-nunito text-lg">
                ¿Qué diferencia hay entre AikaOS y un chatbot normal?
              </h4>
              <p className="text-[15px] font-medium text-slate-700 leading-relaxed">
                Un chatbot te da respuestas de texto. AikaOS puede ejecutar
                acciones reales: crear archivos, editar documentos, navegar la
                web y correr comandos en tu máquina — siempre con tu aprobación.
              </p>
            </div>
            <div className="border-b border-white/60 pb-6">
              <h4 className="font-semibold text-slate-900 mb-2 font-nunito text-lg">
                ¿Necesito comprar un modelo de IA aparte?
              </h4>
              <p className="text-[15px] font-medium text-slate-700 leading-relaxed">
                AikaOS funciona con el modelo que tú elijas (BYOM). Puedes usar
                tu API key, modelos locales gratuitos con Ollama, o una
                suscripción de OpenCode. En planes superiores te ayudamos a
                integrarlo.
              </p>
            </div>
            <div className="border-b border-white/60 pb-6">
              <h4 className="font-semibold text-slate-900 mb-2 font-nunito text-lg">
                ¿Solo funciona en Mac?
              </h4>
              <p className="text-[15px] font-medium text-slate-700 leading-relaxed">
                Actualmente está optimizado para macOS con procesadores Apple
                Silicon (M1 a M4). Versiones para Windows y Linux están en
                desarrollo.
              </p>
            </div>
            <div className="border-b border-white/60 pb-6">
              <h4 className="font-semibold text-slate-900 mb-2 font-nunito text-lg">
                ¿Mis datos están seguros?
              </h4>
              <p className="text-[15px] font-medium text-slate-700 leading-relaxed">
                AikaOS corre localmente en tu computadora. No accede a archivos
                ni ejecuta comandos sin tu permiso. Tus datos nunca pasan por
                servidores de terceros. Es un sistema cerrado y verificado.
              </p>
            </div>
            {/* Missing FAQ questions from original */}
            <div className="border-b border-white/60 pb-6">
              <h4 className="font-semibold text-slate-900 mb-2 font-nunito text-lg">
                ¿Funciona con normativas de mi país?
              </h4>
              <p className="text-[15px] font-medium text-slate-700 leading-relaxed">
                Los expertos preconfigurados incluyen conocimiento de normativas
                locales (SAT en México, DIAN en Colombia, AFIP en Argentina).
                Puedes personalizar los skills para tu jurisdicción específica.
              </p>
            </div>
            <div className="border-b border-white/60 pb-6">
              <h4 className="font-semibold text-slate-900 mb-2 font-nunito text-lg">
                ¿Qué incluyen las actualizaciones?
              </h4>
              <p className="text-[15px] font-medium text-slate-700 leading-relaxed">
                Todos los planes incluyen actualizaciones con nuevos modelos
                compatibles, nuevas integraciones, mejoras de rendimiento y
                nuevos skills. En planes Enterprise, también desarrollamos
                funcionalidades a medida para tu empresa.
              </p>
            </div>
            <div className="border-b border-white/60 pb-6">
              <h4 className="font-semibold text-slate-900 mb-2 font-nunito text-lg">
                ¿Qué son los servidores MCP?
              </h4>
              <p className="text-[15px] font-medium text-slate-700 leading-relaxed">
                MCP (Model Context Protocol) permite que AikaOS se conecte con
                herramientas externas: navegadores, bases de datos, APIs, CRMs y
                más. En el plan Enterprise, desarrollamos servidores MCP
                personalizados que conectan AikaOS con los sistemas específicos
                de tu empresa.
              </p>
            </div>
            <div className="pb-6">
              <h4 className="font-semibold text-slate-900 mb-2 font-nunito text-lg">
                ¿En qué se diferencia de OpenClaw o Claude Cowork?
              </h4>
              <p className="text-[15px] font-medium text-slate-700 leading-relaxed">
                AikaOS es un sistema cerrado y verificado con interfaz gráfica
                completa, a diferencia de OpenClaw que requiere terminal y tiene
                problemas de seguridad documentados. A diferencia de Claude
                Cowork, AikaOS funciona offline, no tiene límites de uso, tus
                datos nunca salen de tu máquina, y puedes usar cualquier modelo
                de IA. Además, es el único con interfaz nativa en español y
                expertos para Latinoamérica.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* CTA final */}
      <section className="w-full z-10 py-24 relative">
        <div className="max-w-3xl mx-auto px-6 text-center">
          <h2 className="md:text-4xl text-3xl font-medium text-[#1A1A1A] tracking-tight font-nunito mb-6 drop-shadow-sm">
            Empieza a automatizar tu empresa
          </h2>
          <p className="text-[16px] leading-relaxed text-slate-700 font-medium font-sans max-w-xl mx-auto mb-10">
            Elige el plan que mejor se adapte a tu empresa y empieza a
            automatizar los flujos de trabajo de tu industria.
          </p>
          <div className="flex items-center justify-center">
            <a
              href="#planes"
              className="text-[17px] hover:bg-black transition-all hover:shadow-[0_15px_30px_rgba(0,0,0,0.2)] hover:-translate-y-0.5 sm:w-auto font-normal text-white bg-[#1A1A1A] w-full rounded-full pt-3.5 pr-8 pb-3.5 pl-8 shadow-[0_10px_20px_rgba(0,0,0,0.15)] border border-white/10 text-center"
            >
              Ver planes desde $20/mes
            </a>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="w-full z-10 border-t border-white/30 relative">
        <div className="max-w-7xl mx-auto px-6 py-16">
          <div className="flex flex-col md:flex-row items-start justify-between gap-12 mb-12">
            {/* Logo + tagline */}
            <div className="flex flex-col gap-3 max-w-xs">
              <div className="flex items-center gap-2">
                <span className="font-mono text-xl font-bold text-aika-teal">{">_"}</span>
                <span className="text-xl font-semibold text-slate-900 tracking-tight font-nunito">
                  AikaOS
                </span>
              </div>
              <p className="text-sm text-slate-600 font-medium leading-relaxed">
                Tu equipo de IA privado, listo para trabajar. Por{" "}
                <strong className="text-slate-800">AikaLabs</strong>.
              </p>
            </div>

            {/* Nav links */}
            <div className="flex flex-wrap gap-x-12 gap-y-6 text-[14px] font-medium text-slate-700">
              <div className="flex flex-col gap-3">
                <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
                  Producto
                </span>
                <a href="#como-funciona" className="hover:text-black transition-colors">
                  Cómo funciona
                </a>
                <a href="#por-que-local" className="hover:text-black transition-colors">
                  Por qué local
                </a>
                <a href="#sectores" className="hover:text-black transition-colors">
                  Sectores
                </a>
              </div>
              <div className="flex flex-col gap-3">
                <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
                  Precios
                </span>
                <a href="#planes" className="hover:text-black transition-colors">
                  Planes
                </a>
              </div>
              <div className="flex flex-col gap-3">
                <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
                  Soporte
                </span>
                <a href="#faq" className="hover:text-black transition-colors">
                  FAQ
                </a>
                <a href="/terms" className="hover:text-black transition-colors">
                  Términos
                </a>
                <a href="/privacy" className="hover:text-black transition-colors">
                  Privacidad
                </a>
              </div>
            </div>
          </div>

          {/* Bottom bar */}
          <div className="border-t border-white/40 pt-8 flex flex-col sm:flex-row items-center justify-between gap-4">
            <p className="text-sm text-slate-500 font-medium">
              &copy; 2026 AikaLabs. Todos los derechos reservados.
            </p>
            <a
              href="#planes"
              className="text-sm font-semibold text-slate-700 hover:text-black transition-colors"
            >
              Ver planes &rarr;
            </a>
          </div>
        </div>
      </footer>
    </>
  );
}

/* ── Integration badge for the MCP marquee ── */
function IntegrationBadge({ icon, label }: { icon: string; label: string }) {
  return (
    <div className="flex flex-col items-center gap-2 shrink-0 group cursor-default">
      <div className="w-14 h-14 rounded-2xl bg-white/70 backdrop-blur-md border border-white shadow-[0_4px_12px_rgba(0,0,0,0.04)] flex items-center justify-center group-hover:scale-110 group-hover:-translate-y-1 transition-all duration-300">
        {/* @ts-expect-error iconify-icon is a web component */}
        <iconify-icon icon={icon} class="text-2xl text-slate-700" />
      </div>
      <span className="text-[11px] font-semibold text-slate-600 whitespace-nowrap">
        {label}
      </span>
    </div>
  );
}

/* ── Expert tag component for the 25 experts grid ── */
function ExpertTag({ icon, label }: { icon: string; label: string }) {
  return (
    <div className="bg-white/60 backdrop-blur-md px-3 py-2.5 rounded-xl border border-white shadow-[0_2px_10px_rgba(0,0,0,0.02)] text-[13px] font-semibold text-slate-800 flex items-center gap-2 transition-transform hover:scale-[1.02]">
      {/* @ts-expect-error iconify-icon is a web component */}
      <iconify-icon icon={icon} class="text-lg text-slate-600 shrink-0" />
      <span className="truncate">{label}</span>
    </div>
  );
}

/* ── Sector carousel card component ── */
function SectorCard({
  icon,
  title,
  desc,
}: {
  icon: string;
  title: string;
  desc: string;
}) {
  return (
    <div className="w-[320px] bg-white/50 backdrop-blur-2xl p-8 rounded-[32px] shadow-[0_15px_40px_-10px_rgba(0,0,0,0.08),inset_0_1px_0_rgba(255,255,255,0.9)] border border-white/80 hover:-translate-y-2 transition-transform duration-500 cursor-default group">
      <div className="w-14 h-14 rounded-[16px] bg-gradient-to-b from-white to-white/60 border border-white shadow-[0_8px_16px_rgba(0,0,0,0.06),inset_0_-3px_6px_rgba(0,0,0,0.02)] flex items-center justify-center text-2xl text-slate-800 mb-6 group-hover:scale-110 transition-transform duration-500">
        {/* @ts-expect-error iconify-icon is a web component */}
        <iconify-icon icon={icon} />
      </div>
      <div className="text-[19px] font-semibold text-slate-900 font-nunito mb-3 tracking-tight">
        {title}
      </div>
      <p className="text-[14px] font-medium text-slate-700 leading-relaxed font-sans">
        {desc}
      </p>
    </div>
  );
}

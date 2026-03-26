"use client";

type DenHeroProps = {
  getStartedHref: string;
};

export function DenHero(props: DenHeroProps) {
  const getStartedExternal = /^https?:\/\//.test(props.getStartedHref);

  return (
    <section className="pt-8 md:pt-14">
      <div className="max-w-[42rem]">
        <h2 className="max-w-[12.4ch] text-3xl font-medium tracking-tight text-gray-900 md:max-w-[12.1ch] md:text-[3.2rem] md:leading-[0.98] lg:max-w-none lg:text-[3.35rem] xl:text-[3.7rem]">
          <span className="block lg:whitespace-nowrap">Agents that never sleep</span>
        </h2>
        <p className="mt-5 max-w-[35rem] text-lg leading-relaxed text-gray-700 md:text-[1rem] md:leading-8 lg:text-[1.02rem]">
          Cloud gives you a personal cloud workspace for long-running tasks, background automation, and the same agent workflows you already use locally in OpenWork, without keeping your own machine awake.
        </p>

        <div className="mt-8 flex flex-col items-start gap-4 sm:flex-row sm:items-center sm:gap-5">
          <a
            href={props.getStartedHref}
            className="doc-button min-w-[290px] justify-center px-8 text-[1.08rem] font-semibold"
            rel={getStartedExternal ? "noreferrer" : undefined}
            target={getStartedExternal ? "_blank" : undefined}
          >
            Get started
          </a>
          <div className="flex flex-col text-[0.98rem] text-gray-500 sm:max-w-[14rem]">
            <span className="font-semibold text-gray-700">$50/mo per worker</span>
            <span>Free for a limited time</span>
          </div>
        </div>
      </div>
    </section>
  );
}

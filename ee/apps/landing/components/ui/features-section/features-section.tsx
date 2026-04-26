import Eyebrow from "../eyebrow";
import FeatureActions from "./feature-actions";
import FeatureChat from "./feature-chat";
import FeatureDirectExecution from "./feature-direct-execution";
import FeatureIntegrations from "./feature-integrations";
import FeatureOrchestration from "./feature-orchestration";
import FeatureSecurity from "./feature-security";
import LogoSymbolIcon from "@/icons/logos/logo-symbol";

const FeaturesSection = () => {
  return (
    <section className="grid-12 gap-xl px-(--container-px) sm:gap-y-[4.8rem]">
      <div className="gap-base sm:gap-xl col-span-12 flex flex-col items-center sm:col-span-8 sm:col-start-3 md:col-span-5 md:col-start-1 md:items-start">
        <Eyebrow>What you get</Eyebrow>
        <h2 data-split="heading" className="h2 text-center md:text-left">
          Six primitives. <span className="h2-serif">Infinite agents.</span> Zero lock-in.
        </h2>
      </div>
      <div data-reveal-group className="col-start-12 self-end justify-self-end">
        <LogoSymbolIcon className="hidden w-[7rem] md:block" />
      </div>
      <div className="text-primary grid-12 gap-y-base col-span-12">
        <div
          data-reveal-group
          className="gap-base col-span-12 flex flex-col sm:col-span-6 sm:col-start-4 md:col-span-12 md:col-start-1 md:grid md:grid-cols-12"
        >
          <div data-cursor="accent" className="col-span-4 aspect-[0.8]">
            <FeatureDirectExecution />
          </div>
          <div data-cursor="accent" className="col-span-8 aspect-[0.8] md:aspect-auto">
            <FeatureIntegrations />
          </div>
        </div>
        <div
          data-reveal-group
          className="gap-base col-span-12 flex flex-col sm:col-span-6 sm:col-start-4 md:col-span-12 md:col-start-1 md:grid md:grid-cols-12"
        >
          <div data-cursor="accent" className="col-span-8 aspect-[0.8] md:aspect-auto">
            <FeatureOrchestration />
          </div>
          <div data-cursor="accent" className="col-span-4 aspect-[0.8]">
            <FeatureSecurity />
          </div>
        </div>
        <div
          data-reveal-group
          className="gap-base col-span-12 flex flex-col sm:col-span-6 sm:col-start-4 md:col-span-12 md:col-start-1 md:grid md:grid-cols-12"
        >
          <div data-cursor="accent" className="col-span-4 aspect-[0.8]">
            <FeatureChat />
          </div>
          <div data-cursor="accent" className="col-span-8 aspect-[0.8] md:aspect-auto">
            <FeatureActions />
          </div>
        </div>
      </div>
    </section>
  );
};

export default FeaturesSection;

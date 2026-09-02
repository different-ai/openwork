import { Cloud } from "~/sections/cloud";
import { Hero, Nav } from "~/sections/hero";
import { Footer, GetStarted, Platform } from "~/sections/platform";
import { HowItWorks, Memory, NeedsYou, Responsibilities } from "~/sections/product";

export default function App() {
  return (
    <>
      <div className="site-backdrop" aria-hidden="true" />
      <Nav />
      <main>
        <Hero />
        <HowItWorks />
        <Memory />
        <NeedsYou />
        <Responsibilities />
        <Cloud />
        <Platform />
        <GetStarted />
      </main>
      <Footer />
    </>
  );
}

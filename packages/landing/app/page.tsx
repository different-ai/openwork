import { LandingHome } from "../components/landing-home";
import { getGithubData } from "../lib/github";

export default async function Home() {
  const github = await getGithubData();
  const cal = process.env.NEXT_PUBLIC_CAL_URL || "/enterprise#book";

  return (
    <LandingHome
      stars={github.stars}
      downloadHref={github.downloads.macos}
      callHref={cal}
    />
  );
}

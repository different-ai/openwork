function formatCompact(value: number): string {
  try {
    return new Intl.NumberFormat("en", {
      notation: "compact",
      maximumFractionDigits: 1,
    }).format(value);
  } catch {
    return String(value);
  }
}

export async function getGithubStars(): Promise<string> {
  try {
    const response = await fetch("https://api.github.com/repos/different-ai/openwork", {
      headers: {
        Accept: "application/vnd.github+json",
      },
      next: {
        revalidate: 3600,
      },
    });

    if (!response.ok) {
      return "";
    }

    const repo = await response.json();
    if (typeof repo?.stargazers_count === "number") {
      return formatCompact(repo.stargazers_count);
    }
  } catch {
    return "";
  }

  return "";
}

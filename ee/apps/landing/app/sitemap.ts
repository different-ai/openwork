import type { MetadataRoute } from "next";

const BASE_URL = "https://openworklabs.com";

const paths: { path: string; priority: number }[] = [
  { path: "/", priority: 1 },
  { path: "/download", priority: 0.7 },
  { path: "/enterprise", priority: 0.7 },
  { path: "/pricing", priority: 0.7 },
  { path: "/trust", priority: 0.7 },
  { path: "/docs", priority: 0.7 },
  { path: "/privacy", priority: 0.3 },
  { path: "/terms", priority: 0.3 },
];

export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date();
  return paths.map(({ path, priority }) => ({
    url: `${BASE_URL}${path}`,
    lastModified,
    changeFrequency: "weekly",
    priority,
  }));
}

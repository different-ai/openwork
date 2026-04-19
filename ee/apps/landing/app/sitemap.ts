import type { MetadataRoute } from "next";

const BASE_URL = "https://openworklabs.com";

const paths = [
  "/",
  "/den",
  "/download",
  "/enterprise",
  "/pricing",
  "/feedback",
  "/privacy",
  "/terms",
  "/trust",
  "/docs",
];

export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date();
  return paths.map((path) => ({
    url: `${BASE_URL}${path}`,
    lastModified,
    changeFrequency: "weekly",
    priority: path === "/" ? 1 : 0.7,
  }));
}

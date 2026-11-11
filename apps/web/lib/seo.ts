import type { Metadata, MetadataRoute } from "next";

/**
 * Everything search and social need in one place: the canonical site URL, one title and
 * description per page, the sitemap and robots entries, and the JSON-LD blocks. The layout
 * and each page re-export these, so test/seo.test.ts can check the tags without booting Next.
 */

/** The public site. Canonical URLs always use this bare domain, never www. */
export const SITE_URL = "https://explanimate.co";

/** The share image: a 1200x630 PNG in public/, drawn by apps/web/scripts/gen-og-image.mjs. */
const OG_IMAGE = {
  url: "/og.png",
  width: 1200,
  height: 630,
  alt: "Explanimate: whiteboard explainers from any repo, post, article or topic",
};

export type PageKey = "home" | "docs" | "gallery" | "privacy" | "terms" | "pricing" | "changelog";

export const PAGES: Record<PageKey, { title: string; description: string; path: string }> = {
  home: {
    title: "Explanimate: whiteboard explainers from any repo, post, article or topic",
    description:
      "Paste a GitHub repo, X post, article or topic. Get a whiteboard explainer video and an editable board that opens in tldraw.com. Powered by Meta Muse models.",
    path: "/",
  },
  docs: {
    title: "Docs · Explanimate",
    description:
      "Connect the Explanimate MCP server to your coding tool once, then ask for a whiteboard explainer video from inside your editor.",
    path: "/docs",
  },
  gallery: {
    title: "Examples · Explanimate",
    description:
      "Example whiteboard explainer videos made with Explanimate, from repos, posts, articles and topics. Each runs about 85 to 175 seconds at 1080p.",
    path: "/gallery",
  },
  privacy: {
    title: "Privacy · Explanimate",
    description: "What Explanimate stores about you, what it sends to AI and voice providers to make a video, and how to ask for deletion.",
    path: "/privacy",
  },
  terms: {
    title: "Terms · Explanimate",
    description: "The short terms for using Explanimate: a free hackathon project, offered as is, with daily limits and no abuse.",
    path: "/terms",
  },
  pricing: {
    title: "Pricing · Explanimate",
    description: "Explanimate is free to try: browse for free, sign in to make 3 videos a day, or run the MIT-licensed code yourself.",
    path: "/pricing",
  },
  changelog: {
    title: "Changelog · Explanimate",
    description: "What shipped in Explanimate since the first commit on October 31, 2026.",
    path: "/changelog",
  },
};

// the home page is the bare domain: Next strips a trailing slash when it renders the tags,
// so the helpers emit it bare to stay byte-identical with the sitemap and the head
const pageUrl = (key: PageKey) => (PAGES[key].path === "/" ? SITE_URL : `${SITE_URL}${PAGES[key].path}`);

/** The full head for a page: title, description, canonical, Open Graph and Twitter card. */
export function pageMetadata(key: PageKey): Metadata {
  const page = PAGES[key];
  const url = pageUrl(key);
  const images = [{ url: OG_IMAGE.url, width: OG_IMAGE.width, height: OG_IMAGE.height, alt: OG_IMAGE.alt }];
  return {
    title: page.title,
    description: page.description,
    alternates: { canonical: url },
    openGraph: { title: page.title, description: page.description, url, siteName: "Explanimate", type: "website", images },
    twitter: { card: "summary_large_image", title: page.title, description: page.description, images: [OG_IMAGE.url] },
  };
}

export interface JobSummary {
  id: string;
  title?: string;
  input: string;
}

const clean = (s: string) => s.replace(/\s+/g, " ").trim();
const cut = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`);

/**
 * A shared result link (/?job=<id>) reads as its own page — its own title, description, canonical
 * and unfurl — but stays out of search: jobs are transient and unbounded.
 */
export function jobPageMetadata(job: JobSummary): Metadata {
  const name = clean(job.title || job.input || "whiteboard explainer");
  const title = `${cut(name, 60)} · Explanimate`;
  const description = cut(
    `Whiteboard explainer video: ${name}. Made with Explanimate. Watch it, tap the board to ask about any part, and download the editable boards.`,
    200,
  );
  const url = `${SITE_URL}/?job=${encodeURIComponent(job.id)}`;
  const images = [{ url: OG_IMAGE.url, width: OG_IMAGE.width, height: OG_IMAGE.height, alt: OG_IMAGE.alt }];
  return {
    title,
    description,
    alternates: { canonical: url },
    robots: { index: false, follow: true },
    openGraph: { title, description, url, siteName: "Explanimate", type: "website", images },
    twitter: { card: "summary_large_image", title, description, images: [OG_IMAGE.url] },
  };
}

/**
 * The public pages. Gallery entries are in-page players and jobs are transient ?job= views,
 * so neither has a stable public URL worth listing; /api/* is data, never content.
 */
export function sitemapEntries(): MetadataRoute.Sitemap {
  return [
    { url: pageUrl("home"), changeFrequency: "weekly", priority: 1 },
    { url: pageUrl("gallery"), changeFrequency: "weekly", priority: 0.7 },
    { url: pageUrl("docs"), changeFrequency: "monthly", priority: 0.8 },
    { url: pageUrl("privacy"), changeFrequency: "monthly", priority: 0.5 },
    { url: pageUrl("terms"), changeFrequency: "monthly", priority: 0.5 },
    { url: pageUrl("pricing"), changeFrequency: "monthly", priority: 0.6 },
    { url: pageUrl("changelog"), changeFrequency: "weekly", priority: 0.5 },
  ];
}

/** Crawlers may read the pages; the JSON API, the dashboard and sign-in are not content. Unlisted routes stay unlisted. */
export function robotsConfig(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: "/", disallow: ["/api/", "/app", "/signin"] },
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}

/** Who runs the site. Plain text only: no logos, no third-party marks. */
export function organizationJsonLd() {
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: "Explanimate",
    url: SITE_URL,
    sameAs: ["https://github.com/slubbles/explanimate"],
  };
}

/** The site itself, read on every page. */
export function websiteJsonLd() {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: "Explanimate",
    url: SITE_URL,
  };
}

/** The app, read on the landing page. */
export function appJsonLd() {
  return {
    "@context": "https://schema.org",
    "@type": "WebApplication",
    name: "Explanimate",
    url: SITE_URL,
    description: PAGES.home.description,
    applicationCategory: "MultimediaApplication",
    operatingSystem: "Web",
    browserRequirements: "Requires JavaScript",
  };
}

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The recorded sample manifests are read from disk at request time, so they
  // must be traced into the server bundle for deployed builds.
  outputFileTracingIncludes: {
    "/api/analyze": ["./fixtures/samples/**/*"],
  },
  // The reference guide is a standalone static page; serve it without its
  // extension so the URL reads like the rest of the site.
  async rewrites() {
    return [
      { source: "/guide", destination: "/guide.html" },
      { source: "/streaming", destination: "/streaming.html" },
      { source: "/notes/fifty-five-alerts", destination: "/notes/fifty-five-alerts.html" },
    ];
  },
};

export default nextConfig;

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The recorded sample manifests are read from disk at request time, so they
  // must be traced into the server bundle for deployed builds.
  outputFileTracingIncludes: {
    "/api/analyze": ["./fixtures/samples/**/*"],
  },
};

export default nextConfig;

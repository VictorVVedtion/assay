import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Next 16 decoupled ESLint from `next build` entirely (the `eslint` config key
  // and `next lint` were removed; ESLint now runs only via the standalone
  // `eslint .` CLI). So lint can never block the integrate build by design —
  // the brief's "don't let lint block the build" requirement is already met.
  //
  // TypeScript type-checking stays ON: the frozen interfaces in lib/ are the
  // contract the feature agents code against, and a type error there SHOULD
  // fail the build.
  typescript: {
    ignoreBuildErrors: false,
  },
};

export default nextConfig;

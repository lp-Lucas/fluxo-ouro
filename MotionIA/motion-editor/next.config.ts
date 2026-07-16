import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ['remotion', '@remotion/player', '@remotion/bundler'],
};

export default nextConfig;

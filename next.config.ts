import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Let a second laptop on the same network open the dev server by IP (officer terminal demo).
  allowedDevOrigins: ["192.168.*.*", "10.**", "172.*.*.*", "*.local"],
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;

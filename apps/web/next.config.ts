import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* Sprint 11: Build config pour la production et Docker */
  output: "standalone",
  compiler: {
    // Garder console.error / console.warn : ce sont les seuls logs serveur visibles sur Vercel.
    removeConsole: process.env.NODE_ENV === "production" ? { exclude: ["error", "warn"] } : false,
  },
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "cdn.discordapp.com",
      },
    ],
  }
};

export default nextConfig;

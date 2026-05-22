import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Vercel handles its own output, standalone is for Docker/VPS
  // output: "standalone", // Uncomment for Docker/VPS deployment

  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,

  // Vercel serverless functions config
  experimental: {
    // Prisma adapter needs Node.js runtime
  },
};

export default nextConfig;

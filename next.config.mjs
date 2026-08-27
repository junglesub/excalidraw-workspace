/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: "standalone",
  eslint: {
    ignoreDuringBuilds: true,
  },
  // Native/built-in server modules that must not be bundled by webpack.
  serverExternalPackages: ["node:sqlite"],
};

export default nextConfig;
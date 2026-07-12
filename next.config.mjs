/** @type {import('next').NextConfig} */
const nextConfig = {
  // The in-browser MP4 encoder runs in a Web Worker loaded via
  // `new Worker(new URL("./encode.worker.ts", import.meta.url))`. Next 15's
  // webpack build supports this natively; no extra worker config is required.
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;

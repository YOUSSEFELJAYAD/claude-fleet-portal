/** @type {import('next').NextConfig} */
const FLEET_API = process.env.NEXT_PUBLIC_FLEET_API || 'http://127.0.0.1:4319';

const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@fleet/shared'],
  env: { NEXT_PUBLIC_FLEET_API: FLEET_API },
};

export default nextConfig;

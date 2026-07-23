import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  // The backend URL is read server-side only (see app/api/gateway) so the
  // platform API key never reaches the browser bundle.
  env: {},
};

export default config;

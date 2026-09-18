import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,

  /**
   * Standalone output bundles the server and only the dependencies it actually
   * traced, so the runtime image ships neither `node_modules` in full nor the
   * source. That matters here for the same reason it does on the backend: the
   * less that exists in the image, the less an agent-executed command could
   * reach if it ever escaped its boundary.
   */
  output: 'standalone',

  // The backend URL and every credential are read server-side only (see
  // app/api/gateway and lib/session), so nothing reaches the browser bundle.
  env: {},
};

export default config;

/** @type {import('next').NextConfig} */
const nextConfig = {
  // turbopack: {},  // Disabled due to ssh2 compatibility issue
  webpack: (config, { isServer }) => {
    if (isServer) {
      config.externals = [...(config.externals || []), 'ssh2'];
    }
    return config;
  },
};

export default nextConfig;

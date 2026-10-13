/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async redirects() {
    // Activity / Insights live only in Sales Agent Mail — not in the mailer UI.
    return [
      { source: "/activity", destination: "/inbox", permanent: false },
      { source: "/insights", destination: "/inbox", permanent: false },
    ];
  },
};

module.exports = nextConfig;

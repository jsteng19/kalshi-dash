/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    unoptimized: true,
  },
  // NOTE: This app intentionally runs as a Node Next.js server (not a
  // static export). The tier-history persistence layer at
  // `/api/tier-history/*` uses better-sqlite3 and only works with Node
  // route handlers — a static export would silently drop the API routes.
  // Use `npm run dev` or `npm run build && npm start` for local use.
};

module.exports = nextConfig;

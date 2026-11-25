import type { NextConfig } from "next";

const isProd = process.env.NODE_ENV === "production";

const securityHeaders = [
  { key: "X-DNS-Prefetch-Control", value: "on" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), interest-cohort=()",
  },
  ...(isProd
    ? [
        {
          key: "Strict-Transport-Security",
          value: "max-age=63072000; includeSubDomains; preload",
        },
      ]
    : []),
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  outputFileTracingIncludes: {
    // keep the email templates + supabase helpers in the serverless bundle
    "/api/email/send": ["./src/server/**/*"],
    // pdfme reads the TTF bytes at runtime; without this trace the PDF route
    // works locally but fails on Vercel with ENOENT.
    "/api/**/*": ["./public/fonts/*.ttf"],
  },
  images: {
    remotePatterns: [{ protocol: "https", hostname: "**.supabase.co" }],
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
  async redirects() {
    // The provider/API-key screens are gone. Keep old bookmarks working and
    // send them to the profile the documents are actually signed with.
    return [
      { source: "/settings/ai", destination: "/settings/senders", permanent: true },
      { source: "/settings/models", destination: "/settings/senders", permanent: true },
    ];
  },
};

export default nextConfig;

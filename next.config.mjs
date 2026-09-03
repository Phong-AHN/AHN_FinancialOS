/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,

  /**
   * The Image Optimizer is switched off, not merely unused.
   *
   * This app renders no images — every chart is inline SVG — so the optimizer
   * was already dead code. It also carries a known DoS advisory affecting
   * self-hosted Next.js, with no fix inside the 14.2.x line. Disabling it
   * removes the endpoint rather than leaving it running and unreferenced.
   *
   * If images are added later, this has to be revisited deliberately: turning
   * it back on restores the endpoint along with the optimisation.
   */
  images: { unoptimized: true },
  async headers() {
    const supabaseHost = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';

    /**
     * Content-Security-Policy.
     *
     * The one header that turns a script injection from a total compromise into
     * a blocked request. This app renders no third-party scripts, embeds no
     * iframes and loads no remote images, so the policy can be tight enough to
     * be worth having rather than a decorative default.
     *
     * `'unsafe-inline'` on script-src is the one concession, and it is Next.js
     * itself: the App Router inlines its hydration payload in a <script> tag.
     * Removing it needs per-request nonces threaded through the document, which
     * is a real change rather than a config line — recorded in SECURITY.md as
     * the next hardening step rather than quietly left off the list.
     *
     * `connect-src` is pinned to the Supabase project, because a browser that
     * has been made to run hostile script still cannot post the ledger to an
     * address that is not in this list.
     */
    const csp = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      `connect-src 'self' ${supabaseHost} https://*.supabase.co wss://*.supabase.co`.trim(),
      "frame-ancestors 'none'",
      "form-action 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      'upgrade-insecure-requests',
    ].join('; ');

    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: csp },
          // Two years, subdomains included, preload-eligible. A financial
          // application that can be reached once over plain HTTP can be
          // downgraded on a hostile network.
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=63072000; includeSubDomains; preload',
          },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          {
            key: 'Permissions-Policy',
            value:
              'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
          },
          // Keeps this origin out of shared browser process state, so a bug in
          // another tab cannot read this one's memory.
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
          { key: 'Cross-Origin-Resource-Policy', value: 'same-origin' },
          { key: 'X-Permitted-Cross-Domain-Policies', value: 'none' },
          { key: 'X-DNS-Prefetch-Control', value: 'off' },
        ],
      },
      {
        // Nothing under /api is ever cacheable: every response is either a
        // financial figure or an authenticated action, and a shared cache
        // holding either is a disclosure waiting for the next reader.
        source: '/api/:path*',
        headers: [
          { key: 'Cache-Control', value: 'no-store, no-cache, must-revalidate, private' },
          { key: 'Pragma', value: 'no-cache' },
        ],
      },
    ];
  },
};
export default nextConfig;

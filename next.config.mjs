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
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
};
export default nextConfig;

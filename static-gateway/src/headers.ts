import type { ServerResponse } from 'node:http';

/** The headers DESIGN.md §6.4 requires on every gateway response, in order. */
export function securityHeaders(shellOrigin: string): Record<string, string> {
  return {
    'Content-Security-Policy':
      "default-src 'none'; " +
      "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net/npm/; " +
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
      "font-src 'self' https://fonts.gstatic.com data:; " +
      "img-src 'self' data: blob:; " +
      "media-src 'self' data: blob:; " +
      "connect-src 'none'; " +
      `frame-ancestors ${shellOrigin}; ` +
      "form-action 'none'; " +
      "base-uri 'none'; " +
      "object-src 'none'; " +
      'sandbox allow-scripts allow-same-origin allow-modals allow-forms',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cache-Control': 'private, no-store',
  };
}

export function applySecurityHeaders(res: ServerResponse, shellOrigin: string): void {
  for (const [name, value] of Object.entries(securityHeaders(shellOrigin))) res.setHeader(name, value);
}

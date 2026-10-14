import { createHash } from 'node:crypto';
import { escapeHtml } from './cookies.js';
import type { ShellConfig } from './config.js';

export const BANNER_TEXT = 'AI-generated artifact. Never enter passwords or credentials here.';
export const IFRAME_SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-modals';

const STYLE =
  'html,body{margin:0;height:100%;font:14px/1.4 system-ui,sans-serif;background:#f6f6f6;color:#1a1a1a}' +
  'body{display:flex;flex-direction:column}' +
  '.banner{flex:none;padding:10px 16px;background:#fff3cd;color:#5c3d00;border-bottom:1px solid #e0c36a;display:flex;gap:16px;align-items:baseline}' +
  '.banner strong{font-weight:600}.banner span{margin-left:auto;white-space:nowrap}' +
  'iframe{flex:1;width:100%;border:0;background:#fff}' +
  'main{padding:32px 16px;max-width:40rem}';

/** CSP source for the one inline `<style>` block, so `style-src` carries no `'unsafe-inline'`. */
export const STYLE_HASH = `sha256-${createHash('sha256').update(STYLE, 'utf8').digest('base64')}`;

export function shellHeaders(config: ShellConfig): Record<string, string> {
  return {
    'Content-Security-Policy':
      `default-src 'self'; frame-src ${config.artifactScheme}://*.${config.artifactDomain}; script-src 'self'; ` +
      `style-src 'self' '${STYLE_HASH}'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'private, no-store',
  };
}

export function renderViewerPage(args: { artifactId: string; iframeSrc: string; expiresAt?: string }): string {
  const expires = args.expiresAt ? `<span>Expires ${escapeHtml(formatDate(args.expiresAt))}</span>` : '';
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    `<title>Artifact ${escapeHtml(args.artifactId)}</title><style>${STYLE}</style></head><body>` +
    `<div class="banner" role="alert"><strong>${BANNER_TEXT}</strong>${expires}</div>` +
    `<iframe src="${escapeHtml(args.iframeSrc)}" sandbox="${IFRAME_SANDBOX}" referrerpolicy="no-referrer" title="Artifact"></iframe>` +
    '</body></html>'
  );
}

export function renderMessagePage(title: string, message: string): string {
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    `<title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></main></body></html>`
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
}

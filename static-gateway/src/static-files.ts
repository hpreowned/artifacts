import { promises as fs } from 'node:fs';
import path from 'node:path';

/** Extensions the gateway will serve. Anything else is a 404 even if the file exists. */
export const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.wasm': 'application/wasm',
};

export interface ResolvedFile {
  absolutePath: string;
  contentType: string;
  size: number;
}

/**
 * Maps a URL path to a file under `<serveRoot>/<artifactId>/`.
 * Returns null for anything that is not a plain, allowlisted, regular file inside that directory:
 * traversal, encoded traversal, null bytes, symlinks escaping the root, directories, unknown extensions.
 */
export async function resolveArtifactFile(serveRoot: string, artifactId: string, urlPath: string): Promise<ResolvedFile | null> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;
  if (decoded.endsWith('/')) decoded += 'index.html';
  const segments = decoded.split('/').filter((s) => s.length > 0);
  if (segments.some((s) => s === '.' || s === '..')) return null;

  const artifactDir = path.resolve(serveRoot, artifactId);
  const candidate = path.resolve(artifactDir, ...segments);
  if (!isInside(artifactDir, candidate)) return null;

  const ext = path.extname(candidate).toLowerCase();
  const contentType = CONTENT_TYPES[ext];
  if (!contentType) return null;

  try {
    const [realDir, realFile] = await Promise.all([fs.realpath(artifactDir), fs.realpath(candidate)]);
    if (!isInside(realDir, realFile)) return null;
    const stat = await fs.stat(realFile);
    if (!stat.isFile()) return null;
    return { absolutePath: realFile, contentType, size: stat.size };
  } catch {
    return null;
  }
}

function isInside(dir: string, file: string): boolean {
  return file.startsWith(dir + path.sep);
}

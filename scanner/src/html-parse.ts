// A small, dependency-free HTML tokenizer for the rules in checks.ts. It does what the rules need and nothing
// more: start tags with attributes, script bodies, and comment skipping outside script/style, as a browser does.
export interface Tag {
  name: string;
  attrs: Record<string, string>;
  offset: number;
}

export interface ScriptBlock {
  body: string;
  /** Offset of the first body character in the document. */
  offset: number;
}

export interface ParsedHtml {
  tags: Tag[];
  scripts: ScriptBlock[];
}

const NAME_END = /[\s/>]/;
const ATTR_NAME_END = /[\s/>=]/;

export function parseHtml(html: string): ParsedHtml {
  const tags: Tag[] = [];
  const scripts: ScriptBlock[] = [];
  const lower = html.toLowerCase();
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) break;
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      i = end < 0 ? html.length : end + 3;
      continue;
    }
    const first = html[lt + 1] ?? "";
    if (!/[A-Za-z]/.test(first)) {
      i = lt + 1;
      continue;
    }
    let p = lt + 1;
    while (p < html.length && !NAME_END.test(html[p]!)) p++;
    const name = lower.slice(lt + 1, p);
    const attrs: Record<string, string> = {};
    p = readAttributes(html, p, attrs);
    tags.push({ name, attrs, offset: lt });
    i = p;
    if (name === "script" || name === "style") {
      const close = lower.indexOf(`</${name}`, i);
      const end = close < 0 ? html.length : close;
      if (name === "script") scripts.push({ body: html.slice(i, end), offset: i });
      i = end;
    }
  }
  return { tags, scripts };
}

/** Reads attributes from `p` to just past the closing `>`; returns the new position. Lowercases names. */
function readAttributes(html: string, p: number, attrs: Record<string, string>): number {
  for (;;) {
    while (p < html.length && /\s/.test(html[p]!)) p++;
    if (p >= html.length) return p;
    const ch = html[p]!;
    if (ch === ">") return p + 1;
    if (ch === "/") {
      p++;
      continue;
    }
    let q = p;
    while (q < html.length && !ATTR_NAME_END.test(html[q]!)) q++;
    if (q === p) {
      p++;
      continue;
    }
    const name = html.slice(p, q).toLowerCase();
    p = q;
    while (p < html.length && /\s/.test(html[p]!)) p++;
    let value = "";
    if (html[p] === "=") {
      p++;
      while (p < html.length && /\s/.test(html[p]!)) p++;
      const quote = html[p];
      if (quote === '"' || quote === "'") {
        const end = html.indexOf(quote, p + 1);
        value = html.slice(p + 1, end < 0 ? html.length : end);
        p = end < 0 ? html.length : end + 1;
      } else {
        let e = p;
        while (e < html.length && !/[\s>]/.test(html[e]!)) e++;
        value = html.slice(p, e);
        p = e;
      }
    }
    if (!(name in attrs)) attrs[name] = value;
  }
}

export function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/** True for URLs that name a host or a scheme: `https://x`, `//x`, `javascript:…`, `data:…`. Relative paths are false. */
export function pointsElsewhere(url: string): boolean {
  const u = url.trim();
  return u.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(u);
}

/** True for http(s) and protocol-relative URLs, which name an external host. */
export function isExternalHttp(url: string): boolean {
  const u = url.trim();
  return u.startsWith("//") || /^https?:\/\//i.test(u);
}

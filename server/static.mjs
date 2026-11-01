import { open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { extname, relative, resolve, sep, basename } from 'node:path';
import { pipeline } from 'node:stream/promises';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.ico': 'image/x-icon', '.mp4': 'video/mp4', '.m4a': 'audio/mp4', '.webm': 'video/webm', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8', '.zip': 'application/zip',
  '.wasm': 'application/wasm',
};
export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/** Validate before WHATWG URL normalization can conceal encoded dot segments. */
export function requestTarget(target) {
  if (typeof target !== 'string' || !target.startsWith('/') || target.startsWith('//') || target.includes('#')) throw new HttpError(400, 'Bad request target');
  const rawPath = target.split('?')[0];
  if (/%2f|%5c/i.test(rawPath)) throw new HttpError(400, 'Bad path');
  let pathname;
  try { pathname = decodeURIComponent(rawPath); } catch { throw new HttpError(400, 'Bad path'); }
  if (/[\\\u0000-\u001f\u007f]/u.test(pathname) || pathname.split('/').some(part => part === '..' || part === '.' || part.startsWith('.'))) throw new HttpError(400, 'Bad path');
  return { pathname, search: target.includes('?') ? target.slice(target.indexOf('?')) : '' };
}

function inside(base, target) {
  const part = relative(base, target);
  return part !== '' && part !== '..' && !part.startsWith('..' + sep) && !part.startsWith(sep);
}
export function byteRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2]) || !size) throw new HttpError(416, 'Range not satisfiable');
  let start, end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) throw new HttpError(416, 'Range not satisfiable');
    start = Math.max(0, size - suffix); end = size - 1;
  } else {
    start = Number(match[1]); end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) throw new HttpError(416, 'Range not satisfiable');
    end = Math.min(end, size - 1);
  }
  return { start, end };
}

export async function createStaticHandler({ webRoot, mediaRoot }) {
  const roots = { web: await realpath(webRoot), media: await realpath(mediaRoot) };
  const fingerprints = new Map();
  async function locate(base, filename) {
    try {
      const canonical = await realpath(resolve(base, filename));
      if (!inside(base, canonical)) return null;
      const file = await open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const stat = await file.stat();
      if (!stat.isFile()) { await file.close(); return null; }
      return { file, stat, canonical };
    } catch (error) {
      if (['ENOENT', 'ENOTDIR', 'ELOOP', 'EACCES', 'EPERM'].includes(error.code)) return null;
      throw error;
    }
  }
  async function fingerprint(asset) {
    const { canonical, file, stat } = asset;
    const key = `${canonical}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.ino}`;
    if (!fingerprints.has(key)) {
      if (fingerprints.size >= 512) fingerprints.clear();
      const pending = (async () => {
        const hash = createHash('sha256');
        for await (const chunk of file.createReadStream({ autoClose: false, start: 0 })) hash.update(chunk);
        return hash.digest('hex');
      })();
      fingerprints.set(key, pending);
      pending.catch(() => fingerprints.delete(key));
    }
    return fingerprints.get(key);
  }

  return async function serve(request, response, target) {
    if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405, { Allow: 'GET, HEAD', 'Content-Length': '0' }); response.end(); return; }
    let path = target.pathname;
    if (path === '/app' || path === '/app/') { response.writeHead(302, { Location: '/legacy/app/', 'Cache-Control': 'no-store', 'Content-Length': '0' }); response.end(); return; }
    if (path.endsWith('/')) path += 'index.html';
    const media = path.startsWith('/media/');
    let asset = await locate(media ? roots.media : roots.web, media ? path.slice(7) : path.slice(1));
    if (!asset && !media && /^\/[a-zA-Z0-9_-]+\.[a-zA-Z0-9]+$/.test(path)) asset = await locate(roots.web, 'legacy' + path);
    if (!asset) throw new HttpError(404, 'Page not found');
    const { file, stat } = asset;
    try {
      const digest = await fingerprint(asset), etag = `"sha256-${digest}"`, extension = extname(path).toLowerCase();
      const version = new URLSearchParams(target.search).get('v');
      const filenameVersion = basename(path).match(/[.-]([0-9a-f]{12,64})\.[^.]+$/i)?.[1];
      const versioned = [version, filenameVersion].some(value => value && value.length >= 12 && /^[0-9a-f]+$/i.test(value) && digest.startsWith(value.toLowerCase()));
      const headers = {
        'Content-Type': TYPES[extension] ?? 'application/octet-stream', 'Content-Length': String(stat.size),
        'Cache-Control': extension === '.html' ? 'no-cache' : versioned ? 'public, max-age=31536000, immutable' : 'public, max-age=300, must-revalidate',
        ETag: etag, 'Last-Modified': stat.mtime.toUTCString(), 'Accept-Ranges': 'bytes',
        'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cross-Origin-Resource-Policy': 'same-origin',
      };
      const matches = request.headers['if-none-match']?.split(',').some(value => value.trim() === '*' || value.trim().replace(/^W\//, '') === etag);
      const modifiedSince = request.headers['if-modified-since'];
      if (matches || (!request.headers['if-none-match'] && modifiedSince && Math.floor(stat.mtimeMs / 1000) * 1000 <= Date.parse(modifiedSince))) {
        delete headers['Content-Length']; response.writeHead(304, headers); response.end(); return;
      }
      let range = null;
      const ifRange = request.headers['if-range'];
      const mayRange = !ifRange || ifRange === etag || (!ifRange.startsWith('"') && Math.floor(stat.mtimeMs / 1000) * 1000 <= Date.parse(ifRange));
      try { if (mayRange) range = byteRange(request.headers.range, stat.size); }
      catch (error) {
        if (error.status !== 416) throw error;
        response.writeHead(416, { ...headers, 'Content-Range': `bytes */${stat.size}`, 'Content-Length': '0' }); response.end(); return;
      }
      if (range) { headers['Content-Range'] = `bytes ${range.start}-${range.end}/${stat.size}`; headers['Content-Length'] = String(range.end - range.start + 1); }
      response.writeHead(range ? 206 : 200, headers);
      if (request.method === 'HEAD' || !stat.size) { response.end(); return; }
      await pipeline(file.createReadStream({ autoClose: false, ...(range ?? { start: 0 }) }), response);
    } finally { await file.close(); }
  };
}

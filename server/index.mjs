import http from 'node:http';
import { isIP } from 'node:net';
import { resolve, isAbsolute, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleRooms, ROOM_LIMITS } from '../worker/rooms.mjs';
import { createInterpreter } from '../worker/interpret.mjs';
import { SqliteD1 } from './sqlite-d1.mjs';
import { createStaticHandler, HttpError, requestTarget } from './static.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
export function readConfiguration(environment = process.env) {
  let publicUrl;
  try { publicUrl = new URL(environment.PUBLIC_ORIGIN); } catch { throw new Error('PUBLIC_ORIGIN must be an explicit http(s) origin.'); }
  if (!['http:', 'https:'].includes(publicUrl.protocol) || publicUrl.username || publicUrl.password || publicUrl.pathname !== '/' || publicUrl.search || publicUrl.hash) throw new Error('PUBLIC_ORIGIN must contain only the public http(s) origin.');
  if (typeof environment.DATABASE_PATH !== 'string' || !isAbsolute(environment.DATABASE_PATH)) throw new Error('DATABASE_PATH must be an absolute persistent SQLite path.');
  if (typeof environment.ROOM_IP_SALT !== 'string' || environment.ROOM_IP_SALT.length < 16 || /[\u0000-\u001f\u007f]/u.test(environment.ROOM_IP_SALT)) throw new Error('ROOM_IP_SALT must contain at least 16 non-control characters.');
  const host = environment.HOST ?? '127.0.0.1', port = Number(environment.PORT ?? 3000);
  if (!isIP(host)) throw new Error('HOST must be a literal bind IP address.');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be an integer from 0 to 65535.');
  const trustProxy = environment.TRUST_PROXY ?? 'off';
  if (!['off', 'loopback'].includes(trustProxy)) throw new Error('TRUST_PROXY must be off or loopback.');
  const requireAi = environment.REQUIRE_AI ?? 'false';
  if (!['true', 'false'].includes(requireAi)) throw new Error('REQUIRE_AI must be true or false.');
  const interpreterEnv = Object.fromEntries(['CLAW_API_KEY', 'CLAW_MODEL', 'CLAW_BASE_URL'].filter(key => environment[key] !== undefined).map(key => [key, environment[key]]));
  if (requireAi === 'true' && !interpreterEnv.CLAW_API_KEY?.trim()) throw new Error('CLAW_API_KEY is required when REQUIRE_AI=true.');
  const webRoot = resolve(environment.STATIC_ROOT ?? resolve(ROOT, 'build/public'));
  const mediaRoot = resolve(environment.MEDIA_ROOT ?? resolve(webRoot, 'media'));
  if ([webRoot, mediaRoot].some(root => { const part = relative(root, environment.DATABASE_PATH); return part === '' || (part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part)); })) throw new Error('DATABASE_PATH must be outside all static directories.');
  return Object.freeze({ publicOrigin: publicUrl.origin, databasePath: environment.DATABASE_PATH,
    host, port, trustProxy, roomIpSalt: environment.ROOM_IP_SALT, interpreterEnv,
    webRoot, mediaRoot,
    migrationsDir: resolve(environment.MIGRATIONS_DIR ?? resolve(ROOT, 'drizzle')) });
}

function normalizeIp(value) {
  if (typeof value !== 'string') return null;
  const ip = value.trim().toLowerCase();
  if (ip.startsWith('::ffff:') && isIP(ip.slice(7)) === 4) return ip.slice(7);
  return isIP(ip) ? ip : null;
}
export function isLoopback(value) {
  const ip = normalizeIp(value);
  return ip === '::1' || (isIP(ip ?? '') === 4 && ip.startsWith('127.'));
}
export function clientIp(request, trustProxy = 'off') {
  const peer = normalizeIp(request.socket.remoteAddress) ?? 'unknown';
  // Nginx must overwrite X-Real-IP with $remote_addr. Never accept public CF/XFF claims.
  if (trustProxy === 'loopback' && isLoopback(peer)) return normalizeIp(request.headers['x-real-ip']) ?? peer;
  return peer;
}
function roomHeaders(request, trustProxy) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined || ['cf-connecting-ip', 'x-real-ip', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded', 'host', 'connection', 'transfer-encoding'].includes(name)) continue;
    headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  headers.set('cf-connecting-ip', clientIp(request, trustProxy));
  return headers;
}
function body(request, limit) {
  if (Number(request.headers['content-length']) > limit) { request.resume(); return Promise.reject(new HttpError(413, 'Request body too large')); }
  return new Promise((resolveBody, reject) => {
    const chunks = []; let size = 0, finished = false;
    const cleanup = () => { request.off('data', data); request.off('end', end); request.off('error', error); request.off('aborted', aborted); };
    const finish = (failure) => { if (finished) return; finished = true; cleanup(); failure ? reject(failure) : resolveBody(Buffer.concat(chunks, size)); };
    const data = chunk => {
      size += chunk.length;
      if (size > limit) { finish(new HttpError(413, 'Request body too large')); request.resume(); }
      else chunks.push(chunk);
    };
    const end = () => finish();
    const error = () => finish(new HttpError(400, 'Request body interrupted'));
    const aborted = () => finish(new HttpError(400, 'Request body interrupted'));
    request.on('data', data); request.once('end', end); request.once('error', error); request.once('aborted', aborted);
  });
}
function sendJson(response, status, value, head = false) {
  if (response.destroyed || response.writableEnded) return;
  const encoded = Buffer.from(JSON.stringify(value));
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'Content-Length': String(encoded.length), 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
  response.end(head ? undefined : encoded);
}

export async function createTeamLinkServer({ config = readConfiguration(), interpret, fetcher } = {}) {
  const db = new SqliteD1(config.databasePath, { migrationsDir: config.migrationsDir });
  let staticHandler;
  try { staticHandler = await createStaticHandler(config); } catch (error) { db.close(); throw error; }
  const hasAi = typeof interpret === 'function' || !!config.interpreterEnv.CLAW_API_KEY?.trim();
  const interpreter = interpret ?? (hasAi ? createInterpreter(config.interpreterEnv, fetcher ? { fetcher } : undefined) : undefined);
  const mode = hasAi ? 'ai' : 'commands';
  const env = { DB: db, ROOM_IP_SALT: config.roomIpSalt };
  let stopping = false, activeRequests = 0;
  const drained = new Set();
  const server = http.createServer({ maxHeaderSize: 16384, requestTimeout: 15000, headersTimeout: 10000, keepAliveTimeout: 5000 }, async (request, response) => {
    activeRequests++;
    try {
      const target = requestTarget(request.url);
      if (['/api/health', '/healthz', '/api/ready', '/readyz'].includes(target.pathname)) {
        if (!['GET', 'HEAD'].includes(request.method)) { response.setHeader('Allow', 'GET, HEAD'); sendJson(response, 405, { error: 'Method not allowed' }); return; }
        const ready = !stopping && db.ready();
        const readiness = ['/api/ready', '/readyz'].includes(target.pathname);
        sendJson(response, readiness && !ready ? 503 : 200, { ok: readiness ? ready : true, mode, roomTtlHours: 6 }, request.method === 'HEAD'); return;
      }
      if (target.pathname.startsWith('/api/')) {
        if (stopping) { sendJson(response, 503, { error: 'Service is stopping', code: 'SERVICE_STOPPING' }); return; }
        const headers = roomHeaders(request, config.trustProxy);
        const bytes = !['GET', 'HEAD'].includes(request.method) ? await body(request, ROOM_LIMITS.bodyBytes) : undefined;
        const url = new URL(config.publicOrigin);
        url.pathname = target.pathname; url.search = target.search;
        const result = await handleRooms(new Request(url, { method: request.method, headers, ...(bytes ? { body: bytes } : {}) }), env,
          interpreter ? { interpret: interpreter, mode } : { mode });
        if (!result) { sendJson(response, 404, { error: 'API not found' }); return; }
        if (response.destroyed) return;
        const output = Buffer.from(await result.arrayBuffer());
        result.headers.forEach((value, name) => response.setHeader(name, value));
        response.setHeader('Content-Length', String(output.length)); response.statusCode = result.status;
        response.end(request.method === 'HEAD' ? undefined : output); return;
      }
      await staticHandler(request, response, target);
    } catch (error) {
      if (response.headersSent) { response.destroy(); return; }
      sendJson(response, error instanceof HttpError ? error.status : 500,
        { error: error instanceof HttpError ? error.message : 'Service temporarily unavailable' }, request.method === 'HEAD');
    } finally {
      activeRequests--;
      if (!activeRequests) { for (const resolveDrain of drained) resolveDrain(); drained.clear(); }
    }
  });
  server.maxConnections = 256;
  let closing;
  return {
    server, db, mode,
    listen: () => new Promise((resolveListen, reject) => {
      const failed = error => { server.off('listening', started); reject(error); };
      const started = () => { server.off('error', failed); resolveListen(server.address()); };
      server.once('error', failed); server.once('listening', started); server.listen(config.port, config.host);
    }),
    close: () => {
      if (closing) return closing;
      stopping = true;
      closing = new Promise((resolveClose, reject) => {
        const timer = setTimeout(() => server.closeAllConnections(), 35000); timer.unref();
        const idle = activeRequests ? new Promise(resolveDrain => drained.add(resolveDrain)) : Promise.resolve();
        const socketsClosed = new Promise((resolveSockets, rejectSockets) => server.close(error => error && error.code !== 'ERR_SERVER_NOT_RUNNING' ? rejectSockets(error) : resolveSockets()));
        Promise.all([idle, socketsClosed]).then(() => { clearTimeout(timer); db.close(); resolveClose(); }, error => { clearTimeout(timer); db.close(); reject(error); });
        server.closeIdleConnections();
      });
      return closing;
    },
  };
}

if (import.meta.main) {
  try {
    const config = readConfiguration();
    const application = await createTeamLinkServer({ config });
    const address = await application.listen();
    // No request URLs, bodies, environment values or credentials are logged.
    console.log(`TeamLink Node server listening on port ${address.port}; mode=${application.mode}`);
    const stop = () => application.close().then(() => process.exit(0), () => process.exit(1));
    process.once('SIGTERM', stop); process.once('SIGINT', stop);
  } catch (error) {
    const safe = /^(PUBLIC_ORIGIN|DATABASE_PATH|ROOM_IP_SALT|HOST|PORT|TRUST_PROXY|REQUIRE_AI|CLAW_API_KEY)/.test(error.message) ? error.message : 'Startup failed. Check static build, data directory and migration history.';
    console.error(safe); process.exitCode = 1;
  }
}

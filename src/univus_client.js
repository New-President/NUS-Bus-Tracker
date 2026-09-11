import { fetchAllLiveBuses, normalizeBus } from './api_client.js';
import { ProviderError, requestProviderJson } from './provider_http.js';
import { ROUTE_CODES } from './routes.js';

const ORIGIN = 'https://inetapps.nus.edu.sg';
const WEB_BASE = `${ORIGIN}/univus/web/`;
const PROXY_PATH = '/univus/web/api/esb';
const LOGIN_URL = `${WEB_BASE}api/login/loginPublic`;
const RENEW_AFTER_MS = (24 * 60 - 15) * 60 * 1000;
const REQUIRED_COOKIES = ['UNIVUS_WEB_API_DATA', '.Univus.Web.Session', 'UNIVUS_WEB_XSRF_TOKEN'];
const AUTH_CODES = new Set(['10007', '19000']);

function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function invalidSession() {
  return new ProviderError('uNivUS returned an invalid guest session.', { code: 'univus_auth_failed' });
}
function pathMatches(path) {
  return PROXY_PATH === path || PROXY_PATH.startsWith(path.endsWith('/') ? path : `${path}/`);
}
function cookieValue(cookies, name, now) {
  return [...cookies.values()].filter(cookie => cookie.name === name && cookie.expiresAt > now)
    .sort((a, b) => b.path.length - a.path.length)[0]?.value;
}
function decodeCookie(value) {
  try { return decodeURIComponent(value); }
  catch { throw invalidSession(); }
}

// This jar is used exclusively for the fixed official origin and proxy path.
// Values retain '=' padding and are never returned through the public client API.
function mergeCookies(cookies, headers, now, defaultPath) {
  const values = headers.getSetCookie();
  if (values.length > 64 || values.reduce((size, value) => size + value.length, 0) > 65536) throw invalidSession();
  for (const serialized of values) {
    if (/[\r\n\x00]/.test(serialized)) throw invalidSession();
    const [pair, ...attributes] = serialized.split(';');
    const split = pair.indexOf('=');
    if (split < 1) throw invalidSession();
    const name = pair.slice(0, split).trim();
    const value = pair.slice(split + 1).trim();
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)
      || !/^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*$/.test(value)) throw invalidSession();
    let path = defaultPath;
    let domain = 'inetapps.nus.edu.sg';
    let expiresAt = Infinity;
    let maxAge = null;
    for (const raw of attributes) {
      const separator = raw.indexOf('=');
      const attribute = (separator === -1 ? raw : raw.slice(0, separator)).trim().toLowerCase();
      const setting = separator === -1 ? '' : raw.slice(separator + 1).trim();
      if (attribute === 'domain') domain = setting.replace(/^\./, '').toLowerCase();
      else if (attribute === 'path' && setting.startsWith('/')) path = setting;
      else if (attribute === 'max-age' && /^-?\d+$/.test(setting)) maxAge = Number(setting);
      else if (attribute === 'expires') {
        const expiry = Date.parse(setting);
        if (Number.isFinite(expiry)) expiresAt = expiry;
      }
    }
    if (!['inetapps.nus.edu.sg', 'nus.edu.sg'].includes(domain) || !pathMatches(path)) continue;
    if (maxAge !== null) expiresAt = maxAge <= 0 ? 0 : now + maxAge * 1000;
    const key = `${name}\n${domain}\n${path}`;
    if (expiresAt <= now) cookies.delete(key);
    else cookies.set(key, { name, value, path, expiresAt });
  }
  if (cookies.size > 64) throw invalidSession();
}

function sessionHeaders(session, now) {
  if (REQUIRED_COOKIES.some(name => !cookieValue(session.cookies, name, now))) throw invalidSession();
  const domain = cookieValue(session.cookies, 'UNIVUS_WEB_USER_DOMAIN', now);
  if (domain !== undefined && decodeCookie(domain) !== 'PUBLIC') throw invalidSession();
  const xsrf = decodeCookie(cookieValue(session.cookies, 'UNIVUS_WEB_XSRF_TOKEN', now));
  if (!xsrf || !/^[\x21-\x7E]+$/.test(xsrf)) throw invalidSession();
  return {
    'Content-Type': 'application/json; charset=utf-8',
    'X-XSRF-TOKEN': xsrf,
    Cookie: [...session.cookies.values()].filter(cookie => cookie.expiresAt > now)
      .sort((a, b) => b.path.length - a.path.length).map(cookie => `${cookie.name}=${cookie.value}`).join('; '),
    Origin: ORIGIN,
    Referer: WEB_BASE
  };
}

function applyCookies(session, headers, now, defaultPath) {
  mergeCookies(session.cookies, headers, now, defaultPath);
  session.renewAt = Math.min(session.createdAt + RENEW_AFTER_MS,
    ...[...session.cookies.values()].map(cookie => cookie.expiresAt));
}

function isAuthenticationError(error) {
  return error instanceof ProviderError && (error.httpStatus === 401 || error.httpStatus === 403
    || error.code === 'univus_session_expired');
}

export class UnivusClient {
  #fetchImpl;
  #now;
  #timeoutMs;
  #session = null;
  #pending = null;

  constructor({ fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = 8000 } = {}) {
    this.#fetchImpl = fetchImpl;
    this.#now = now;
    this.#timeoutMs = timeoutMs;
  }

  #isFresh(session) {
    if (!session || session.renewAt <= this.#now()) return false;
    try { sessionHeaders(session, this.#now()); return true; }
    catch { return false; }
  }

  getStatus() {
    return {
      hasSession: this.#isFresh(this.#session), tokenSource: 'guest', tokenExpiresAt: null,
      sessionRenewAt: this.#session ? new Date(this.#session.renewAt).toISOString() : null
    };
  }

  async ensureSession() { await this.#getSession(); }

  async #getSession() {
    if (this.#isFresh(this.#session)) return this.#session;
    if (this.#pending) return this.#pending;
    this.#session = null;
    const pending = this.#login();
    this.#pending = pending;
    try {
      const session = await pending;
      this.#session = session;
      return session;
    } finally { if (this.#pending === pending) this.#pending = null; }
  }

  async #renewRejectedSession(rejectedSession) {
    // Responses from an old concurrent request must not invalidate a newer login.
    if (rejectedSession.renewal) return rejectedSession.renewal;
    if (this.#session === rejectedSession) this.#session = null;
    rejectedSession.renewal = this.#getSession();
    return rejectedSession.renewal;
  }

  async #login() {
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new ProviderError('uNivUS guest login timed out.', { code: 'timeout' }));
      }, this.#timeoutMs);
    });
    try {
      return await Promise.race([timeout, (async () => {
        const response = await this.#fetchImpl(LOGIN_URL, {
          method: 'GET', redirect: 'manual', signal: controller.signal,
          headers: { Accept: 'text/html', Referer: WEB_BASE }
        });
        // The login redirect itself carries the cookies. Never follow it or read its body.
        await response.body?.cancel();
        if (response.status !== 302) {
          throw new ProviderError('uNivUS guest login was not accepted.', {
            code: 'univus_auth_failed', httpStatus: response.status
          });
        }
        const location = response.headers.get('location');
        if (!location) throw invalidSession();
        const target = new URL(location, LOGIN_URL);
        if (target.origin !== ORIGIN || target.username || target.password
          || !target.pathname.startsWith('/univus/web/')) throw invalidSession();
        const now = this.#now();
        const session = { cookies: new Map(), createdAt: now, renewAt: now + RENEW_AFTER_MS };
        applyCookies(session, response.headers, now, '/univus/web/api/login');
        sessionHeaders(session, now);
        if (session.renewAt <= now) throw invalidSession();
        return session;
      })()]);
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      if (controller.signal.aborted) throw new ProviderError('uNivUS guest login timed out.', { code: 'timeout' });
      throw new ProviderError('Unable to establish a uNivUS guest session.', { code: 'univus_auth_failed' });
    } finally { clearTimeout(timer); }
  }

  async #queryRoute(routeCode, session) {
    let payload = await requestProviderJson(`${ORIGIN}${PROXY_PATH}`, {
      timeoutMs: this.#timeoutMs, method: 'POST', headers: sessionHeaders(session, this.#now()),
      body: JSON.stringify({ methodpath: '/univus/api/bus-proxy/active-bus', route_code: routeCode }),
      fetchImpl: async (url, options) => {
        const response = await this.#fetchImpl(url, options);
        try { applyCookies(session, response.headers, this.#now(), '/univus/web/api'); }
        catch (error) {
          try { await response.body?.cancel(); } catch {}
          throw error;
        }
        return response;
      }
    });
    // ASP.NET may JSON-encode the upstream JSON text depending on content negotiation.
    // Accept exactly one such wrapper, then require the same object contract.
    if (typeof payload === 'string') {
      try { payload = JSON.parse(payload); }
      catch { throw new ProviderError('uNivUS returned invalid JSON.', { code: 'invalid_json' }); }
    }
    if (!isObject(payload)) {
      throw new ProviderError(`Route ${routeCode}: unexpected uNivUS response.`, { code: 'invalid_response' });
    }
    if (payload.code !== '00000') {
      if (AUTH_CODES.has(payload.code)) {
        throw new ProviderError('uNivUS guest session has expired.', { code: 'univus_session_expired' });
      }
      throw new ProviderError(`Route ${routeCode}: uNivUS did not return successful bus data.`, { code: 'provider_response_error' });
    }
    const data = payload.data;
    if (!isObject(data) || !Array.isArray(data.activebus)) {
      throw new ProviderError(`Route ${routeCode}: unexpected uNivUS bus response.`, { code: 'invalid_response' });
    }
    const timestamp = data.TimeStamp ?? data.Timestamp;
    const reportedAt = typeof timestamp === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(timestamp) ? Date.parse(timestamp) : NaN;
    const now = this.#now();
    if (!Number.isFinite(reportedAt) || now - reportedAt > 120000 || reportedAt - now > 60000) {
      throw new ProviderError(`Route ${routeCode}: uNivUS timestamp is missing, invalid, or stale.`, { code: 'stale_response' });
    }
    if (data.ActiveBusCount !== undefined && ((!['number', 'string'].includes(typeof data.ActiveBusCount))
      || !/^(0|[1-9]\d*)$/.test(String(data.ActiveBusCount))
      || Number(data.ActiveBusCount) !== data.activebus.length)) {
      throw new ProviderError(`Route ${routeCode}: uNivUS bus count is inconsistent.`, { code: 'invalid_response' });
    }
    for (const bus of data.activebus) {
      if (!isObject(bus)) throw new ProviderError(`Route ${routeCode}: invalid uNivUS vehicle record.`, { code: 'invalid_response' });
      normalizeBus(bus, routeCode, now);
    }
    return data.activebus;
  }

  async fetchRouteBuses(routeCode) {
    if (typeof routeCode !== 'string' || !/^[A-Z0-9-]{1,12}$/.test(routeCode)) {
      throw new ProviderError('Invalid route identifier.', { code: 'invalid_route' });
    }
    let session = await this.#getSession();
    try { return await this.#queryRoute(routeCode, session); }
    catch (error) {
      if (!isAuthenticationError(error)) throw error;
      session = await this.#renewRejectedSession(session);
      try { return await this.#queryRoute(routeCode, session); }
      catch (retryError) {
        if (isAuthenticationError(retryError) && this.#session === session) this.#session = null;
        throw retryError;
      }
    }
  }

  async fetchBuses({ routes = ROUTE_CODES } = {}) {
    return fetchAllLiveBuses(null, {
      routes, now: this.#now, fetchRoute: route => this.fetchRouteBuses(route)
    });
  }
}

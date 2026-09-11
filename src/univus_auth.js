import { randomUUID } from 'node:crypto';
import { ProviderError, requestProviderJson } from './provider_http.js';

const AUTH_BASE_URL = 'https://myizaac2.nus.edu.sg';
const DAY_MS = 24 * 60 * 60 * 1000;
const REFRESH_EARLY_MS = 5 * 60 * 1000;
// Shared public-app identifiers published with the guest API documentation:
// https://github.com/SuibianP/nus-nextbus-new-api/blob/openapi-def/DISCLAIMER.md
const PUBLIC_APP_HEADERS = {
  'X-HTD-API': '981c42c3-7e15-3de4-bebf-d02d71a4953f',
  'X-APP-API': '0ee8aa45-6f31-34e6-a66e-d54f990c1a2d'
};

function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function credential(value) { return typeof value === 'string' && value.length > 0 && value.length <= 65536 && !/\s/.test(value); }

function expiryFromJwt(token, fallback) {
  // This unverified payload is used only to schedule renewal, never authorize a user.
  try {
    const segments = token.split('.');
    if (segments.length !== 3) return fallback;
    const payload = JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8'));
    return object(payload) && typeof payload.exp === 'number' && Number.isFinite(payload.exp)
      ? Math.min(payload.exp * 1000, fallback) : fallback;
  } catch { return fallback; }
}

export class GuestTokenProvider {
  #fetchImpl;
  #now;
  #timeoutMs;
  #headers;
  #version;
  #deviceid = randomUUID();
  #token = null;
  #expiresAt = null;
  #pending = null;
  #generation = 0;

  constructor({ fetchImpl = globalThis.fetch, now = Date.now, env = process.env, timeoutMs = 8000 } = {}) {
    this.#fetchImpl = fetchImpl;
    this.#now = now;
    this.#timeoutMs = timeoutMs;
    this.#headers = {
      'Content-Type': 'application/json',
      'X-HTD-API': env.UNIVUS_HTD_API?.trim() || PUBLIC_APP_HEADERS['X-HTD-API'],
      'X-APP-API': env.UNIVUS_APP_API?.trim() || PUBLIC_APP_HEADERS['X-APP-API']
    };
    this.#version = env.UNIVUS_APP_VERSION?.trim() || '2.56.0';
  }

  getStatus() {
    return {
      tokenSource: 'guest',
      tokenExpiresAt: this.#expiresAt === null ? null : new Date(this.#expiresAt).toISOString()
    };
  }

  invalidate() {
    this.#generation++;
    this.#token = null;
    this.#expiresAt = null;
    this.#pending = null;
  }

  async getToken() {
    if (this.#token && this.#expiresAt - REFRESH_EARLY_MS > this.#now()) return this.#token;
    if (this.#pending) return this.#pending;
    const generation = this.#generation;
    const pending = this.#authenticate(generation);
    this.#pending = pending;
    try { return await pending; }
    finally { if (this.#pending === pending) this.#pending = null; }
  }

  async #post(path, payload) {
    return requestProviderJson(`${AUTH_BASE_URL}${path}`, {
      fetchImpl: this.#fetchImpl, timeoutMs: this.#timeoutMs,
      method: 'POST', headers: this.#headers, body: JSON.stringify(payload)
    });
  }

  async #authenticate(generation) {
    const requestedAt = this.#now();
    const context = { deviceid: this.#deviceid, ipaddr: '0.0.0.0', version: this.#version };
    const response = await this.#post('/univus-public/mobile/get-access-token', context);
    const access = object(response) && response.code === '00000' && object(response.data) ? response.data : null;
    if (!access || access.domain !== 'PUBLIC' || !credential(access.token)
      || typeof access.userid !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(access.userid)) {
      throw new ProviderError('Guest authentication returned an unexpected response.', { code: 'guest_auth_failed' });
    }
    const accessExpiresAt = expiryFromJwt(access.token, requestedAt + DAY_MS);
    if (accessExpiresAt <= this.#now()) {
      throw new ProviderError('Guest authentication returned an expired token.', { code: 'guest_auth_failed' });
    }
    const initialized = await this.#post('/univus/mobile/buswidget/get-init-data', {
      ...context, domain: access.domain, token: access.token, userid: access.userid
    });
    const tokens = object(initialized) && initialized.code === '00000' && object(initialized.data) && object(initialized.data.tokens)
      ? initialized.data.tokens : null;
    if (!tokens || !credential(tokens.nextbus_token2)) {
      throw new ProviderError('Guest bus initialization returned no valid FMS token.', { code: 'guest_auth_failed' });
    }
    const expiresAt = expiryFromJwt(tokens.nextbus_token2, accessExpiresAt);
    if (expiresAt <= this.#now()) {
      throw new ProviderError('Guest bus initialization returned an expired token.', { code: 'guest_auth_failed' });
    }
    if (this.#generation === generation) {
      this.#token = tokens.nextbus_token2;
      this.#expiresAt = expiresAt;
    }
    return tokens.nextbus_token2;
  }
}

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

// Error messages must never contain provider URLs, response bodies, or credentials.
export class ProviderError extends Error {
  constructor(message, { code = 'provider_error', httpStatus, statusCode, providerCode } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
    if (providerCode !== undefined) this.providerCode = providerCode;
    if (httpStatus !== undefined) this.httpStatus = httpStatus;
    if (statusCode !== undefined) this.statusCode = statusCode;
  }
}

export async function requestProviderJson(url, {
  fetchImpl = globalThis.fetch, timeoutMs = 8000, method = 'GET', headers = {}, body
} = {}) {
  const controller = new AbortController();
  let timer;
  let reader;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reader?.cancel().catch(() => {});
      reject(new ProviderError('Provider request timed out.', { code: 'timeout' }));
    }, timeoutMs);
  });
  try {
    return await Promise.race([timeout, (async () => {
      const response = await fetchImpl(url, {
        method, headers: { Accept: 'application/json', ...headers }, body,
        signal: controller.signal, redirect: 'error'
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new ProviderError(`Provider returned HTTP ${response.status}.`, {
          code: 'http_error', httpStatus: response.status, statusCode: response.status
        });
      }
      if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) {
        await response.body?.cancel();
        throw new ProviderError('Provider response is too large.', { code: 'response_too_large' });
      }
      reader = response.body?.getReader();
      if (!reader) throw new ProviderError('Provider response is empty.', { code: 'invalid_response' });
      let size = 0;
      const chunks = [];
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_RESPONSE_BYTES) {
            await reader.cancel();
            throw new ProviderError('Provider response is too large.', { code: 'response_too_large' });
          }
          chunks.push(Buffer.from(value));
        }
      } finally {
        reader.releaseLock();
        reader = undefined;
      }
      try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw new ProviderError('Provider returned invalid JSON.', { code: 'invalid_json' }); }
    })()]);
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    if (controller.signal.aborted) throw new ProviderError('Provider request timed out.', { code: 'timeout' });
    throw new ProviderError('Unable to reach the live provider.', { code: 'network_error' });
  } finally { clearTimeout(timer); }
}

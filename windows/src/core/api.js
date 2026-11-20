// Talks to the Kiosk server (or this site's relay) the way a TV does: the same
// /api/player/* calls, with this PC's token. Errors become ApiError with the HTTP
// status (null when the server couldn't be reached at all).

class ApiError extends Error {
  constructor(message, status = null) {
    super(message);
    this.status = status;
  }
}

function normaliseServerUrl(typed) {
  let text = String(typed || '').trim().replace(/\/+$/, '');
  if (!text) return '';
  if (!/^https?:\/\//i.test(text)) text = `http://${text}`;
  try {
    const url = new URL(text);
    if (url.protocol === 'http:' && !url.port) url.port = '3000';
    return url.toString().replace(/\/+$/, '');
  } catch {
    return '';
  }
}

function createApi({ baseUrl, token = null, fetchImpl = fetch, timeoutMs = 15_000 }) {
  let currentToken = token;

  async function call(method, path, body) {
    let res;
    try {
      res = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: {
          ...(currentToken ? { authorization: `Bearer ${currentToken}` } : {}),
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new ApiError('Can’t reach the Kiosk server. Check the network and the server address.', null);
    }
    let data = null;
    try { data = await res.json(); } catch { /* not JSON */ }
    if (!res.ok) throw new ApiError((data && data.error) || `The server answered ${res.status}`, res.status);
    if (data === null) throw new ApiError('The server sent something unexpected', res.status);
    return data;
  }

  return {
    get token() { return currentToken; },
    set token(value) { currentToken = value; },
    config: () => call('GET', '/api/config'),
    register: (info) => call('POST', '/api/player/register', { kind: 'browser', ...info }),
    status: () => call('GET', '/api/player/status'),
    playlist: () => call('GET', '/api/player/playlist'),
    heartbeat: (info) => call('POST', '/api/player/heartbeat', info),
    // See screen (0.13.0): { jpeg: base64 } or { error }.
    screenshot: (id, body) => call('POST', `/api/player/screenshot/${encodeURIComponent(id)}`, body),
  };
}

module.exports = { createApi, ApiError, normaliseServerUrl };

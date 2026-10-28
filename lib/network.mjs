/**
 * Network/proxy failure detection for the doctor preflight. Node.js >=22.15;
 * no runtime dependencies.
 *
 * The browser's own network errors are the authoritative signal: a failed
 * top-level navigation produces Network.loadingFailed (type "Document") and a
 * chrome-error:// page with the net error code. Classifying those lets the
 * preflight fail in seconds with an actionable message instead of waiting for a
 * long task timeout.
 */

/** Raw net error codes grouped by category. Codes are stored without prefix. */
export const NETWORK_ERROR_KINDS = {
  proxy: [
    'PROXY_CONNECTION_FAILED',
    'TUNNEL_CONNECTION_FAILED',
    'SOCKS_CONNECTION_FAILED',
    'SOCKS_CONNECTION_HOST_UNREACHABLE',
    'PROXY_CERTIFICATE_INVALID',
    'NO_SUPPORTED_PROXIES',
    'PROXY_AUTH_UNSUPPORTED',
    'PROXY_HTTP_1_1_REQUIRED',
  ],
  offline: ['INTERNET_DISCONNECTED', 'NETWORK_STATE_CHANGED'],
  connection: [
    'CONNECTION_CLOSED',
    'CONNECTION_RESET',
    'CONNECTION_REFUSED',
    'CONNECTION_ABORTED',
    'CONNECTION_FAILED',
  ],
  timeout: ['TIMED_OUT', 'CONNECTION_TIMED_OUT'],
  dns: ['NAME_NOT_RESOLVED', 'HOST_RESOLVER_QUEUE_TOO_LARGE', 'HOST_RESOLVER_FAILED'],
  unreachable: ['ADDRESS_UNREACHABLE', 'NETWORK_CHANGED', 'NETWORK_IO_SUSPENDED'],
  blocked: ['NETWORK_ACCESS_DENIED', 'BLOCKED_BY_CLIENT', 'BLOCKED_BY_RESPONSE', 'BLOCKED_BY_CSP'],
};

/** Strip net:: / ERR_ prefixes and upper-case a raw error code. */
export function normalizeNetworkCode(errorText) {
  if (!errorText) return null;
  let code = String(errorText).trim();
  if (!code) return null;
  code = code.replace(/^net::/, '').replace(/^ERR_/, '');
  return code.toUpperCase();
}

/**
 * Classify a raw net error string (e.g. "net::ERR_PROXY_CONNECTION_FAILED")
 * into { kind, code, raw }. Returns null for empty input.
 */
export function classifyNetworkError(errorText) {
  const code = normalizeNetworkCode(errorText);
  if (!code) return null;
  for (const [kind, codes] of Object.entries(NETWORK_ERROR_KINDS)) {
    if (codes.includes(code)) return { kind, code: `ERR_${code}`, raw: String(errorText) };
  }
  return { kind: 'unknown', code: `ERR_${code}`, raw: String(errorText) };
}

const KIND_MESSAGES = {
  proxy: '代理服务器连接失败。请确认代理已开启、节点可用，然后重试。',
  offline: '网络已断开。请检查网络连接后重试。',
  connection: '连接被关闭。若该站点需要代理访问，请检查代理节点；否则检查网络。',
  timeout: '连接超时。若该站点需要代理访问，请检查代理节点或稍后重试。',
  dns: '域名解析失败。若该站点需要代理访问，请检查代理设置。',
  unreachable: '目标地址不可达。请检查网络或代理后重试。',
  blocked: '网络请求被拦截。请检查防火墙、代理或安全软件。',
  unknown: '网络请求失败。请检查网络或代理后重试。',
};

/** Human-readable, actionable message for a network classification. */
export function networkErrorMessage(classification) {
  if (!classification) return '网络请求失败。';
  const base = KIND_MESSAGES[classification.kind] || KIND_MESSAGES.unknown;
  return `${base}（${classification.code}）`;
}

/**
 * Page expression: read the net error code from a chrome-error:// page, or null
 * when the page is not a network error page. Works for any CDP client.
 */
export const ERROR_PAGE_JS = `(() => {
  if (location.protocol !== 'chrome-error:') return null;
  const text = document.body ? document.body.innerText : '';
  const match = text.match(/(ERR_[A-Z0-9_]+|net::[A-Z0-9_]+)/);
  return match ? match[0] : 'ERR_FAILED';
})()`;

/** Read and classify a chrome-error page; null when the page is not an error. */
export async function readErrorPage(page) {
  if (!page || typeof page.evaluate !== 'function') return null;
  const raw = await page.evaluate(ERROR_PAGE_JS).catch(() => null);
  return classifyNetworkError(raw);
}

/**
 * Watch for a main-frame Document failing to load over CDP. Requires a client
 * exposing on() (the bundled CDPClient). Returns { promise, stop }; the promise
 * resolves with a classification once a top-level Document fails.
 */
export function watchMainDocumentFailure(client, sid) {
  let off = null;
  const promise = new Promise((resolve) => {
    if (typeof client?.on !== 'function') return;
    off = client.on(
      'Network.loadingFailed',
      (params) => {
        if (params?.type !== 'Document') return;
        const classified = classifyNetworkError(params.errorText);
        if (classified) resolve(classified);
      },
      sid,
    );
  });
  return {
    promise: promise.then((c) => {
      off?.();
      return c;
    }),
    stop: () => off?.(),
  };
}

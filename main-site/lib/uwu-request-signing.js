// Shared client-side request signing for UwU PWAs.
(function (global) {
  const STORAGE_KEY = 'uwu_signing_key';

  function hexToBytes(hex) {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
    return bytes;
  }

  function bytesToHex(bytes) {
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  async function hmacHex(signingKeyHex, message) {
    const cryptoKey = await crypto.subtle.importKey(
      'raw', hexToBytes(signingKeyHex), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    const sig = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(message));
    return bytesToHex(new Uint8Array(sig));
  }

  function storeSigningKey(signingKey, keyId, persistent = false) {
    const payload = JSON.stringify({ signingKey, keyId });
    const target = persistent ? localStorage : sessionStorage;
    const other  = persistent ? sessionStorage : localStorage;
    target.setItem(STORAGE_KEY, payload);
    other.removeItem(STORAGE_KEY);
  }

  function getSigningKey() {
    for (const storage of [localStorage, sessionStorage]) {
      const raw = storage.getItem(STORAGE_KEY);
      if (!raw) continue;
      try {
        const { signingKey, keyId } = JSON.parse(raw);
        if (signingKey && keyId) return { signingKey, keyId };
      } catch {}
    }
    return null;
  }

  function clearSigningKey() {
    localStorage.removeItem(STORAGE_KEY);
    sessionStorage.removeItem(STORAGE_KEY);
  }

  async function initGuestKey(appId) {
    if (getSigningKey()) return;
    const res = await fetch(`/api/auth/guest-key?app=${encodeURIComponent(appId)}`);
    if (!res.ok) throw new Error('uwu-request-signing: failed to obtain guest signing key');
    const { key_id, signing_key } = await res.json();
    storeSigningKey(signing_key, key_id, false);
  }

  async function signedFetch(url, options = {}) {
    const key = getSigningKey();
    if (!key) throw new Error('uwu-request-signing: no signing key in storage — call initGuestKey() or login first');

    const { signingKey, keyId } = key;
    const method = (options.method || 'GET').toUpperCase();
    const u = new URL(url, location.origin);
    const path = u.pathname + u.search;
    const ts = Date.now().toString();

    const bodyStr = options.body == null ? '' : (typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
    const bodyHash = bodyStr ? await hmacHex(signingKey, bodyStr) : 'empty';
    const token = await hmacHex(signingKey, `${ts}:${method}:${path}:${bodyHash}`);

    const headers = new Headers(options.headers || {});
    headers.set('X-Request-Token', token);
    headers.set('X-Request-TS', ts);
    headers.set('X-Key-ID', keyId);

    return fetch(url, { ...options, headers });
  }

  global.UwuSigning = { storeSigningKey, getSigningKey, clearSigningKey, initGuestKey, signedFetch };
})(window);

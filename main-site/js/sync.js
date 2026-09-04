// Favourite syncing with the Telegram bot.
//
// The browser keeps a random portal id in local storage. That id is the only
// thing that says which Telegram account this browser belongs to, so it is
// treated as a secret: it travels in request bodies and in one header, never in
// a URL, and it is thrown away when the person unlinks.
//
// Local storage stays the source the page renders from. Syncing only keeps that
// list and the account's list the same, so the app works untouched for anyone
// who never links, and keeps working when the network is gone.
//
// Plain script, not a module: published on window.UwuSync.

(function () {
  const APP_KEY = "uwuweather";
  const PORTAL_KEY = `${APP_KEY}.portalId`;
  const SAVED_KEY = `${APP_KEY}.saved`;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const POLL_MS = 2000;
  const POLL_LIMIT = 150; // five minutes, which outlives a ten minute code

  const state = { linked: false, username: null, poller: null, backupCodesLeft: 0 };
  const listeners = [];

  function portalId() {
    let id = localStorage.getItem(PORTAL_KEY);
    if (!id || !UUID.test(id)) {
      id = crypto.randomUUID();
      localStorage.setItem(PORTAL_KEY, id);
    }
    return id;
  }

  // Named so the confirmation in Telegram says something a person recognises.
  // It is a label, not a fingerprint.
  function deviceLabel() {
    const ua = navigator.userAgent;
    const browser =
      /Edg\//.test(ua) ? "Edge" :
      /OPR\//.test(ua) ? "Opera" :
      /Firefox\//.test(ua) ? "Firefox" :
      /Chrome\//.test(ua) ? "Chrome" :
      /Safari\//.test(ua) ? "Safari" : "A browser";
    const os =
      /Windows/.test(ua) ? "Windows" :
      /Android/.test(ua) ? "Android" :
      /iPhone|iPad|iPod/.test(ua) ? "iOS" :
      /Mac OS X/.test(ua) ? "macOS" :
      /Linux/.test(ua) ? "Linux" : "a device";
    return `${browser} on ${os}`;
  }

  // Four decimals, about eleven metres, the same rounding the bot and the API
  // use to decide when two saved places are the same place.
  const key = (p) => `${(Math.round(Number(p.lat) * 1e4) / 1e4).toFixed(4)},`
    + `${(Math.round(Number(p.lon) * 1e4) / 1e4).toFixed(4)}`;

  function readLocal() {
    try {
      const list = JSON.parse(localStorage.getItem(SAVED_KEY) || "[]");
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }

  // What the account is believed to hold. Diffing against this is what turns a
  // saved list into the one or two changes that actually happened, so a stale
  // tab can never speak for places it has simply not heard about yet.
  let lastKnown = readLocal();

  function writeLocal(list) {
    localStorage.setItem(SAVED_KEY, JSON.stringify(list));
    lastKnown = list.slice();
    listeners.forEach((fn) => fn(list));
  }

  async function call(path, body) {
    try {
      const res = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, portal_id: portalId(), label: deviceLabel() })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return { error: data.error || "That did not work. Please try again." };
      return data;
    } catch {
      return { error: "No connection. Please try again in a moment." };
    }
  }

  async function get(path) {
    try {
      const res = await fetch(path, { headers: { "x-portal-id": portalId() } });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return { error: data.error || "That did not work." };
      return data;
    } catch {
      return { error: "No connection." };
    }
  }

  // --- account state ------------------------------------------------------

  async function refresh() {
    // No portal id yet means this browser has never tried to link, so there is
    // nothing to ask about. The app stays exactly as network free as it was.
    if (!localStorage.getItem(PORTAL_KEY)) {
      state.linked = false;
      return false;
    }

    const who = await call("/api/link", { action: "whoami" });
    state.linked = Boolean(who.linked);
    state.username = who.telegram_username || null;
    state.backupCodesLeft = who.backup_codes_left || 0;
    if (state.linked) await mergeUp();
    return state.linked;
  }

  /**
   * Union what this browser has with what the account has. Run on load and
   * right after linking, so a place saved while offline is never dropped and a
   * place saved on the bot arrives here. Places deleted elsewhere stay deleted:
   * the server keeps a tombstone precisely so this cannot undo them.
   */
  async function mergeUp() {
    const res = await call("/api/favourites", { mode: "merge", favourites: readLocal() });
    if (res.linked && Array.isArray(res.favourites)) writeLocal(res.favourites);
    return res;
  }

  /** Mirror a local edit up to the account. Silent when nothing is linked. */
  async function push(list) {
    if (!state.linked) {
      lastKnown = list.slice();
      return;
    }

    const before = new Map(lastKnown.map((p) => [key(p), p]));
    const after = new Map(list.map((p) => [key(p), p]));
    const ops = [];
    for (const [k, place] of after) {
      if (!before.has(k)) ops.push({ op: "add", ...place });
    }
    for (const [k, place] of before) {
      if (!after.has(k)) ops.push({ op: "remove", ...place });
    }

    lastKnown = list.slice();
    if (!ops.length) return;

    const res = await call("/api/favourites", { ops });
    if (res.linked && Array.isArray(res.favourites)) writeLocal(res.favourites);
  }

  async function unlink() {
    await call("/api/link", { action: "unlink" });
    state.linked = false;
    state.username = null;
    localStorage.removeItem(PORTAL_KEY); // a fresh identity for the next link
  }

  // --- linking ------------------------------------------------------------

  function stopPolling() {
    if (state.poller) {
      clearInterval(state.poller);
      state.poller = null;
    }
  }

  function poll(url, onSettled) {
    stopPolling();
    let ticks = 0;
    state.poller = setInterval(async () => {
      ticks += 1;
      if (ticks > POLL_LIMIT) {
        stopPolling();
        onSettled("expired");
        return;
      }
      const res = await get(url);
      if (!res.status || res.status === "pending") return;
      stopPolling();
      onSettled(res.status);
    }, POLL_MS);
  }

  async function startDeepLink(onSettled) {
    const res = await call("/api/link", { action: "start" });
    if (res.error) return res;
    window.open(res.url, "_blank", "noopener");
    poll(`/api/link?action=status&token=${encodeURIComponent(res.token)}`, onSettled);
    return res;
  }

  /**
   * One box takes both kinds of code: six digits from /code, or a backup code
   * for when Telegram cannot be reached at all.
   */
  async function useCode(raw) {
    const text = String(raw || "").trim();
    const digits = text.replace(/\D/g, "");
    const res = digits.length === 6
      ? await call("/api/link", { action: "redeem", code: digits })
      : await call("/api/link", { action: "redeem-backup", code: text });

    if (res.linked) {
      stopPolling();
      state.linked = true;
      await mergeUp();
    }
    return res;
  }

  async function settle(status) {
    if (status !== "claimed") return false;
    state.linked = true;
    await mergeUp();
    return true;
  }

  // --- backup codes -------------------------------------------------------
  //
  // Asked for here, allowed in Telegram, and shown here once. The codes are
  // never written to storage by this page: they live in the DOM until the
  // panel is closed or the page is reloaded.

  async function requestBackupCodes(onSettled) {
    const res = await call("/api/link", { action: "backup-request" });
    if (res.error) return res;
    poll(`/api/link?action=backup-status&id=${encodeURIComponent(res.id)}`,
      async (status) => onSettled(status, res.id));
    return res;
  }

  async function collectBackupCodes(id) {
    const res = await call("/api/link", { action: "backup-collect", id });
    if (Array.isArray(res.codes)) state.backupCodesLeft = res.codes.length;
    return res;
  }

  window.UwuSync = {
    portalId,
    deviceLabel,
    state,
    refresh,
    mergeUp,
    push,
    unlink,
    startDeepLink,
    useCode,
    settle,
    requestBackupCodes,
    collectBackupCodes,
    stopPolling,
    onChange(fn) {
      listeners.push(fn);
    },
    readLocal,
    writeLocal
  };
})();

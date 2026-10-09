// Lightning alerts: a notification when lightning is detected near a saved
// place in a country with an open lightning network (W.LIGHTNING_COUNTRIES:
// Singapore by NEA, Canada by Environment Canada), even with the site closed. The page subscribes to Web Push and
// tells /api/push/devices which places to watch and how close counts; the
// collect cron (api/cron/collect.js) checks each new lightning record and pushes.
// A browser linked to the Telegram bot can also have the bot send them, for the
// places synced with it, through /api/lightning.
//
// The watched places are this browser's saved places in those countries, sent
// again whenever that list changes; the server checks each again. The subscribing follows sg-psi's js/alerts.js.
// Plain script, not a module: published on window.UwuAlerts.

(function () {
  const W = window.UwuWx;
  const { esc, hydrateIcons } = window.UwuUI;
  const Sync = window.UwuSync;

  const API_BASE = "/api/push";
  const PREFS_KEY = "uwuweather.alerts";
  const DEVICE_KEY = "uwuweather.pushDeviceId";
  const RADII = [5, 10, 20];
  const DEFAULTS = { on: false, radiusKm: 10 };

  const $ = (sel) => document.querySelector(sel);

  const PROBLEMS = {
    unsupported: "This browser can't receive notifications. On iPhone or iPad, add UwU Weather to your Home Screen, open it from there, and try again.",
    denied: "Notifications are blocked for this site. Allow them in your browser's site settings, then try again.",
    failed: "Couldn't reach the alerts server. Try again in a minute.",
  };

  function prefs() {
    try {
      const saved = JSON.parse(localStorage.getItem(PREFS_KEY) || "null");
      if (saved && RADII.includes(saved.radiusKm)) return { ...DEFAULTS, ...saved, on: saved.on === true };
    } catch {}
    return { ...DEFAULTS };
  }

  function save(p) {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(p));
    } catch {}
  }

  function deviceId() {
    let id = null;
    try {
      id = localStorage.getItem(DEVICE_KEY);
      if (!id) {
        id = crypto.randomUUID();
        localStorage.setItem(DEVICE_KEY, id);
      }
    } catch {}
    return id || crypto.randomUUID();
  }

  // The country the forecast named for a saved place, for one whose label has
  // no code ("My location"). Set by script.js from its kept copies.
  let countryHint = () => null;

  const watched = () => Sync.readLocal().filter((p) => W.lightningCountry(p, countryHint(p)));

  // "Singapore or Canada", for the panel's wording.
  const COVERED = ["Singapore", "Canada"];
  const coveredText = (joiner) => COVERED.join(` ${joiner} `);

  const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

  // ---------- drawing ----------

  function noteFor(p, places) {
    if (!places.length) return `Save a place in ${coveredText("or")} first: search for it, then press the star.`;
    if (!p.on) return "Alerts are off. Pick how close counts, then turn them on.";
    return `You'll be notified when lightning is detected within ${p.radiusKm} km of ${places.length === 1 ? "this place" : `any of these ${places.length} places`}, at most once every half hour for each.`;
  }

  function show(p, problem) {
    const places = watched();
    const others = Sync.readLocal().length - places.length;
    $("#alertPlaces").innerHTML = places.length
      ? places.map((pl) => `<li><span data-icon="pin"></span>${esc(pl.name)}</li>`).join("")
      : `<li class="muted">No saved places in ${coveredText("or")} yet.</li>`;
    $("#alertPlaces").hidden = false;
    $("#alertOthers").hidden = !others;
    $("#alertOthers").textContent = `${others} saved place${others === 1 ? " is" : "s are"} outside ${coveredText("and")}, where no open network reports lightning, so ${others === 1 ? "it isn't" : "they aren't"} watched.`;
    hydrateIcons($("#alertPlaces"));

    document.querySelectorAll("[data-radius]").forEach((btn) => {
      const on = Number(btn.dataset.radius) === p.radiusKm;
      btn.classList.toggle("active", on);
      btn.setAttribute("aria-pressed", String(on));
    });
    const toggle = $("#alertsToggle");
    toggle.textContent = p.on ? "Turn alerts off" : "Turn alerts on";
    toggle.classList.toggle("secondary", p.on);
    toggle.disabled = !p.on && !places.length;
    $("#alertsTest").hidden = !p.on;
    note(problem ? PROBLEMS[problem] : noteFor(p, places), problem ? "bad" : "");

    // Alerts can only watch saved places in a covered country. With none saved, the bell
    // would open a panel with nothing to turn on, so it stays out of the tray.
    $("#alertsBtn").hidden = !places.length;

    const icon = $("#alertsBtn [data-icon]");
    icon.setAttribute("data-icon", p.on || tg.enabled ? "bell-on" : "bell");
    $("#alertsBtn").setAttribute("aria-label", p.on || tg.enabled ? "Lightning alerts, on" : "Lightning alerts");
    hydrateIcons($("#alertsBtn"));
  }

  function note(text, tone) {
    $("#alertsNote").textContent = text;
    $("#alertsNote").dataset.tone = tone;
  }

  // ---------- web push ----------

  // navigator.serviceWorker.ready never settles if registration failed, so it
  // gets a time limit.
  function readyRegistration() {
    return Promise.race([
      navigator.serviceWorker.ready,
      new Promise((_, reject) => setTimeout(() => reject(new Error("service worker not ready")), 10_000)),
    ]);
  }

  async function fetchPublicKey() {
    const res = await fetch(`${API_BASE}/vapid-key`);
    if (!res.ok) throw new Error(`alerts server replied ${res.status}`);
    const { publicKey } = await res.json();
    const b64 = (publicKey + "=".repeat((4 - (publicKey.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
    return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  }

  async function subscription() {
    const reg = await readyRegistration();
    return (await reg.pushManager.getSubscription()) ?? await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: await fetchPublicKey(),
    });
  }

  async function subscribe(p) {
    const sub = await subscription();
    const res = await fetch(`${API_BASE}/devices/${deviceId()}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subscription: sub.toJSON(), places: watched(), radiusKm: p.radiusKm }),
    });
    if (!res.ok) throw new Error(`alerts server replied ${res.status}`);
  }

  // Unsubscribe and have the server forget this device. Browsers don't let a page
  // revoke notification permission itself; this is the closest it gets.
  async function unsubscribe() {
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      await (await reg?.pushManager.getSubscription())?.unsubscribe();
    } catch (err) {
      console.warn("unsubscribe failed:", err);
    }
    try {
      await fetch(`${API_BASE}/devices/${deviceId()}`, { method: "DELETE" });
    } catch (err) {
      // The subscription is already gone, so the server drops the device the
      // first time a push to it fails.
      console.warn("device delete failed:", err);
    }
  }

  let busy = false;

  async function apply(change) {
    if (busy) return;
    const previous = prefs();
    const next = { ...previous, ...change };

    if (!next.on) {
      save(next);
      show(next);
      if (previous.on && pushSupported()) await unsubscribe();
      return;
    }
    if (!pushSupported()) return show({ ...next, on: false }, "unsupported");

    busy = true;
    try {
      const perm = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
      if (perm !== "granted") return show({ ...next, on: false }, "denied");
      show(next);
      await subscribe(next);
      save(next);
    } catch (err) {
      console.warn("lightning alerts unavailable:", err);
      show(previous, "failed");
    } finally {
      busy = false;
    }
  }

  const postTest = () => fetch(`${API_BASE}/devices/${deviceId()}`, { method: "POST" });

  // Has the server push to this device the way a real alert comes, so a missing
  // key, a dead subscription or muted notifications show up now, not mid-storm.
  async function test() {
    if (busy) return;
    busy = true;
    $("#alertsTest").disabled = true;
    try {
      let res = await postTest();
      if (res.status === 404 || res.status === 410) {
        if (res.status === 410) await (await (await readyRegistration()).pushManager.getSubscription())?.unsubscribe();
        await subscribe(prefs());
        res = await postTest();
      }
      if (res.ok) {
        note("Test alert sent. Nothing within a minute? Check that notifications from this browser aren't muted or held back by Do Not Disturb.", "");
      } else if (res.status === 429) {
        note("A test alert was just sent. Try again in a few seconds.", "");
      } else {
        const { error } = await res.json().catch(() => ({}));
        note(`Couldn't send a test alert: ${error || `the server replied ${res.status}`}.`, "bad");
      }
    } catch (err) {
      console.warn("test alert failed:", err);
      note(PROBLEMS.failed, "bad");
    } finally {
      busy = false;
      $("#alertsTest").disabled = false;
    }
  }

  // Re-sends the choice on every load, which also refreshes the subscription. A
  // permission revoked in the browser's settings turns alerts off here too.
  function resync() {
    const p = prefs();
    if (!p.on) return;
    if (!pushSupported() || Notification.permission !== "granted") {
      const off = { ...p, on: false };
      save(off);
      show(off);
      return;
    }
    subscribe(p).catch((err) => console.warn("lightning alerts resync failed:", err));
  }

  // ---------- Telegram ----------

  const tg = { linked: false, enabled: false, places: 0, busy: false };

  async function tgCall(body) {
    const res = await fetch("/api/lightning", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, portal_id: Sync.portalId() }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `the server replied ${res.status}`);
    return data;
  }

  function showTelegram(problem) {
    $("#tgLinked").hidden = !tg.linked;
    $("#tgUnlinked").hidden = tg.linked;
    if (!tg.linked) return;
    const btn = $("#tgToggle");
    btn.textContent = tg.enabled ? "Stop Telegram messages" : "Send them on Telegram too";
    btn.classList.toggle("secondary", tg.enabled);
    btn.disabled = tg.busy;
    $("#tgNote").textContent = problem
      || (tg.enabled
        ? `The bot messages you about lightning within ${prefs().radiusKm} km of your synced places in ${coveredText("and")} (${tg.places} of them).`
        : `Uses the places synced with the bot, ${tg.places} of them in ${coveredText("or")}.`);
    $("#tgNote").dataset.tone = problem ? "bad" : "";
    show(prefs());
  }

  async function refreshTelegram() {
    tg.linked = Boolean(Sync.state.linked);
    if (!tg.linked) return showTelegram();
    try {
      Object.assign(tg, await tgCall({ action: "get" }));
      tg.linked = tg.linked !== false;
      showTelegram();
    } catch (err) {
      showTelegram(`Couldn't check the Telegram setting: ${err.message}.`);
    }
  }

  async function setTelegram(enabled) {
    if (tg.busy) return;
    tg.busy = true;
    showTelegram();
    try {
      Object.assign(tg, await tgCall({ action: "set", enabled, radiusKm: prefs().radiusKm }));
      tg.busy = false;
      showTelegram();
    } catch (err) {
      tg.busy = false;
      showTelegram(`Couldn't change it: ${err.message}.`);
    }
  }

  // ---------- wiring ----------

  function init({ countryOf } = {}) {
    if (countryOf) countryHint = countryOf;
    $("#alertRadius").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-radius]");
      if (!btn) return;
      const radiusKm = Number(btn.dataset.radius);
      const p = prefs();
      if (p.on) apply({ radiusKm });
      else {
        save({ ...p, radiusKm });
        show(prefs());
      }
      if (tg.enabled) setTelegram(true);
    });
    $("#alertsToggle").addEventListener("click", () => apply({ on: !prefs().on }));
    $("#alertsTest").addEventListener("click", test);
    $("#tgToggle").addEventListener("click", () => setTelegram(!tg.enabled));

    show(prefs());
    resync();
  }

  // The saved places changed: the watch list follows.
  function placesChanged() {
    show(prefs());
    resync();
    if (tg.linked) refreshTelegram();
  }

  // A forecast arrived that may name a saved place's country: the bell and the
  // panel's list follow, without sending anything to the server.
  const redraw = () => show(prefs());

  window.UwuAlerts = { init, placesChanged, refreshTelegram, redraw };
})();

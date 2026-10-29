// The info modal: the tray's info button opens it, with the credits (the footer's, before) and a
// button naming the service worker's version. Clicked three times in a row, that button unlocks
// the secret languages (i18n/switcher.js), with a toast and confetti.
// Plain script, not a module; publishes nothing.

(function () {
  const MODAL_ID = "infoModal";
  // The most time between two clicks that still counts them as one run.
  const CLICK_GAP_MS = 500;
  const VERSION_TIMEOUT_MS = 1500;
  const TOAST_MS = 3200;

  const { openModal } = window.UwuUI;
  const { t, onChange, unlockSecrets } = window.UwuI18n;

  const infoBtn = document.getElementById("infoBtn");
  const versionBtn = document.getElementById("versionBtn");
  if (!infoBtn || !versionBtn) return;

  // ---------- the version ----------

  let version = null;

  // Asked of the worker serving this page, which answers in sw.js's message handler. A worker
  // from before it answered, or none at all (a first visit, a browser without them), is "—".
  function askVersion() {
    if (!("serviceWorker" in navigator)) return Promise.resolve(null);
    const worker = navigator.serviceWorker.controller;
    const ask = (w) =>
      new Promise((resolve) => {
        const channel = new MessageChannel();
        const timer = setTimeout(() => resolve(null), VERSION_TIMEOUT_MS);
        channel.port1.onmessage = (e) => {
          clearTimeout(timer);
          resolve(typeof e.data === "string" ? e.data : null);
        };
        w.postMessage({ type: "version" }, [channel.port2]);
      });
    if (worker) return ask(worker);
    return navigator.serviceWorker.getRegistration().then((reg) => (reg?.active ? ask(reg.active) : null));
  }

  function renderVersion() {
    versionBtn.textContent = t("info.version", { version: version || "—" });
  }

  infoBtn.addEventListener("click", () => {
    renderVersion();
    openModal(MODAL_ID);
    askVersion()
      .catch(() => null)
      .then((v) => {
        version = v;
        renderVersion();
      });
  });
  onChange(renderVersion);

  // ---------- three clicks ----------

  // Counted by hand rather than from the click's `detail`, which stays 0 for a keyboard and
  // isn't kept by every mobile browser.
  let clicks = 0;
  let lastClick = 0;
  versionBtn.addEventListener("click", () => {
    const now = performance.now();
    clicks = now - lastClick <= CLICK_GAP_MS ? clicks + 1 : 1;
    lastClick = now;
    if (clicks < 3) return;
    clicks = 0;
    unlockSecrets();
    toast(t("info.secret-unlocked"));
    confetti(versionBtn);
  });

  // ---------- toast ----------

  function toast(message) {
    document.querySelector(".toast")?.remove();
    const el = document.createElement("div");
    el.className = "toast";
    el.setAttribute("role", "status");
    document.body.appendChild(el);
    // Written once the region is in the page, so a screen reader announces it.
    requestAnimationFrame(() => (el.textContent = message));
    setTimeout(() => {
      el.classList.add("is-leaving");
      el.addEventListener("animationend", () => el.remove(), { once: true });
    }, TOAST_MS);
  }

  // ---------- confetti ----------

  const COLOURS = ["#facc15", "#fb7185", "#38bdf8", "#4ade80", "#c084fc", "#fb923c"];
  const PIECES = 160;
  const LIFE_MS = 3500;

  // A burst from the middle of `from`, falling under gravity. None for anybody who asked for
  // less motion; the toast still says it.
  function confetti(from) {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const canvas = document.createElement("canvas");
    canvas.className = "confetti";
    canvas.setAttribute("aria-hidden", "true");
    const w = innerWidth;
    const h = innerHeight;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);
    document.body.appendChild(canvas);

    const box = from.getBoundingClientRect();
    const x0 = box.left + box.width / 2;
    const y0 = box.top + box.height / 2;
    const pieces = Array.from({ length: PIECES }, () => {
      // Upwards, in a fan about 130 degrees wide.
      const angle = -Math.PI / 2 + (Math.random() - 0.5) * 2.3;
      const speed = 7 + Math.random() * 9;
      return {
        x: x0,
        y: y0,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        w: 6 + Math.random() * 5,
        h: 4 + Math.random() * 4,
        spin: Math.random() * Math.PI,
        vspin: (Math.random() - 0.5) * 0.3,
        flutter: Math.random() * Math.PI * 2,
        colour: COLOURS[Math.floor(Math.random() * COLOURS.length)],
      };
    });

    const start = performance.now();
    let last = start;
    function frame(now) {
      // In steps of a 60 Hz frame, so a 120 Hz screen doesn't throw them twice as fast.
      const f = Math.min((now - last) / (1000 / 60), 3);
      last = now;
      const age = now - start;
      ctx.clearRect(0, 0, w, h);
      ctx.globalAlpha = age > LIFE_MS - 600 ? Math.max(0, (LIFE_MS - age) / 600) : 1;
      let visible = 0;
      for (const p of pieces) {
        p.vx *= Math.pow(0.985, f);
        p.vy = p.vy * Math.pow(0.985, f) + 0.28 * f;
        p.x += p.vx * f;
        p.y += p.vy * f;
        p.spin += p.vspin * f;
        p.flutter += 0.12 * f;
        if (p.y > h + 20) continue;
        visible++;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.spin);
        // Turning over as it falls: the piece narrows and widens.
        ctx.scale(Math.cos(p.flutter), 1);
        ctx.fillStyle = p.colour;
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.restore();
      }
      if (visible && age < LIFE_MS) requestAnimationFrame(frame);
      else canvas.remove();
    }
    requestAnimationFrame(frame);
  }
})();

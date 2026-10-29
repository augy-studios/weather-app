// The language switcher (sgmap-explorer's docs/i18n-retrofit-spec.md 7 and 8): a glass button in
// the tray, the globe and the language's code, and the langModal in index.html listing every
// language by its own name. Picking one switches the page in place; Escape, Close or the backdrop
// (wired by script.js like every other modal) leave it as it was.
//
// Each language has its country's flag on the left (locales.js's `flag`), and the secret ones a
// yellow star. Those are listed only once unlockSecrets() has run (the info modal's version
// button, js/info.js), remembered on this device.

import { getLocale, getLocales, onChange, setLocale, t } from "./i18n.js";

const MODAL_ID = "langModal";
const SECRET_KEY = "uwuweather.secret-languages";
// For a browser that won't store it: unlocked until the page closes.
let unlockedNow = false;

export function secretsUnlocked() {
  try { return localStorage.getItem(SECRET_KEY) === "1"; } catch { return false; }
}
export function unlockSecrets() {
  try { localStorage.setItem(SECRET_KEY, "1"); } catch { /* unlocked for this page view only */ }
  unlockedNow = true;
}

// A star rather than a flag: the secret languages have no country. Filled in the CSS (.lang-star).
const STAR = '<svg class="lang-flag lang-star" viewBox="0 0 24 24" width="24" height="18" aria-hidden="true"><path d="m12 2.6 2.9 5.9 6.5.9-4.7 4.6 1.1 6.4L12 17.4l-5.8 3 1.1-6.4-4.7-4.6 6.5-.9z"/></svg>';

function flagOf(l) {
  if (l.secret) return STAR;
  if (!l.flag) return "";
  return `<img class="lang-flag" src="/vendor/flags/${l.flag}.svg" alt="" width="24" height="18" decoding="async">`;
}

function renderButton(btn) {
  const { icon } = window.UwuIcons;
  const entry = getLocales().find((l) => l.code === getLocale());
  btn.innerHTML = `${icon("globe")}<span class="lang-code">${entry ? (entry.short || entry.code).toUpperCase() : ""}</span>`;
  const label = t("a11y.language-switcher", { name: entry?.name || "" });
  btn.setAttribute("aria-label", label);
  btn.title = label;
}

function renderList(list) {
  const { icon } = window.UwuIcons;
  const active = getLocale();
  const unlocked = unlockedNow || secretsUnlocked();
  list.innerHTML = "";
  // The language in use is always listed, secret or not, so the list never loses its selection.
  for (const l of getLocales().filter((l) => !l.secret || unlocked || l.code === active)) {
    const li = document.createElement("li");
    li.setAttribute("role", "option");
    li.dataset.locale = l.code;
    li.lang = l.code;
    li.dir = l.dir;
    li.tabIndex = l.code === active ? 0 : -1;
    li.setAttribute("aria-selected", String(l.code === active));
    li.innerHTML = `<span class="lang-label">${flagOf(l)}<span>${l.name.replace(/[&<>]/g, "")}</span></span>${l.code === active ? icon("check") : ""}`;
    list.appendChild(li);
  }
}

export function mountSwitcher(btn) {
  const backdrop = document.getElementById(MODAL_ID);
  if (!btn || !backdrop) return;
  const { openModal, closeModal } = window.UwuUI;
  const list = backdrop.querySelector(".lang-list");
  renderButton(btn);
  btn.setAttribute("aria-haspopup", "dialog");
  btn.setAttribute("aria-expanded", "false");

  const choose = (code) => {
    closeModal(MODAL_ID);
    if (code && code !== getLocale()) setLocale(code);
  };

  btn.addEventListener("click", () => {
    renderList(list);
    btn.setAttribute("aria-expanded", "true");
    openModal(MODAL_ID);
    list.querySelector('[aria-selected="true"]')?.focus();
  });
  // However it closes (a pick, Close, Escape, the backdrop), the button says so.
  new MutationObserver(() => {
    if (backdrop.classList.contains("hidden")) btn.setAttribute("aria-expanded", "false");
  }).observe(backdrop, { attributes: true, attributeFilter: ["class"] });

  list.addEventListener("click", (e) => {
    const row = e.target.closest("[data-locale]");
    if (row) choose(row.dataset.locale);
  });
  list.addEventListener("keydown", (e) => {
    const rows = [...list.querySelectorAll("[data-locale]")];
    const i = rows.indexOf(document.activeElement);
    let next = null;
    if (e.key === "ArrowDown") next = Math.min(rows.length - 1, i + 1);
    else if (e.key === "ArrowUp") next = Math.max(0, i - 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = rows.length - 1;
    else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (rows[i]) choose(rows[i].dataset.locale);
      return;
    } else if (e.key.length === 1 && /\S/.test(e.key)) {
      // The next language starting with the letter typed.
      const k = e.key.toLowerCase();
      const order = [...rows.slice(i + 1), ...rows.slice(0, i + 1)];
      const hit = order.find((r) => r.textContent.trim().toLowerCase().startsWith(k));
      if (hit) next = rows.indexOf(hit);
    }
    if (next == null) return;
    e.preventDefault();
    rows.forEach((r, n) => (r.tabIndex = n === next ? 0 : -1));
    rows[next].focus();
  });

  onChange(() => renderButton(btn));
}

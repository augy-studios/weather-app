// The i18n runtime, as sgmap-explorer's docs/i18n-retrofit-spec.md section 15 gives it: init, t,
// setLocale, and the data-i18n bindings. The same file as sgmap-explorer's.
let locales = {};
let registry = [];
let active = 'en';
let fallback = 'en';
let storageKey = 'locale';
let debug = false;
const listeners = new Set();

function warn(...args) { if (debug) console.warn('[i18n]', ...args); }

function readStored() {
  try { return localStorage.getItem(storageKey); } catch { return null; }
}
function writeStored(code) {
  try { localStorage.setItem(storageKey, code); } catch { /* not remembered */ }
}

function known(code) {
  return registry.find(l => l.code.toLowerCase() === String(code).toLowerCase());
}

function detect() {
  const stored = readStored();
  if (stored && known(stored)) return known(stored).code;
  for (const tag of navigator.languages || [navigator.language]) {
    const exact = known(tag);
    if (exact) return exact.code;
    const base = known(tag.split('-')[0]);
    if (base) return base.code;
  }
  return fallback;
}

function interpolate(str, params) {
  return str.replace(/\{(\w+)\}/g, (m, name) => {
    if (params && name in params) return String(params[name]);
    warn('unmatched placeholder', name, 'in', str);
    return m;
  });
}

function lookup(key, code) {
  const table = locales[code];
  return table && Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

export function t(key, params) {
  let k = key;
  if (params && typeof params.count === 'number') {
    const cat = new Intl.PluralRules(active).select(params.count);
    if (lookup(`${key}.${cat}`, active) !== undefined) k = `${key}.${cat}`;
    else if (lookup(`${key}.other`, active) !== undefined) k = `${key}.other`;
  }
  let str = lookup(k, active);
  if (str === undefined) {
    warn('missing key', k, 'in', active);
    str = lookup(k, fallback);
  }
  if (str === undefined) {
    warn('missing key', k, 'in fallback', fallback);
    return key;
  }
  return interpolate(str, params);
}

export function applyTo(root = document) {
  const params = el => {
    const raw = el.getAttribute('data-i18n-params');
    if (!raw) return undefined;
    try { return JSON.parse(raw); } catch { warn('bad data-i18n-params on', el); return undefined; }
  };
  root.querySelectorAll('[data-i18n]').forEach(el => {
    el.textContent = t(el.getAttribute('data-i18n'), params(el));
  });
  root.querySelectorAll('[data-i18n-attr]').forEach(el => {
    el.getAttribute('data-i18n-attr').split(',').forEach(pair => {
      const [attr, key] = pair.split(':').map(s => s.trim());
      if (attr && key) el.setAttribute(attr, t(key, params(el)));
    });
  });
}

function applyDocument() {
  const entry = known(active);
  document.documentElement.lang = active;
  document.documentElement.dir = entry && entry.dir ? entry.dir : 'ltr';
  applyTo(document);
}

export function setLocale(code) {
  const entry = known(code);
  if (!entry || entry.code === active) return;
  active = entry.code;
  writeStored(active);
  applyDocument();
  listeners.forEach(fn => fn(active));
}

export function getLocale() { return active; }
export function getLocales() { return registry.slice(); }
export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

export function init(opts) {
  locales = opts.locales;
  registry = opts.registry;
  fallback = opts.defaultLocale || 'en';
  storageKey = opts.storageKey || 'locale';
  debug = opts.debug ?? ['localhost', '127.0.0.1'].includes(location.hostname);
  active = detect();
  applyDocument();
  return active;
}

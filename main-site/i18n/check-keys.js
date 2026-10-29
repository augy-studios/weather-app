// Checks every language file against en.json (sgmap-explorer's docs/i18n-retrofit-spec.md 11.2): keys missing or
// extra, plural families without .other, placeholders that differ, empty values, and (as a
// warning) values the same as the English. With --usage, also every t("...") and data-i18n key
// in the site's HTML and JS that en.json hasn't got, and en.json keys used nowhere.
//
// Run: node i18n/check-keys.js [--usage]   (from main-site). Exits 1 on any error.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const site = join(here, "..");
const PLURAL = /\.(zero|one|two|few|many|other)$/;
const load = (f) => JSON.parse(readFileSync(join(here, f), "utf8"));
const holes = (s) => new Set([...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]));
const sameSet = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));
const base = (k) => k.replace(PLURAL, "");

const en = load("en.json");
let errors = 0;
const err = (msg) => {
  errors++;
  console.error(`error: ${msg}`);
};

for (const [k, v] of Object.entries(en)) {
  if (typeof v !== "string") err(`en.json ${k} is not a string`);
  else if (!v) err(`en.json ${k} is empty`);
}
const enBases = new Set(Object.keys(en).map(base));
for (const b of enBases) if (Object.keys(en).some((k) => k !== b && base(k) === b) && !(`${b}.other` in en)) err(`en.json plural ${b} has no .other`);

for (const file of readdirSync(here).filter((f) => f.endsWith(".json") && f !== "en.json")) {
  const loc = load(file);
  const keys = Object.keys(loc);
  const bases = new Set(keys.map(base));
  for (const b of enBases) if (!bases.has(b)) err(`${file} is missing ${b}`);
  for (const b of bases) if (!enBases.has(b)) err(`${file} has ${b}, which en.json hasn't`);
  for (const k of keys) {
    const v = loc[k];
    if (typeof v !== "string" || !v) err(`${file} ${k} is empty or not a string`);
    if (PLURAL.test(k) && !(`${base(k)}.other` in loc)) err(`${file} plural ${base(k)} has no .other`);
    const enValue = en[k] ?? en[`${base(k)}.other`];
    if (enValue != null && !sameSet(holes(v), holes(enValue))) err(`${file} ${k} placeholders differ from English`);
    if (en[k] === v) console.warn(`warn: ${file} ${k} is the same as the English`);
  }
}

if (process.argv.includes("--usage")) {
  const used = new Set();
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (["node_modules", "vendor", "api", "lib", "migrations", "images", ".well-known", ".vercel"].includes(name)) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(html|js)$/.test(name) && name !== "check-keys.js") {
        const src = readFileSync(p, "utf8");
        for (const m of src.matchAll(/\bt\(\s*["'`]([a-z0-9.-]+)["'`]/g)) used.add(m[1]);
        for (const m of src.matchAll(/data-i18n="([a-z0-9.-]+)"/g)) used.add(m[1]);
        for (const m of src.matchAll(/data-i18n-attr="([^"]+)"/g)) for (const pair of m[1].split(",")) used.add(pair.split(":")[1]?.trim());
        // Keys named in code as `i18n: "..."` or key: "x.y" for t() calls made with a variable.
        for (const m of src.matchAll(/\b(?:label|desc|i18n|key|text|title)Key:\s*["']([a-z0-9.-]+)["']/g)) used.add(m[1]);
      }
    }
  };
  walk(site);
  used.delete(undefined);
  for (const k of used) if (!(k in en) && !(`${k}.other` in en)) err(`used in the site but not in en.json: ${k}`);
  // Keys the code builds from a value (t(`region.${r}`)), which a scan for string literals can't see.
  const DYNAMIC = ["theme.swatch.", "offline.pack.", "offline.region.", "offline.note.", "wx.code.", "wx.compass.", "wx.uv.", "wx.uv-advice.", "alerts.bell.", "alerts.covered.", "alerts.problem.", "alerts.telegram.", "alerts.toggle.", "map.pin.", "map.popup.", "map.strike."];
  for (const b of enBases) if (!used.has(b) && !DYNAMIC.some((p) => b.startsWith(p))) console.warn(`warn: en.json ${b} isn't used anywhere the scan can see`);
}

if (errors) {
  console.error(`${errors} problem(s).`);
  process.exit(1);
}
console.log("i18n keys OK.");

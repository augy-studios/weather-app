// Every language the app ships, as static JSON imports: all of them in memory before the first
// render, so switching is instant and works offline. en.json is the source of truth; every other
// file has exactly its keys (check-keys.js). Adding a language is one import line, one entry in
// `locales` and one in `registry`, and the file in sw.js's precache list. For example:
//
//   import zh from "./zh-SG.json" with { type: "json" };
//   export const locales = { en, zh };
//   { code: "zh", name: "中文", dir: "ltr" },
import en from "./en.json" with { type: "json" };

export const locales = { en };

export const registry = [
  { code: "en", name: "English", dir: "ltr" }
];

// Every language the app ships, as static JSON imports: all of them in memory before the first
// render, so switching is instant and works offline. en.json is the source of truth; every other
// file has exactly its keys (check-keys.js). Adding a language is one import line, one entry in
// `locales` and one in `registry`, and the file in sw.js's precache list. For example:
//
//   import zh from "./zh-SG.json" with { type: "json" };
//   export const locales = { en, zh };
//   { code: "zh", name: "中文", dir: "ltr", flag: "sg" },
//
// `locales` is keyed by the registry's code exactly ("zh-CN", not zhCN): i18n.js looks a table up
// by the active code, and a key that differs falls back to English without a word.
//
// `flag` names the language's country of origin, drawn from vendor/flags/<flag>.svg beside its
// name in the switcher (add the file to sw.js's precache list too). `secret` languages have a star
// instead, and are listed only once unlocked from the info modal (js/info.js).
import en from "./en.json" with { type: "json" };
import zhCN from "./zh-CN.json" with { type: "json" };
import ms from "./ms.json" with { type: "json" };
import ta from "./ta.json" with { type: "json" };
import id from "./id.json" with { type: "json" };
import zhTW from "./zh-TW.json" with { type: "json" };
import zhHK from "./zh-HK.json" with { type: "json" };
import ja from "./ja.json" with { type: "json" };
import ko from "./ko.json" with { type: "json" };
import th from "./th.json" with { type: "json" };
import tl from "./tl.json" with { type: "json" };
import vi from "./vi.json" with { type: "json" };
import fr from "./fr.json" with { type: "json" };
import es from "./es.json" with { type: "json" };
import nb from "./nb.json" with { type: "json" };
import ca from "./ca.json" with { type: "json" };
import de from "./de.json" with { type: "json" };
import it from "./it.json" with { type: "json" };
import nl from "./nl.json" with { type: "json" };
import pt from "./pt.json" with { type: "json" };
import ru from "./ru.json" with { type: "json" };
import sw from "./sw.json" with { type: "json" };
import eo from "./eo.json" with { type: "json" };

import enPirate from "./en-pirate.json" with { type: "json" };
import hnr from "./hnr.json" with { type: "json" };

export const locales = {
  en,
  "zh-CN": zhCN,
  ms,
  ta,
  id,
  "zh-TW": zhTW,
  "zh-HK": zhHK,
  ja,
  ko,
  th,
  tl,
  vi,
  fr,
  es,
  nb,
  ca,
  de,
  it,
  nl,
  pt,
  ru,
  sw,
  eo,
  "en-pirate": enPirate,
  hnr,
};

export const registry = [
  { code: "en", name: "English", dir: "ltr", flag: "gb" },
  { code: "zh-CN", name: "中文 (简体)", dir: "ltr", flag: "cn" },
  { code: "ms", name: "Bahasa Melayu", dir: "ltr", flag: "my" },
  { code: "ta", name: "தமிழ்", dir: "ltr", flag: "in" },
  { code: "id", name: "Bahasa Indonesia", dir: "ltr", flag: "id" },
  { code: "zh-TW", name: "中文 (繁體)", dir: "ltr", flag: "tw" },
  { code: "zh-HK", name: "廣東話 (香港)", dir: "ltr", flag: "hk" },
  { code: "ja", name: "日本語", dir: "ltr", flag: "jp" },
  { code: "ko", name: "한국어", dir: "ltr", flag: "kr" },
  { code: "th", name: "ภาษาไทย", dir: "ltr", flag: "th" },
  { code: "tl", name: "Tagalog", dir: "ltr", flag: "ph" },
  { code: "vi", name: "Tiếng Việt", dir: "ltr", flag: "vn" },
  { code: "fr", name: "Français", dir: "ltr", flag: "fr" },
  { code: "es", name: "Español", dir: "ltr", flag: "es" },
  { code: "nb", name: "Norsk bokmål", dir: "ltr", flag: "no" },
  // Catalan has no country of its own; es-ct is Catalonia's senyera in flag-icons.
  { code: "ca", name: "Català", dir: "ltr", flag: "es-ct" },
  { code: "de", name: "Deutsch", dir: "ltr", flag: "de" },
  { code: "it", name: "Italiano", dir: "ltr", flag: "it" },
  { code: "nl", name: "Nederlands", dir: "ltr", flag: "nl" },
  { code: "pt", name: "Português", dir: "ltr", flag: "pt" },
  { code: "ru", name: "Русский", dir: "ltr", flag: "ru" },
  { code: "sw", name: "Kiswahili", dir: "ltr", flag: "tz" },
  // No country either: eo.svg is the Esperanto flag, drawn by hand since flag-icons hasn't one.
  { code: "eo", name: "Esperanto", dir: "ltr", flag: "eo" },
  // "EN-PIRATE" won't fit the tray button; `short` is what the button shows instead of the code.
  { code: "en-pirate", name: "English (Pirate)", dir: "ltr", secret: true, short: "ARR" },
  { code: "hnr", name: "Henrusian", dir: "ltr", secret: true },
];

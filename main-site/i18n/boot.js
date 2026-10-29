// The i18n entry point (sgmap-explorer's docs/i18n-retrofit-spec.md 10.1): the runtime started
// with every language, and the switcher mounted on the tray's [data-language-switcher] button.
//
// The rest of the site is plain scripts, not modules, so the runtime is published on
// window.UwuI18n for them. index.html loads this as a module between js/ui.js and js/theme.js:
// module scripts run in document order with the deferred ones, so every script after it has
// window.UwuI18n, and this has window.UwuIcons and window.UwuUI.
import { applyTo, getLocale, getLocales, init, onChange, setLocale, t } from "./i18n.js";
import { locales, registry } from "./locales.js";
import { mountSwitcher, secretsUnlocked, unlockSecrets } from "./switcher.js";

init({ locales, registry });
window.UwuI18n = { t, applyTo, onChange, setLocale, getLocale, getLocales, secretsUnlocked, unlockSecrets };
mountSwitcher(document.querySelector("[data-language-switcher]"));

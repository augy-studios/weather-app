// Theme system: 7 brand colour swatches + light/dark mode.
// Default is always light + classic (#ccffcc), regardless of OS preference.
// Once the user picks something, it is persisted.
// Plain script, not a module: everything is published on window.UwuTheme.

(function () {
  const APP_KEY = "uwuweather";

  const COLOR_THEMES = [
    { id: "classic", label: "Classic", hex: "#ccffcc" },
    { id: "not-green-1", label: "Not green 1", hex: "#ffcccc" },
    { id: "not-green-2", label: "Not green 2", hex: "#ccccff" },
    { id: "not-green-3", label: "Not green 3", hex: "#ffffcc" },
    { id: "not-green-4", label: "Not green 4", hex: "#ffccff" },
    { id: "not-green-5", label: "Not green 5", hex: "#ccffff" },
    { id: "really-light-green", label: "Really really light green", hex: "#ffffff" },
  ];

  const STORAGE_KEY_COLOR = `${APP_KEY}.colorTheme`;
  const STORAGE_KEY_MODE = `${APP_KEY}.mode`;

  function hexToRgb(hex) {
    const n = parseInt(hex.replace("#", ""), 16);
    return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
  }

  function getStoredColorTheme() {
    return localStorage.getItem(STORAGE_KEY_COLOR) || "classic";
  }

  function getStoredMode() {
    return localStorage.getItem(STORAGE_KEY_MODE) || "light";
  }

  function applyColorTheme(id) {
    const theme = COLOR_THEMES.find((t) => t.id === id) || COLOR_THEMES[0];
    document.documentElement.setAttribute("data-color-theme", theme.id);
    document.documentElement.style.setProperty("--brand", theme.hex);
    document.documentElement.style.setProperty("--brand-rgb", hexToRgb(theme.hex));
    localStorage.setItem(STORAGE_KEY_COLOR, theme.id);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", theme.hex);
    return theme;
  }

  function applyMode(mode) {
    const resolved = mode === "dark" ? "dark" : "light";
    document.documentElement.setAttribute("data-mode", resolved);
    localStorage.setItem(STORAGE_KEY_MODE, resolved);
    return resolved;
  }

  function initTheme() {
    applyColorTheme(getStoredColorTheme());
    applyMode(getStoredMode());
  }

  window.UwuTheme = {
    COLOR_THEMES,
    getStoredColorTheme,
    getStoredMode,
    applyColorTheme,
    applyMode,
    initTheme,
  };
})();

// Inline SVG icon set. viewBox "0 0 24 24", stroke="currentColor",
// stroke-width 1.8, round caps and joins, fill="none".
// Icons inherit colour via currentColor, so never hardcode fill or stroke here.
// Plain script, not a module: published on window.UwuIcons.

(function () {
  const A = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"';

  // Shared cloud body, reused by the weather icons so they line up.
  const CLOUD = '<path d="M17 17H7.6a4.2 4.2 0 0 1-.4-8.4 5.2 5.2 0 0 1 9.7 1.7A3.4 3.4 0 0 1 17 17z"/>';

  const icons = {
    // ---- theme ----
    sun: `<svg ${A}><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4"/></svg>`,
    moon: `<svg ${A}><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>`,
    close: `<svg ${A}><path d="M18 6 6 18M6 6l12 12"/></svg>`,

    // ---- toolbar ----
    search: `<svg ${A}><circle cx="11" cy="11" r="7"/><path d="M20.5 20.5 16.2 16.2"/></svg>`,
    crosshair: `<svg ${A}><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.4"/><path d="M12 1.8v3.4M12 18.8v3.4M1.8 12h3.4M18.8 12h3.4"/></svg>`,
    thermometer: `<svg ${A}><path d="M14 14.9V5.2a2 2 0 1 0-4 0v9.7a4 4 0 1 0 4 0z"/><path d="M12 8.5v7.7"/></svg>`,
    star: `<svg ${A}><path d="m12 3.4 2.6 5.4 5.9.9-4.3 4.1 1 5.8-5.2-2.8-5.2 2.8 1-5.8-4.3-4.1 5.9-.9z"/></svg>`,
    pin: `<svg ${A}><path d="M12 21.2s7-5.7 7-11.2a7 7 0 1 0-14 0c0 5.5 7 11.2 7 11.2z"/><circle cx="12" cy="10" r="2.5"/></svg>`,
    coffee: `<svg ${A}><path d="M4 9.5h12V16a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4z"/><path d="M16 11.5h2.2a2.4 2.4 0 0 1 0 4.8H16"/><path d="M7.5 2.8v2.8M11 2.8v2.8M14.5 2.8v2.8"/></svg>`,
    image: `<svg ${A}><rect x="3" y="4.5" width="18" height="15" rx="2.5"/><circle cx="8.6" cy="10" r="1.6"/><path d="m3.6 17.4 4.6-4.6 3.8 3.8"/><path d="m14.2 14.6 2.4-2.4 3.8 3.8"/></svg>`,
    heart: `<svg ${A}><path d="m12 20.3-1.4-1.3C6.1 15 3 12.2 3 8.8 3 6.1 5.1 4 7.8 4c1.5 0 3 .7 4.2 2C13.2 4.7 14.7 4 16.2 4 18.9 4 21 6.1 21 8.8c0 3.4-3.1 6.2-7.6 10.2z"/></svg>`,

    // ---- share ----
    share: `<svg ${A}><circle cx="18" cy="5.2" r="2.8"/><circle cx="6" cy="12" r="2.8"/><circle cx="18" cy="18.8" r="2.8"/><path d="m8.5 10.7 7-4M8.5 13.3l7 4"/></svg>`,
    telegram: `<svg ${A}><path d="M21.4 4.3 2.9 11.4c-.8.3-.8 1.4 0 1.7l4.5 1.5 1.8 5c.2.7 1.1.9 1.6.3l2.3-2.5 4.5 3.3c.6.4 1.4.1 1.6-.6l3.3-14.6c.2-.8-.5-1.4-1.1-1.2z"/><path d="M7.4 14.6 18.2 7.4l-8.4 8.5-.5 4"/></svg>`,
    x: `<svg ${A}><path d="M4.3 4h3.9l4 5.5L17 4h2.4l-5.6 6.9L20 20h-3.9l-4.3-5.9L6.7 20H4.3l6.3-7.3z"/></svg>`,
    whatsapp: `<svg ${A}><path d="M3.4 20.6 4.7 16.4A8.2 8.2 0 1 1 8 19.4z"/><path d="M9 9.2c.2 1.7 2 4.4 4.3 5.2.6.2 1.3-.1 1.6-.7l.2-.4-2-1-.6.7c-1-.5-1.8-1.3-2.3-2.3l.7-.6-1-2-.4.2c-.5.3-.6.6-.5.9z"/></svg>`,
    facebook: `<svg ${A}><rect x="3" y="3" width="18" height="18" rx="4.5"/><path d="M15.4 8.2h-1.7c-1 0-1.7.7-1.7 1.7v9.6M10 12.7h4.6"/></svg>`,

    // ---- weather (WMO codes) ----
    clear: `<svg ${A}><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4"/></svg>`,
    "partly-cloudy": `<svg ${A}><path d="M8.4 3.2v1.8M3.6 8h1.8M4.9 4.9l1.3 1.3M11.9 4.9l-1.3 1.3"/><circle cx="8.4" cy="9.4" r="2.8"/>${CLOUD}</svg>`,
    cloudy: `<svg ${A}>${CLOUD}</svg>`,
    fog: `<svg ${A}><path d="M16.6 14.4H7.4a4 4 0 0 1-.4-8 5 5 0 0 1 9.3 1.6 3.2 3.2 0 0 1 .3 6.4z"/><path d="M4.5 18h15M7 21.4h10"/></svg>`,
    rain: `<svg ${A}>${CLOUD}<path d="m9.4 19.2-.9 2.6M14.6 19.2l-.9 2.6"/></svg>`,
    snow: `<svg ${A}>${CLOUD}<path d="M9.4 19v3M8.1 19.8l2.6 1.5M10.7 19.8l-2.6 1.5"/><path d="M15.4 19v3M14.1 19.8l2.6 1.5M16.7 19.8l-2.6 1.5"/></svg>`,
    thunderstorm: `<svg ${A}>${CLOUD}<path d="M13.4 17.8 10.4 20.9h2.6l-1.1 2.1"/></svg>`,
  };

  function icon(name) {
    return icons[name] || "";
  }

  window.UwuIcons = { icons, icon };
})();

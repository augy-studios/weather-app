// Bar charts on Chart.js: rain over the next two hours, and the UV index through
// the day. Chart.js replaced Plotly, whose drag to zoom caught people out: a
// stray drag zoomed the chart and nothing on screen said how to get back. These
// charts have no zoom or pan at all. Tapping or hovering only shows a tooltip.
//
// A canvas can't read CSS custom properties, so the theme's colours are resolved
// here, when a chart is drawn, and every chart is drawn again when the theme
// changes (see redrawAll).
// Plain script, not a module: published on window.UwuCharts. Chart.js is vendor/chartjs.

(function () {
  const charts = new Map();

  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  // "#rrggbb" or "rgb(...)" with an alpha, for grid lines a step under the ink.
  function alpha(color, a) {
    const hex = color.replace("#", "");
    if (/^[0-9a-f]{6}$/i.test(hex)) {
      const n = parseInt(hex, 16);
      return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
    }
    return color;
  }

  /**
   * One bar chart in `canvas`, replacing any chart already there.
   * bars: [{ label, value, token }], token naming the bar's colour custom
   * property; format(value) for the tooltip and axis.
   */
  function bars(canvas, { bars: data, format, label, yMin = 1, yTitle = "" }) {
    charts.get(canvas)?.destroy();

    const ink = css("--ink");
    const muted = css("--muted");
    const grid = alpha(ink, document.documentElement.dataset.mode === "dark" ? 0.16 : 0.1);
    const font = { family: '"Jua", "Segoe UI", sans-serif', size: 11 };

    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", label);

    const chart = new window.Chart(canvas, {
      type: "bar",
      data: {
        labels: data.map((d) => d.label),
        datasets: [{
          data: data.map((d) => d.value),
          backgroundColor: data.map((d) => css(d.token)),
          borderRadius: 4,
          borderSkipped: false,
          maxBarThickness: 28,
          // A dry slot still shows a sliver, so "no rain" reads as a reading.
          minBarLength: 2,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 200 },
        // Hover and tap show the tooltip. Nothing else responds: no zoom, no pan,
        // no legend to switch the only series off.
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            displayColors: false,
            backgroundColor: css("--tooltip-bg") || "rgba(18, 24, 21, 0.9)",
            titleColor: css("--tooltip-ink") || "#fff",
            bodyColor: css("--tooltip-ink") || "#fff",
            titleFont: font,
            bodyFont: font,
            padding: 8,
            cornerRadius: 10,
            callbacks: { label: (ctx) => format(ctx.parsed.y) },
          },
        },
        scales: {
          x: {
            grid: { display: false },
            border: { color: grid },
            ticks: { color: muted, font, maxRotation: 0, autoSkipPadding: 10 },
          },
          y: {
            beginAtZero: true,
            suggestedMax: yMin,
            grid: { color: grid },
            border: { display: false },
            ticks: { color: muted, font, maxTicksLimit: 5, callback: (v) => format(v) },
            title: yTitle ? { display: true, text: yTitle, color: muted, font } : { display: false },
          },
        },
      },
    });
    charts.set(canvas, chart);
    // Kept so a theme change can draw it again with the new colours.
    chart.$uwu = { canvas, opts: { bars: data, format, label, yMin, yTitle } };
    return chart;
  }

  // ---------- rain ----------

  // Per fifteen minutes. Fixed-meaning colours (--rain-1 to --rain-4 in style.css),
  // like NEA's radar legend: they say how hard it rains, not which theme is on.
  const RAIN_STEPS = [
    { max: 0.05, label: "Dry", token: "--rain-0" },
    { max: 0.5, label: "Light", token: "--rain-1" },
    { max: 2, label: "Moderate", token: "--rain-2" },
    { max: 5, label: "Heavy", token: "--rain-3" },
    { max: Infinity, label: "Very heavy", token: "--rain-4" },
  ];
  const rainStep = (mm) => RAIN_STEPS.find((s) => mm <= s.max);

  /** points: [{ t, label, mm }] */
  function rain(canvas, points) {
    const fmt = (v) => `${Math.round(v * 10) / 10} mm`;
    const wet = points.filter((p) => p.mm > 0.05);
    const summary = wet.length
      ? `Rain expected in ${wet.length} of the next ${points.length} quarter hours, up to ${fmt(Math.max(...wet.map((p) => p.mm)))} in fifteen minutes.`
      : `No rain expected in the next ${points.length / 4} hours.`;
    return bars(canvas, {
      bars: points.map((p) => ({ label: p.label, value: p.mm, token: rainStep(p.mm).token })),
      format: (v) => (v === 0 ? "0" : fmt(v)),
      label: `Rain, every fifteen minutes. ${summary}`,
      yMin: 1,
    });
  }

  // ---------- UV ----------

  /** hours: [{ label, value, band }] where band is from UwuWx.uvBand */
  function uv(canvas, hours) {
    const peak = hours.reduce((a, h) => (h.value > (a?.value ?? -1) ? h : a), null);
    return bars(canvas, {
      bars: hours.map((h) => ({ label: h.label, value: h.value, token: `--band-${h.band?.level ?? 1}` })),
      format: (v) => String(Math.round(v)),
      label: `UV index by hour.${peak ? ` Highest ${Math.round(peak.value)} at ${peak.label}.` : ""}`,
      yMin: 6,
    });
  }

  // Colours are baked into each chart, so a theme change draws them again.
  function redrawAll() {
    for (const chart of [...charts.values()]) {
      const { canvas, opts } = chart.$uwu;
      if (!canvas.isConnected) {
        chart.destroy();
        charts.delete(canvas);
        continue;
      }
      bars(canvas, opts);
    }
  }

  window.UwuCharts = { rain, uv, rainStep, RAIN_STEPS, redrawAll };
})();

// ---------- helpers ----------
const $ = (sel, el = document) => el.querySelector(sel);
const h = (tag, props = {}, children = []) => {
    const n = Object.assign(document.createElement(tag), props);
    children.forEach(c => n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c));
    return n;
};
const fmtTemp = v => v == null ? '—' : Math.round(v) + tempUnit();
const fmtWind = (s, d) => s == null ? '—' : `${Math.round(s)} ${windUnit()}${d==null? '': ' ' + degToCompass(d)}`;
const fmtPerc = v => v == null ? '—' : Math.round(v) + '%';
const fmtMM = v => v == null ? '—' : (v.toFixed(1).replace(/\.0$/, '')) + ' mm';
const degToCompass = deg => ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'][Math.round((deg % 360) / 22.5) % 16];
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
const toLocal = s => new Date(s);
const pad = n => String(n).padStart(2, '0');
const fmtTime = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const wmoText = code => {
    const m = {
        0: 'Clear',
        1: 'Mainly clear',
        2: 'Partly cloudy',
        3: 'Overcast',
        45: 'Fog',
        48: 'Depositing rime fog',
        51: 'Light drizzle',
        53: 'Drizzle',
        55: 'Heavy drizzle',
        56: 'Freezing drizzle',
        57: 'Freezing drizzle',
        61: 'Light rain',
        63: 'Rain',
        65: 'Heavy rain',
        66: 'Freezing rain',
        67: 'Freezing rain',
        71: 'Light snow',
        73: 'Snow',
        75: 'Heavy snow',
        77: 'Snow grains',
        80: 'Rain showers',
        81: 'Rain showers',
        82: 'Violent rain showers',
        85: 'Snow showers',
        86: 'Snow showers',
        95: 'Thunderstorm',
        96: 'Thunderstorm w/ hail',
        99: 'Thunderstorm w/ heavy hail'
    };
    return m[code] || '—';
}
const wmoEmoji = code => {
    if ([0].includes(code)) return '☀️';
    if ([1, 2].includes(code)) return '🌤️';
    if ([3].includes(code)) return '☁️';
    if ([45, 48].includes(code)) return '🌫️';
    if ([51, 53, 55, 61, 63, 65, 80, 81, 82].includes(code)) return '🌧️';
    if ([71, 73, 75, 77, 85, 86].includes(code)) return '🌨️';
    if ([95, 96, 99].includes(code)) return '⛈️';
    return '🌡️';
}

function flagFromLabel(label) {
    // label like "Singapore, SG" or "Paris, FR"
    const m = label.match(/,\s*([A-Z]{2})$/);
    if (!m) return ''; // no flag
    const cc = m[1];
    // regional indicator symbols
    const A = 0x1F1E6;
    const flag = [...cc].map(c => String.fromCodePoint(A + (c.charCodeAt(0) - 65))).join('');
    return flag;
}

// Parse "City, Region, CC" into parts
function parseQuery(q) {
    const parts = q.split(',').map(s => s.trim()).filter(Boolean);
    const name = parts[0] ?? '';
    const admin1 = parts.length >= 2 ? parts[1] : '';
    // accept 2-letter country code in last slot
    const last = parts[parts.length - 1] || '';
    const countryCode = /^[A-Za-z]{2}$/.test(last) ? last.toUpperCase() : '';
    return {
        name,
        admin1,
        countryCode
    };
}

// Smart search: respects countryCode + admin1 filter
async function searchCitySmart(q) {
    const {
        name,
        admin1,
        countryCode
    } = parseQuery(q);
    if (!name) return [];

    const params = new URLSearchParams({
        name: name,
        count: '8',
        language: 'en',
        format: 'json'
    });
    if (countryCode) params.set('countryCode', countryCode);

    const url = `https://geocoding-api.open-meteo.com/v1/search?${params.toString()}`;
    const res = await fetch(url);
    if (!res.ok) return [];

    const j = await res.json();
    let results = (j.results || []);

    // If user typed an admin1, filter by it (case-insensitive, startsWith/equals)
    if (admin1) {
        const a1 = admin1.toLowerCase();
        results = results.filter(r => {
            const val = (r.admin1 || '').toLowerCase();
            return val === a1 || val.startsWith(a1);
        });
        // If filtering made it empty, fall back to all results from country
        if (!results.length) results = (j.results || []);
    }

    // Map to your existing display shape
    return results.map(r => ({
        name: `${r.name}${r.admin1 ? ', ' + r.admin1 : ''}, ${r.country_code}`,
        lat: r.latitude,
        lon: r.longitude
    }));
}

// ---------- units ----------
let units = localStorage.getItem('uwuweather.units') || 'metric'; // 'metric' or 'imperial'
const isImperial = () => units === 'imperial';
const tempUnit = () => isImperial() ? '°F' : '°C';
const windUnit = () => isImperial() ? 'mph' : 'km/h';

// ---------- state ----------
let current = {
    lat: null,
    lon: null,
    name: '—'
};

// ---------- geocoding & saved ----------
async function searchCity(q) {
    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=8&language=en&format=json`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const j = await res.json();
    return (j.results || []).map(r => ({
        name: `${r.name}${r.admin1? ', '+r.admin1:''}, ${r.country_code}`,
        lat: r.latitude,
        lon: r.longitude
    }));
}

function loadSaved() {
    try {
        return JSON.parse(localStorage.getItem('uwuweather.saved') || '[]');
    } catch {
        return []
    }
}

function saveSaved(list) {
    localStorage.setItem('uwuweather.saved', JSON.stringify(list));
    renderSaved();
}

function renderSaved() {
    const wrap = $('#saved');
    wrap.innerHTML = '';
    const list = loadSaved();
    list.forEach((it, i) => {
        const isMine = it.name === 'My location';
        const prefix = isMine ?
            '<i class="fa-solid fa-location-crosshairs" aria-hidden="true"></i>' :
            (flagFromLabel(it.name) || '<i class="fa-solid fa-location-dot" aria-hidden="true"></i>');
        const chip = h('span', {
            className: 'chip'
        }, [
            h('button', {
                onclick: () => loadWeather(it.lat, it.lon, it.name),
                innerHTML: `${prefix} <span>${it.name}</span>`
            }),
            h('button', {
                title: 'Remove',
                onclick: () => {
                    list.splice(i, 1);
                    saveSaved(list)
                },
                innerHTML: '<i class="fa-solid fa-xmark" aria-hidden="true"></i>'
            })
        ]);
        wrap.appendChild(chip);
    });
}

// ---------- weather ----------
async function loadWeather(lat, lon, label) {
    current = {
        lat,
        lon,
        name: label || current.name
    };
    $('#place-label').textContent = current.name;
    $('#share-place').textContent = current.name;

    // ✅ Save last visited location
    localStorage.setItem('uwuweather.last', JSON.stringify(current));

    const params = new URLSearchParams({
        latitude: lat,
        longitude: lon,
        timezone: 'auto',
        current: [
            'temperature_2m', 'relative_humidity_2m', 'apparent_temperature', 'precipitation',
            'weather_code', 'cloud_cover', 'wind_speed_10m', 'wind_gusts_10m', 'wind_direction_10m', 'surface_pressure'
        ].join(','),
        hourly: [
            'temperature_2m', 'precipitation_probability', 'precipitation', 'weather_code', 'wind_speed_10m', 'cloud_cover', 'surface_pressure'
        ].join(','),
        daily: [
            'weather_code', 'temperature_2m_max', 'temperature_2m_min', 'precipitation_sum', 'precipitation_probability_max', 'wind_speed_10m_max'
        ].join(','),
        minutely_15: 'precipitation',
        forecast_days: 7,
        past_days: 0,
        temperature_unit: isImperial() ? 'fahrenheit' : 'celsius',
        wind_speed_unit: isImperial() ? 'mph' : 'kmh'
    });

    const url = `https://api.open-meteo.com/v1/forecast?${params.toString()}`;
    const res = await fetch(url);
    const j = await res.json();
    renderCurrent(j);
    renderHourly(j);
    renderDaily(j);
    renderNowcast(j);
    updateShare(j);
}

function renderCurrent(j) {
    const c = j.current || {};
    $('#temp').textContent = fmtTemp(c.temperature_2m);
    $('#apparent').textContent = fmtTemp(c.apparent_temperature);
    $('#humidity').textContent = fmtPerc(c.relative_humidity_2m);
    $('#wind').textContent = fmtWind(c.wind_speed_10m, c.wind_direction_10m);
    $('#pressure').textContent = c.surface_pressure ? Math.round(c.surface_pressure) + ' hPa' : '—';
    $('#summary').textContent = wmoText(c.weather_code);
    $('#icon').textContent = wmoEmoji(c.weather_code);
}

function renderHourly(j) {
    const wrap = $('#hourly');
    wrap.innerHTML = '';
    const t = j.hourly?.time || [];
    const now = Date.now();
    for (let i = 0, added = 0; i < t.length && added < 24; i++) {
        const ts = new Date(t[i]).getTime();
        if (ts >= now) {
            const pill = h('div', {
                className: 'pill'
            }, [
                h('div', {
                    className: 'muted'
                }, [fmtTime(new Date(ts))]),
                h('div', {
                    style: 'font-size:22px;font-weight:800'
                }, [fmtTemp(j.hourly.temperature_2m?.[i])]),
                h('div', {}, [wmoEmoji(j.hourly.weather_code?.[i]) + ' ' + (j.hourly.precipitation_probability?.[i] ?? '—') + '%'])
            ]);
            wrap.appendChild(pill);
            added++;
        }
    }
}

function renderDaily(j) {
    const wrap = $('#daily');
    wrap.innerHTML = '';
    const t = j.daily?.time || [];
    for (let i = 0; i < Math.min(5, t.length); i++) {
        const d = new Date(t[i]);
        const name = d.toLocaleDateString(undefined, {
            weekday: 'short'
        })
        const card = h('div', {
            className: 'pill day'
        }, [
            h('div', {
                className: 'muted'
            }, [name]),
            h('div', {
                style: 'font-size:22px;font-weight:800'
            }, [
                `${Math.round(j.daily.temperature_2m_max?.[i])}° / ${Math.round(j.daily.temperature_2m_min?.[i])}°`
            ]),
            h('div', {}, [wmoEmoji(j.daily.weather_code?.[i]) + `  ${(j.daily.precipitation_sum?.[i]??0).toFixed(1)} mm`])
        ]);
        wrap.appendChild(card);
    }
}

// Tiny canvas bar chart for 2‑hour nowcast
function renderNowcast(j) {
    const el = document.getElementById('nowcastPlot');
    if (!el) return;

    const times = j.minutely_15?.time || [];
    const prec = j.minutely_15?.precipitation || [];
    const nowMs = Date.now();

    // Keep the next ~2 hours (8 x 15min)
    const points = [];
    for (let i = 0; i < times.length; i++) {
        const t = new Date(times[i]).getTime();
        if (t >= nowMs && t <= nowMs + 2 * 60 * 60 * 1000) {
            points.push({
                t,
                v: prec[i] ?? 0
            });
        }
    }

    // Fallback: first 8 points if empty
    const data = (points.length ? points : times.slice(0, 8).map((t, i) => ({
        t: new Date(t).getTime(),
        v: prec[i] ?? 0
    })));

    const x = data.map(p =>
        new Date(p.t).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit'
        })
    );
    const y = data.map(p => p.v);

    // Colour bars by intensity (cyan → green → yellow → orange → red → magenta-ish)
    const max = Math.max(1, ...y);
    const colorFor = (v) => {
        const r = v / max; // 0..1
        // map r to a rough blue→green→yellow→orange→red hue band (200→0-ish)
        const hue = Math.max(0, 200 - Math.floor(r * 200));
        return `hsl(${hue},70%,40%)`;
    };
    const colors = y.map(colorFor);

    const brand = getComputedStyle(document.documentElement)
        .getPropertyValue('--brand-strong').trim() || '#66ff66';

    const trace = {
        type: 'bar',
        x,
        y,
        marker: {
            color: colors,
            line: {
                color: brand,
                width: 0
            } // subtle edge; set to 1 if you want an outline
        },
        hovertemplate: '%{x}<br>%{y:.2f} mm<extra></extra>'
    };

    const layout = {
        margin: {
            l: 40,
            r: 16,
            t: 6,
            b: 30
        },
        yaxis: {
            title: 'mm',
            rangemode: 'tozero',
            zeroline: true,
            gridcolor: 'rgba(0,0,0,0.06)'
        },
        xaxis: {
            tickangle: -0,
            gridcolor: 'rgba(0,0,0,0.04)'
        },
        showlegend: false,
        paper_bgcolor: 'rgba(0,0,0,0)',
        plot_bgcolor: 'rgba(0,0,0,0)',
        height: 160
    };

    Plotly.newPlot(el, [trace], layout, {
        displayModeBar: false,
        responsive: true
    });

    if (data.length) {
        const first = new Date(data[0].t);
        const last = new Date(data[data.length - 1].t);
        document.getElementById('nowcast-range').textContent =
            `${first.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})} → ${last.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}`;
    } else {
        document.getElementById('nowcast-range').textContent = '—';
    }
}

// ---------- share ----------
function weatherSVG(code = 0) {
    // Read CSS brand colour (fallback to #66ff66)
    const brand = getComputedStyle(document.documentElement)
        .getPropertyValue('--brand-strong').trim() || '#66ff66';

    // Reusable bits
    const sunCore = `
    <circle cx="60" cy="60" r="22" fill="#fff" fill-opacity="0.98" stroke="${brand}" stroke-width="3"/>
    <g stroke="${brand}" stroke-width="3" stroke-linecap="round">
      <line x1="60" y1="20" x2="60" y2="38"/><line x1="60" y1="82" x2="60" y2="100"/>
      <line x1="20" y1="60" x2="38" y2="60"/><line x1="82" y1="60" x2="100" y2="60"/>
      <line x1="32" y1="32" x2="45" y2="45"/><line x1="75" y1="75" x2="88" y2="88"/>
      <line x1="32" y1="88" x2="45" y2="75"/><line x1="75" y1="45" x2="88" y2="32"/>
    </g>`;

    const cloud = `
    <path d="M30 78c-2-10 6-18 16-18 3-9 14-14 24-10 4-6 12-9 20-7 10 3 16 14 13 24 9 2 15 10 14 18-2 12-20 16-45 16s-42-5-42-14c0-4 0-7 0-9z"
      fill="#fff" fill-opacity="0.98" stroke="${brand}" stroke-width="3" />`;

    const rain = `
    ${cloud}
    <g stroke="${brand}" stroke-width="3" stroke-linecap="round">
      <line x1="48" y1="98" x2="44" y2="114"/>
      <line x1="66" y1="98" x2="62" y2="114"/>
      <line x1="84" y1="98" x2="80" y2="114"/>
    </g>`;

    const lightning = `
    ${cloud}
    <path d="M74 98 L62 98 72 78 64 78 78 58 72 82 86 82 Z"
      fill="${brand}" fill-opacity="0.9" stroke="${brand}" stroke-width="2" />`;

    const snow = `
    ${cloud}
    <g stroke="${brand}" stroke-width="2" stroke-linecap="round">
      <g transform="translate(56,102)">
        <line x1="-6" y1="0" x2="6" y2="0"/><line x1="0" y1="-6" x2="0" y2="6"/>
        <line x1="-4.2" y1="-4.2" x2="4.2" y2="4.2"/><line x1="-4.2" y1="4.2" x2="4.2" y2="-4.2"/>
      </g>
      <g transform="translate(78,108)">
        <line x1="-6" y1="0" x2="6" y2="0"/><line x1="0" y1="-6" x2="0" y2="6"/>
        <line x1="-4.2" y1="-4.2" x2="4.2" y2="4.2"/><line x1="-4.2" y1="4.2" x2="4.2" y2="-4.2"/>
      </g>
    </g>`;

    const fog = `
    ${cloud}
    <g stroke="${brand}" stroke-width="3" stroke-linecap="round" opacity="0.9">
      <line x1="36" y1="98" x2="104" y2="98"/>
      <line x1="28" y1="108" x2="96" y2="108"/>
      <line x1="40" y1="118" x2="108" y2="118"/>
    </g>`;

    const partly = `
    <g transform="translate(-12,-12)">${sunCore}</g>
    ${cloud}`;

    const cloudyOnly = cloud;
    const sunnyOnly = sunCore;

    // Map WMO codes → an illustration
    const is = (arr) => arr.includes(code);
    let art = sunnyOnly;
    if (is([1, 2])) art = partly; // Mainly clear / Partly cloudy
    else if (is([3])) art = cloudyOnly; // Overcast
    else if (is([45, 48])) art = fog; // Fog
    else if (is([51, 53, 55, 56, 57, 61, 63, 65, 80, 81, 82, 66, 67])) art = rain; // Drizzle/Rain
    else if (is([71, 73, 75, 77, 85, 86])) art = snow; // Snow
    else if (is([95, 96, 99])) art = lightning; // Thunderstorm
    else if (is([0])) art = sunnyOnly; // Clear

    return `
    <svg viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg" role="img">
      ${art}
    </svg>`;
}

function buildShareURL() {
    if (!current.name || current.name === '—') {
        return location.href; // fallback
    }
    const params = new URLSearchParams(window.location.search);
    params.set("q", current.name); // will auto-encode spaces, commas, etc.
    return `${location.origin}?${params.toString()}`;
}

function updateShare(j) {
    const c = j.current || {};
    $('#share-temp').textContent = fmtTemp(c.temperature_2m);
    $('#share-summary').textContent = wmoText(c.weather_code);
    $('#share-extra').textContent = `${fmtPerc(c.relative_humidity_2m)} • ${fmtWind(c.wind_speed_10m)}`;
    $('#share-time').textContent = new Date().toLocaleString();
    $('#share-art').innerHTML = weatherSVG(c.weather_code);
}

async function saveShareImage() {
    const node = document.getElementById('share-card');
    const canvas = await html2canvas(node, {
        backgroundColor: null,
        scale: 2
    });
    const blob = await new Promise(res => canvas.toBlob(res, 'image/png'));
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `UwU-Weather-${current.name.replace(/\W+/g,'_')}.png`;
    a.click();
    URL.revokeObjectURL(url);
    return blob;
}

$('#save-image').addEventListener('click', saveShareImage);

$('#share-device').addEventListener('click', async () => {
    try {
        const blob = await saveShareImage();
        if (navigator.share && navigator.canShare?.({
                files: [new File([blob], 'uwuweather.png', {
                    type: 'image/png'
                })]
            })) {
            await navigator.share({
                title: `Weather — ${current.name}`,
                text: `${$('#share-temp').textContent} · ${$('#share-summary').textContent} · ${$('#share-extra').textContent}`,
                files: [new File([blob], 'uwuweather.png', {
                    type: 'image/png'
                })]
            });
        } else if (navigator.share) {
            await navigator.share({
                title: `Weather — ${current.name}`,
                text: `${$('#share-temp').textContent} · ${$('#share-summary').textContent} · ${$('#share-extra').textContent}`,
                url: buildShareURL()
            });
        } else {
            alert('Image saved. Use your gallery or social apps to share.');
        }
    } catch (err) {
        console.warn(err);
        alert('Share was cancelled or not supported.');
    }
});

document.querySelectorAll('[data-share]').forEach(btn => {
    btn.addEventListener('click', () => {
        const text = encodeURIComponent(`${$('#share-temp').textContent} · ${$('#share-summary').textContent} in ${current.name}.`);
        const url = encodeURIComponent(buildShareURL());
        let link = '#';
        const net = btn.dataset.share;
        if (net === 'tg') link = `https://t.me/share/url?url=${url}&text=${text}`;
        if (net === 'x') link = `https://twitter.com/intent/tweet?text=${text}&url=${url}`;
        if (net === 'wa') link = `https://wa.me/?text=${text}%20${url}`;
        if (net === 'fb') link = `https://www.facebook.com/sharer/sharer.php?u=${url}`;
        window.open(link, '_blank', 'noopener');
    });
});

// ---------- events ----------

function updateUnitsLabel() {
    const el = $('#units-label');
    if (el) el.textContent = isImperial() ? '°F' : '°C';
}
$('#btn-units')?.addEventListener('click', () => {
    units = isImperial() ? 'metric' : 'imperial';
    localStorage.setItem('uwuweather.units', units);
    updateUnitsLabel();
    if (current.lat && current.lon) {
        loadWeather(current.lat, current.lon, current.name);
    }
});

updateUnitsLabel();

$('#btn-search').addEventListener('click', async () => {
    const q = $('#query').value.replace(/\s+/g, ' ').trim();
    if (!q) return;

    const results = await searchCitySmart(q); // ⬅️ use the smarter search
    const dl = $('#suggestions');
    dl.innerHTML = '';
    results.forEach(r => dl.appendChild(h('option', {
        value: r.name
    })));

    if (results[0]) loadWeather(results[0].lat, results[0].lon, results[0].name);
    else alert('No matching location found. Try a different spelling.');
});

$('#query').addEventListener('keydown', e => {
    if (e.key === 'Enter') $('#btn-search').click();
});

$('#btn-current').addEventListener('click', () => {
    if (!navigator.geolocation) {
        alert('Geolocation not supported by your browser');
        return;
    }
    navigator.geolocation.getCurrentPosition(pos => {
        const {
            latitude: lat,
            longitude: lon
        } = pos.coords;
        loadWeather(lat, lon, 'My location');
    }, err => {
            const msg = {
                1: 'Permission denied. Please allow location access in your browser.',
                2: 'Position unavailable. Try again in a moment.',
                3: 'Timed out. Please try again.'
            } [err.code] || 'Could not get location. Please allow access or search for a city.';
            alert(msg);
    }, {
        enableHighAccuracy: true,
        maximumAge: 60_000,
        timeout: 10_000
    });
});

$('#btn-save').addEventListener('click', () => {
    if (!current.lat) return alert('Load a location first.');
    const list = loadSaved();
    if (!list.find(it => Math.abs(it.lat - current.lat) < 1e-6 && Math.abs(it.lon - current.lon) < 1e-6)) {
        list.unshift({
            name: current.name,
            lat: current.lat,
            lon: current.lon
        });
        saveSaved(list.slice(0, 12));
    }
});

// ---------- boot ----------
renderSaved();
(async () => {
    const params = new URLSearchParams(window.location.search);
    const q = params.get("q");

    if (q) {
        const results = await searchCitySmart(q.trim());
        if (results[0]) {
            loadWeather(results[0].lat, results[0].lon, results[0].name);
            $('#query').value = results[0].name;
            return;
        } else {
            alert("No matching location found. Showing default.");
        }
    }

    // ✅ If no query, try last visited location
    const last = localStorage.getItem('uwuweather.last');
    if (last) {
        try {
            const loc = JSON.parse(last);
            if (loc.lat && loc.lon) {
                loadWeather(loc.lat, loc.lon, loc.name);
                return;
            }
        } catch (e) {
            console.warn("Could not parse last location", e);
        }
    }

    // fallback default
    loadWeather(1.2899, 103.8517, "Singapore, SG");
})();
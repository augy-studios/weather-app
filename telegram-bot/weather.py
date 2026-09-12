"""Open-Meteo access and formatting.

This mirrors main-site/script.js so the bot and the web app describe the same
sky in the same words: the same WMO code table, the same smart search parsing,
the same fields on the current conditions card.

Open-Meteo needs no key. The site proxies it through /api only to add caching,
so the bot calls the upstream directly and keeps a small cache of its own with
the same lifetimes the proxies advertise.
"""

import time

import httpx

GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search"
FORECAST_URL = "https://api.open-meteo.com/v1/forecast"

GEOCODE_TTL = 24 * 60 * 60
FORECAST_TTL = 10 * 60

_client: httpx.AsyncClient | None = None
_cache: dict[str, tuple[float, object]] = {}

WMO_TEXT = {
    0: "Clear", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
    45: "Fog", 48: "Depositing rime fog",
    51: "Light drizzle", 53: "Drizzle", 55: "Heavy drizzle",
    56: "Freezing drizzle", 57: "Freezing drizzle",
    61: "Light rain", 63: "Rain", 65: "Heavy rain",
    66: "Freezing rain", 67: "Freezing rain",
    71: "Light snow", 73: "Snow", 75: "Heavy snow", 77: "Snow grains",
    80: "Rain showers", 81: "Rain showers", 82: "Violent rain showers",
    85: "Snow showers", 86: "Snow showers",
    95: "Thunderstorm", 96: "Thunderstorm with hail", 99: "Thunderstorm with heavy hail",
}

# Telegram has no place for the site's inline SVG set, so each icon name maps to
# the nearest emoji. The grouping is the one in wmoIcon().
WMO_EMOJI = {
    "clear": "☀️",
    "partly-cloudy": "⛅",
    "cloudy": "☁️",
    "fog": "\U0001f32b️",
    "rain": "\U0001f327️",
    "snow": "\U0001f328️",
    "thunderstorm": "⛈️",
    "thermometer": "\U0001f321️",
}


class WeatherError(RuntimeError):
    pass


async def start() -> None:
    global _client
    _client = httpx.AsyncClient(
        timeout=httpx.Timeout(15.0),
        headers={"User-Agent": "uwu-weather-telegram-bot"},
    )


async def close() -> None:
    if _client is not None:
        await _client.aclose()


async def _get_json(url: str, params: dict, ttl: int) -> dict:
    key = url + "?" + "&".join(f"{k}={v}" for k, v in sorted(params.items()))
    hit = _cache.get(key)
    if hit and hit[0] > time.time():
        return hit[1]
    try:
        res = await _client.get(url, params=params)
        res.raise_for_status()
        data = res.json()
    except httpx.HTTPError as err:
        raise WeatherError("The weather service did not answer. Please try again shortly.") from err
    _cache[key] = (time.time() + ttl, data)
    if len(_cache) > 512:
        for stale in [k for k, (exp, _) in _cache.items() if exp < time.time()]:
            _cache.pop(stale, None)
    return data


def wmo_text(code) -> str:
    return WMO_TEXT.get(code, "Not reported")


def wmo_icon(code) -> str:
    if code in (0,):
        return "clear"
    if code in (1, 2):
        return "partly-cloudy"
    if code in (3,):
        return "cloudy"
    if code in (45, 48):
        return "fog"
    if code in (51, 53, 55, 61, 63, 65, 80, 81, 82):
        return "rain"
    if code in (71, 73, 75, 77, 85, 86):
        return "snow"
    if code in (95, 96, 99):
        return "thunderstorm"
    return "thermometer"


def wmo_emoji(code) -> str:
    return WMO_EMOJI[wmo_icon(code)]


def flag_from_label(label: str) -> str:
    """Country flag for a label ending in a two letter code, as the site does."""
    tail = label.strip()[-2:]
    if len(tail) != 2 or not tail.isalpha() or not tail.isupper():
        return ""
    return "".join(chr(0x1F1E6 + ord(c) - 65) for c in tail)


def deg_to_compass(deg) -> str:
    points = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
              "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"]
    return points[round((deg % 360) / 22.5) % 16]


def temp_unit(units: str) -> str:
    return "°F" if units == "imperial" else "°C"


def wind_unit(units: str) -> str:
    return "mph" if units == "imperial" else "km/h"


def fmt_temp(value, units: str) -> str:
    return "n/a" if value is None else f"{round(value)}{temp_unit(units)}"


def fmt_wind(speed, direction, units: str) -> str:
    if speed is None:
        return "n/a"
    tail = "" if direction is None else " " + deg_to_compass(direction)
    return f"{round(speed)} {wind_unit(units)}{tail}"


def fmt_percent(value) -> str:
    return "n/a" if value is None else f"{round(value)}%"


def parse_query(query: str) -> tuple[str, str, str]:
    parts = [p.strip() for p in query.split(",") if p.strip()]
    name = parts[0] if parts else ""
    admin1 = parts[1] if len(parts) >= 2 else ""
    last = parts[-1] if parts else ""
    country = last.upper() if len(last) == 2 and last.isalpha() else ""
    return name, admin1, country


async def search_city(query: str, count: int = 8) -> list[dict]:
    """Free text search, parsed the way the site parses it: name, then region,
    then a trailing two letter country code."""
    name, admin1, country = parse_query(query)
    if not name:
        return []

    params = {"name": name, "count": str(count), "language": "en", "format": "json"}
    if country:
        params["countryCode"] = country

    data = await _get_json(GEOCODE_URL, params, GEOCODE_TTL)
    results = data.get("results") or []

    if admin1:
        wanted = admin1.lower()
        narrowed = [r for r in results if (r.get("admin1") or "").lower().startswith(wanted)]
        if narrowed:
            results = narrowed

    return [
        {
            "name": f"{r['name']}{', ' + r['admin1'] if r.get('admin1') else ''}, {r['country_code']}",
            "lat": r["latitude"],
            "lon": r["longitude"],
        }
        for r in results
    ]


async def reverse_label(lat: float, lon: float) -> str:
    """Open-Meteo has no reverse geocoder, so a shared pin is labelled by its
    coordinates. Kept in one place in case that changes."""
    return f"{lat:.3f}, {lon:.3f}"


async def forecast(lat: float, lon: float, units: str = "metric") -> dict:
    params = {
        "latitude": f"{lat:.4f}",
        "longitude": f"{lon:.4f}",
        "timezone": "auto",
        "current": ",".join([
            "temperature_2m", "relative_humidity_2m", "apparent_temperature", "precipitation",
            "weather_code", "cloud_cover", "wind_speed_10m", "wind_gusts_10m",
            "wind_direction_10m", "surface_pressure",
        ]),
        "hourly": ",".join([
            "temperature_2m", "precipitation_probability", "precipitation", "weather_code",
            "wind_speed_10m", "cloud_cover", "surface_pressure",
        ]),
        "daily": ",".join([
            "weather_code", "temperature_2m_max", "temperature_2m_min", "precipitation_sum",
            "precipitation_probability_max", "wind_speed_10m_max", "sunrise", "sunset",
        ]),
        "minutely_15": "precipitation",
        "forecast_days": "7",
        "past_days": "0",
        "temperature_unit": "fahrenheit" if units == "imperial" else "celsius",
        "wind_speed_unit": "mph" if units == "imperial" else "kmh",
    }
    return await _get_json(FORECAST_URL, params, FORECAST_TTL)


# --- formatting ------------------------------------------------------------
#
# Every formatter returns (title, body, fields, table) ready for
# ui.send_rich_message. Text is Rich Markdown, so the place name arrives
# already escaped and any markup here is deliberate. Table cells are raw
# values; ui.render escapes them.

def _local_time(iso: str) -> str:
    return iso.split("T")[1][:5] if "T" in iso else iso


def _future_hours(data: dict, limit: int) -> list[int]:
    """Indices of the hourly series from the location's own current hour on."""
    times = (data.get("hourly") or {}).get("time") or []
    current = (data.get("current") or {}).get("time")
    start = 0
    if current:
        stamp = current[:13]
        for i, t in enumerate(times):
            if t[:13] >= stamp:
                start = i
                break
    return list(range(start, min(start + limit, len(times))))


def _today(data: dict, units: str) -> dict:
    """The first day of the daily series, formatted. Shared by the current
    conditions card and the digest so both describe the day the same way."""
    daily = data.get("daily") or {}

    def first(key, default=None):
        values = daily.get(key)
        return values[0] if values else default

    sunrise, sunset = first("sunrise", ""), first("sunset", "")
    return {
        "code": first("weather_code"),
        "high": fmt_temp(first("temperature_2m_max"), units),
        "low": fmt_temp(first("temperature_2m_min"), units),
        "pop": first("precipitation_probability_max"),
        "rain": first("precipitation_sum", 0) or 0,
        "wind": fmt_wind(first("wind_speed_10m_max"), None, units),
        "sun": f"{_local_time(sunrise)} to {_local_time(sunset)}" if sunrise and sunset else None,
    }


def format_current(data: dict, place: str, units: str) -> tuple[str, str, list, None]:
    c = data.get("current") or {}
    code = c.get("weather_code")
    flag = flag_from_label(place)
    title = f"{wmo_emoji(code)} {place}{' ' + flag if flag else ''}"
    body = f"**{fmt_temp(c.get('temperature_2m'), units)}**, {wmo_text(code)}"

    today = _today(data, units)
    if (data.get("daily") or {}).get("time"):
        body += f"\n\nToday runs {today['low']} to {today['high']}."
        if today["pop"]:
            body += f" Rain chance peaks at {today['pop']}%."

    pressure = c.get("surface_pressure")
    fields = [
        ("Feels like", fmt_temp(c.get("apparent_temperature"), units)),
        ("Humidity", fmt_percent(c.get("relative_humidity_2m"))),
        ("Wind", fmt_wind(c.get("wind_speed_10m"), c.get("wind_direction_10m"), units)),
        ("Gusts", fmt_wind(c.get("wind_gusts_10m"), None, units)),
        ("Pressure", f"{round(pressure)} hPa" if pressure is not None else "n/a"),
        ("Cloud cover", fmt_percent(c.get("cloud_cover"))),
    ]
    if (data.get("daily") or {}).get("time"):
        fields += [
            ("Rain today", f"{today['rain']:.1f} mm"),
            ("Strongest wind today", today["wind"]),
        ]
        if today["sun"]:
            fields.append(("Sun", today["sun"]))
    return title, body, fields, None


def format_hourly(data: dict, place: str, units: str) -> tuple[str, str | None, list, tuple | None]:
    hourly = data.get("hourly") or {}
    rows = []
    for i in _future_hours(data, 24):
        code = (hourly.get("weather_code") or [None])[i]
        temp = fmt_temp((hourly.get("temperature_2m") or [None])[i], units)
        pop = (hourly.get("precipitation_probability") or [None])[i]
        rows.append([_local_time(hourly["time"][i]), wmo_emoji(code), temp,
                     "" if pop is None else f"{pop}%"])
    if not rows:
        return f"Next 24 hours in {place}", "No hourly data came back for this place.", [], None
    return f"Next 24 hours in {place}", None, [], (["Sky", "Temp", "Rain"], rows)


def format_daily(data: dict, place: str, units: str) -> tuple[str, str | None, list, tuple | None]:
    from datetime import date

    daily = data.get("daily") or {}
    times = daily.get("time") or []
    rows = []
    for i in range(min(5, len(times))):
        day = date.fromisoformat(times[i]).strftime("%a")
        high = fmt_temp((daily.get("temperature_2m_max") or [None])[i], units)
        low = fmt_temp((daily.get("temperature_2m_min") or [None])[i], units)
        code = (daily.get("weather_code") or [None])[i]
        rain = (daily.get("precipitation_sum") or [0])[i] or 0
        rows.append([day, wmo_emoji(code), f"{high} / {low}", f"{rain:.1f} mm"])
    if not rows:
        return f"Next 5 days in {place}", "No daily data came back for this place.", [], None
    return f"Next 5 days in {place}", None, [], (["Sky", "High / Low", "Rain"], rows)


def format_nowcast(data: dict, place: str) -> tuple[str, str, list, tuple | None]:
    """The site draws the two hour nowcast as a Plotly bar chart. Telegram gets
    the same numbers as a table with a bar of block characters per row."""
    minutely = data.get("minutely_15") or {}
    times = minutely.get("time") or []
    values = minutely.get("precipitation") or []
    current = (data.get("current") or {}).get("time") or ""

    points = []
    for i, t in enumerate(times):
        if current and t < current[:16]:
            continue
        points.append((t, values[i] if i < len(values) else 0) )
        if len(points) >= 8:
            break

    if not points:
        return f"Two hour nowcast for {place}", "No nowcast data came back for this place.", [], None

    peak = max([v or 0 for _, v in points]) or 0
    blocks = " ▁▂▃▅▆▇█"
    rows = []
    for t, v in points:
        v = v or 0
        level = 0 if peak == 0 else min(len(blocks) - 1, int(round(v / peak * (len(blocks) - 1))))
        rows.append([_local_time(t), blocks[level] * 6 if level else ".", f"{v:.2f} mm"])

    headline = "Dry for the next two hours." if peak == 0 else f"Peak of {peak:.2f} mm in a quarter hour."
    return f"Two hour nowcast for {place}", headline, [], (["Rain", "mm"], rows)


def format_digest(data: dict, place: str, units: str) -> tuple[str, str, list, None]:
    """The daily scheduled message: today at a glance plus what to expect."""
    c = data.get("current") or {}
    today = _today(data, units)
    code = today["code"] if today["code"] is not None else c.get("weather_code")

    title = f"{wmo_emoji(code)} Good morning, here is {place} today"
    body = f"**{wmo_text(code)}**, {today['low']} to {today['high']}."
    if today["pop"]:
        # Markdown folds a single newline into the paragraph, so this is its own.
        body += f"\n\nRain chance peaks at {today['pop']}%."
    fields = [
        ("Right now", f"{fmt_temp(c.get('temperature_2m'), units)}, {wmo_text(c.get('weather_code')).lower()}"),
        ("Rain total", f"{today['rain']:.1f} mm"),
        ("Strongest wind", today["wind"]),
    ]
    if today["sun"]:
        fields.append(("Sun", today["sun"]))
    return title, body, fields, None

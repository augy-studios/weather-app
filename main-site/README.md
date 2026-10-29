# Weather App by Augy Studios
The (finally) open source version of the weather app! (As advertised on Augy Studios Labs)

Currently live on [weather.uwuapps.org](https://weather.uwuapps.org)

## About
Get the latest weather information based on your current location or the city you searched for. Four pages, picked from the tray on the right:

- **Now**: current conditions, air quality and UV, any weather warnings in force, and the sea for places on the coast. In Singapore, the nearest NEA station's readings and NEA's 2-hour forecast for the area, plus a warning when lightning is close. In the US, Norway, Canada, Germany, Ireland and Switzerland, the national weather service's own station and forecast. Elsewhere in Europe, the nearest station's reading through MeteoGate, and MeteoAlarm's warnings for the place.
- **Map**: the rain radar, three hours of it in Singapore (NEA), Germany (DWD) and Canada (MSC), with a scrubber through them, on OpenFreeMap's map with the buildings in 3D: right drag (or ctrl drag) tilts and turns it, as does a two finger drag on a phone, and the compass puts it back. In Singapore, every station's temperature, humidity, rainfall and wind, NEA's forecast areas as they stood at the time, and lightning; in England, the rain gauges round the place; everywhere, the place's own readings every fifteen minutes.
- **Forecast**: rain over the next 2 hours, the next 24 hours, and the days ahead. In Singapore, NEA's 24-hour forecast and 4-day outlook lead. In England, the nearest rain gauge's last week.
- **Air & heat**: NEA's PSI by region and its pollutants in Singapore, the Norwegian index in Norway, the AQHI in Canada, the US AQI at the stations round the place in China, US AQI by region elsewhere; the UV index through the day; and WBGT heat stress in Singapore, or the feels like temperature everywhere else.

Lightning alerts notify you when lightning is detected near a saved place, by web push and, for browsers linked to the bot, on Telegram. They cover the countries with an open lightning network: Singapore (NEA's strikes, about every two minutes) and Canada (Environment Canada's 2.5 km flash grid, every ten minutes). The bell only shows once a saved place is in one of them. Nothing open covers anywhere else: MET Norway retired its lightning product, and the DWD and the NWS don't publish one.

The last weather seen for each place, and for every saved place, is kept on the device, so the site opens offline with what it last knew.

**Offline maps** (the download button in the tray) keep OpenFreeMap's map on the device, so the Map page still draws it with no connection, light and dark styles both: Singapore down to street level with its buildings in 3D; Malaysia (Peninsular, Sabah and Sarawak) down to town level; and 20 cities down to street level with their buildings in 3D, and their surroundings to zoom 9: Kuala Lumpur, Penang, Johor Bahru, Kota Kinabalu and Kuching (Malaysia's buildings, since all of Malaysia at street level is about 220 MB), Taipei, Kyoto, New York City, Vancouver, San Francisco, Paris, Amsterdam, Rome, Hong Kong, Bangkok, Tokyo, Seoul, London, Barcelona and Sydney. Each is a 10 to 41 MB download, and about 1.5 times that on the device. The radar and the readings over it still need a connection, and OpenStreetMap's tiles, the map's fallback, are never kept: its rules don't allow it. OpenFreeMap allows offline downloads of at most 3,000 tiles or 50 MB, four requests at a time, with a User-Agent naming the app, so they come through `/api/maptile`, which sets one and only fetches what a pack lists. `lib/build-map-packs.mjs` lists each pack's tiles from the country outlines and the city boxes and measures what OpenFreeMap sends (it needs a connection, and stops if a pack is over 3,000 tiles or 45 MB); `node lib/build-map-packs.mjs <id>…` measures only those and writes nothing, for trying a box. The sizes it prints go into `PACKS` in `js/offline.js`.

**Languages**: the language button in the tray (`i18n/`, laid out as in sgmap-explorer). Only English ships, in `i18n/en.json`; the choice is kept in `localStorage` (`locale`), and a first visit follows the browser's language, then English. To add one, say Chinese: copy `i18n/en.json` to `i18n/zh-SG.json` and translate the values only; in `i18n/locales.js`, import it, add it to `locales` and add `{ code: "zh", name: "中文", dir: "ltr" }` to `registry`; add `"/i18n/zh-SG.json"` to `ASSETS` in `sw.js` and bump `VERSION`; then run `node i18n/check-keys.js` in `main-site` to check its keys match. Text from the weather services, place names, units and dates stay as they come.

### Where the data comes from

- Open-Meteo everywhere, with the national service laid over it where there is one, and its marine model for the sea.
- NEA via data.gov.sg in Singapore: stations, forecasts, radar (70, 240 and 480 km), UV, WBGT, lightning, PSI and PM2.5.
- The US National Weather Service (api.weather.gov): observations, hourly and 12-hour forecasts, warnings.
- MET Norway (api.met.no): the forecast and, without a NILU login, air quality. NILU (api.nilu.no) for measured air quality, with `NILU_AUTH`. Both CC BY 4.0.
- Environment and Climate Change Canada (api.weather.gc.ca): city page weather, warnings, AQHI, and GeoMet's radar and lightning grid (the Canadian Lightning Detection Network).
- The Deutscher Wetterdienst through Bright Sky (api.brightsky.dev): observations, MOSMIX hourly forecast, warnings, radar; opendata.dwd.de for the observation when Bright Sky is down. CC BY 4.0.
- England's Environment Agency: Hydrology (environment.data.gov.uk/hydrology) for daily rain totals, which arrive a day late, and flood monitoring for the live fifteen-minute gauges on the map. Open Government Licence v3.0.
- Met Éireann (openaccess.pf.api.met.ie) in Ireland: its point forecast, HARMONIE for two days and ECMWF after. CC BY 4.0.
- MeteoSwiss in Switzerland: SwissMetNet's ten-minute readings (data.geo.admin.ch), and its ICON-CH1/CH2 forecast through Open-Meteo's MeteoSwiss API. MeteoSwiss's post-processed local forecast isn't used: each of its files holds every point in the country, up to 33 MB an hour.
- EUMETNET's MeteoGate (api.meteogate.eu) across Europe, with `METEOGATE_KEY`: the nearest station's reading where the national service above has none of its own, and MeteoAlarm's warnings, kept by the warnings cron. CC BY 4.0.
- Seniverse (api.seniverse.com) in China: the current weather and the days ahead, and the hourly forecast and warnings on a paid plan, with `SENIVERSE_PUBLIC_KEY` and `SENIVERSE_PRIVATE_KEY`.
- The World Air Quality Index Project (api.waqi.info) for China's air quality, from the national monitoring stations round the place, with `WAQI_TOKEN`.
- WeatherAPI.com, OpenWeather and Xweather, in that order, when Open-Meteo doesn't answer, each held to its free plan's budget (`QUOTAS` in `lib/cache.js`).
- RainViewer's radar elsewhere, the last 2 hours, with OpenWeather's or Xweather's current radar when it doesn't answer. RainViewer's API is for personal and educational use only.
- The map: OpenFreeMap's vector tiles (tiles.openfreemap.org, the OpenMapTiles schema over OpenStreetMap's data), its Liberty style in light mode and Dark in dark mode, drawn by MapLibre GL JS 5.24.0 (`vendor/maplibre`, BSD 3-Clause). When OpenFreeMap doesn't answer, OpenStreetMap's own tiles (tile.openstreetmap.org) for the rest of the visit. No key for either. The offline maps are OpenFreeMap's, through `/api/maptile`, within its terms for offline downloads (openfreemap.org/tos).

Looked at and left out: ICHEC (ichec.ie) runs Met Éireann's models on its supercomputers but publishes no API of its own; the Copernicus Climate Data Store serves climate reanalysis through a queue that takes minutes, not weather now.

### Setting it up

1. `npm install`, for `web-push` and `@vercel/blob`.
2. Run `migrations/0001` and `0002` in the Supabase SQL editor. 0002 holds who asked for lightning alerts on Telegram.
3. Set the variables in `.env.example` on the Vercel project: `CRON_SECRET`, `BOT_API_TOKEN` (the same value as the Telegram bot's, which reads its weather from `/api/bot/*` with it), the Upstash pair (`KV_REST_API_URL`, `KV_REST_API_TOKEN`), the VAPID trio (`npx web-push generate-vapid-keys`; a pair of this site's own, not sg-psi's), the keyed fallbacks (`WEATHER_API_KEY`, `OPEN_WEATHER_KEY`, `XWEATHER_CLIENT_ID`, `XWEATHER_CLIENT_SECRET`), for China `SENIVERSE_PUBLIC_KEY`, `SENIVERSE_PRIVATE_KEY` and `WAQI_TOKEN`, and for Europe `METEOGATE_KEY`.
4. Create a Vercel Blob store and connect it to the project, which sets `BLOB_READ_WRITE_TOKEN`.
5. `vercel.json` schedules four crons:
   - `/api/cron/collect`, every minute: checks for new lightning (NEA's every run, Environment Canada's grid three times in each ten minutes) and sends alerts, and stores a snapshot of every station each five minutes, so the map can go back three hours. Without Upstash, the map's scrubber carries rainfall only for earlier times, and alerts are off.
   - `/api/cron/sg`, every minute: keeps NEA's bundle, every NEA radar frame and each 2-hour forecast in Blob, so visitors never wait on data.gov.sg. Needs Blob.
   - `/api/cron/places`, every five minutes: rebuilds the weather of every place looked at in the last day, ten minutes at a time. Needs Upstash and Blob.
   - `/api/cron/warnings`, every ten minutes: takes in the European warnings sent since its last run from MeteoGate, and keeps those in force, with their areas' shapes, in Blob, a file per country. The first run goes back two days and may take two runs. Needs Blob.
6. Bump `VERSION` in `sw.js` on every deploy, or nobody sees the update bar.

## How to Use: General Use
### Search for city
1. Key in your desired city in the search bar
2. Click the "Search" button
### Use current location
1. Click on the "Use my current location" button
2. Allow usage of location permission in your browser (if the popup appears)

## How to Use: Share your current page
1. Click/Tap on your browser's address bar
2. Copy the link (should contain the `city` query) and share to your friends!
3. When you first load into the page, if there is nothing stated in the query, the default query is Singapore. This is not a bug.

## How to Use: Install PWA on Android/iOS device
> **_NOTE:_** When you're on a compatible browser, you should receive a prompt to install the web app onto your mobile device. If you do not receive the prompt, follow these steps.
1. Tap on your browser's options button
2. Tap on "install app" or "add to homescreen"
3. Tap on "Install" in the pop-up

## How to Use: Opening from the installed PWA App
- Tap on the app icon in your homescreen, ***OR***
- Tap and hold on the app icon for shortcuts

## App Version
Google Play: https://play.google.com/store/apps/details?id=com.augystudios.weatherapp

Install APK: https://cloud.kancil.xyz/s/WFy7YymwLJgRb9a

## Special Thanks
[Paxriel](https://paxriel.art/) for general coding help

[OpenWeatherMap](https://openweathermap.org/) for the API

---

[Terms](https://augystudios.com/terms) • [EULA](https://augystudios.com/eula) • [Cookies Policy](https://augystudios.com/cookies) • [Privacy Policy](https://augystudios.com/privacy) • [Report an Issue](mailto:augy@augystudios.com)

Made with 💚 in [Singapore](https://www.google.com/maps/place/Singapore) by Augy Studios 2024
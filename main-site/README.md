# Weather App by Augy Studios
The (finally) open source version of the weather app! (As advertised on Augy Studios Labs)

Currently live on [weather.uwuapps.org](https://weather.uwuapps.org)

## About
Get the latest weather information based on your current location or the city you searched for. Four pages, picked from the tray on the right:

- **Now**: current conditions, air quality and UV. In Singapore, the nearest NEA station's readings and NEA's 2-hour forecast for the area, plus a warning when lightning is close.
- **Map**: the rain radar and, in Singapore, every station's temperature, humidity, rainfall and wind, NEA's forecast areas and lightning, with a scrubber through the last three hours.
- **Forecast**: rain over the next 2 hours, the next 24 hours, and the days ahead. In Singapore, NEA's 24-hour forecast and 4-day outlook lead.
- **Air & heat**: PSI or US AQI by region, the UV index through the day, and WBGT heat stress in Singapore.

Lightning alerts notify you when NEA detects lightning near a saved place in Singapore, by web push and, for browsers linked to the bot, on Telegram.

### Where the data comes from

- Open-Meteo everywhere, and in Singapore wherever NEA can't answer.
- NEA via data.gov.sg in Singapore: stations, forecasts, radar (70, 240 and 480 km), UV, WBGT, lightning, PSI and PM2.5.
- RainViewer's radar outside NEA's 480 km reach, the last 2 hours. RainViewer's API is for personal and educational use only.
- OpenStreetMap tiles under Leaflet.

### Setting it up

1. `npm install`, for `web-push`.
2. Run `migrations/0001` and `0002` in the Supabase SQL editor. 0002 holds who asked for lightning alerts on Telegram.
3. Set the variables in `.env.example` on the Vercel project. The new ones are `CRON_SECRET`, the Upstash pair (`KV_REST_API_URL`, `KV_REST_API_TOKEN`) and the VAPID trio (`npx web-push generate-vapid-keys`). Use a VAPID pair of this site's own, not sg-psi's.
4. `vercel.json` schedules `/api/cron/collect` every minute. It checks for new lightning and sends alerts, and stores a snapshot of every station each five minutes, so the map can go back three hours. Without Upstash, the map's scrubber carries rainfall only for earlier times, and alerts are off.
5. Bump `VERSION` in `sw.js` on every deploy, or nobody sees the update bar.

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

[Terms](https://augystudios.com/terms) • [EULA](https://augystudios.com/eula) • [Cookies Policy](https://augystudios.com/cookies) • [Privacy Policy](https://augystudios.com/privacy) • [Report an Issue](https://forms.gle/4wKTdjgiC6MGX1aN8)

Made with 💚 in [Singapore](https://www.google.com/maps/place/Singapore) by Augy Studios 2024
// main.js - Easter Bunny Tracker (stats + bunny marker + baskets + camera lock, Mapbox version)


// IMPORTANT: Go to SOURCE_TO_API_KEYS.txt to figure out how to fetch/generate each API key.


// =====================
// CONFIG
// =====================
const MAPBOX_TOKEN = "YOUR_MAPBOX_API_KEY"; // <-- put your Mapbox token here
const WEATHERAPI_KEY = "YOUR_WEATHERAPI_KEY"; // <-- put your WeatherAPI token here

const BASKET_START_DR = 77;
const CITY_PANEL_MIN_DR = 77;

const ROUTE_FILE = "data/route.json"

const TAKEOFF_DR = 76;
const PRE_STATUS_MAX_DR = 75;

// Camera settings (in Mapbox zoom levels)
const LOCKED_ZOOM = 4.7;           // zoom when locked to bunny
const UNLOCKED_MIN_ZOOM = 0.1;   // min zoom when unlocked
const UNLOCKED_MAX_ZOOM = 8.0;   // max zoom when unlocked

const STARTUP_GRACE_SEC = 20;

const STANDARD_STYLE = "mapbox://styles/mapbox/standard";
const SATELLITE_STYLE = "mapbox://styles/mapbox/standard-satellite";

const MUSIC_VOLUME = 0.2;

// =====================
// PERSISTENT SETTINGS
// =====================
const SETTINGS_STORAGE_KEY = "eb_tracker_settings_v1";

function loadSettings() {
    try {
        const json = localStorage.getItem(SETTINGS_STORAGE_KEY);
        if (!json) return {};
        const parsed = JSON.parse(json);
        return (parsed && typeof parsed === "object") ? parsed : {};
    } catch (e) {
        console.warn("Failed to load settings from localStorage:", e);
        return {};
    }
}

function saveSettings(partial) {
    try {
        const current = loadSettings();
        const next = { ...current, ...partial };
        localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(next));
    } catch (e) {
        console.warn("Failed to save settings to localStorage:", e);
    }
}

// Read once so we can use defaults below
const initialSettings = loadSettings();

// =====================
// USER SETTINGS (with defaults)
// =====================

// Map style persists
let currentStyle =
    initialSettings.mapStyle === "satellite" ? "satellite" : "standard";

// Travel speed unit persists
let speedUnitMode =
    initialSettings.speedUnitMode === "kmh" ? "kmh" : "mph";

// Streamer mode persists
let streamerModeEnabled = !!initialSettings.streamerModeEnabled;

// Session-only state
let isDelivering = false; // true only while the Bunny is stopped & delivering

// =====================
// GENERIC HELPERS
// =====================
function $(id) {
    return document.getElementById(id);
}

const fmtInt = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
function formatInt(n) {
    if (n === null || n === undefined || Number.isNaN(n)) return "—";
    return fmtInt.format(n);
}

function formatDurationWords(totalSeconds) {
    if (!Number.isFinite(totalSeconds)) return "—";

    let s = Math.max(0, Math.ceil(totalSeconds));

    if (s === 0) return "0 seconds";
    if (s < 2) return "1 second";

    const hours = Math.floor(s / 3600);
    s %= 3600;
    const minutes = Math.floor(s / 60);
    const seconds = s % 60;

    const parts = [];
    if (hours > 0) parts.push(`${hours} ${hours === 1 ? "hour" : "hours"}`);
    if (minutes > 0) parts.push(`${minutes} ${minutes === 1 ? "minute" : "minutes"}`);
    if (seconds > 0 || parts.length === 0) parts.push(`${seconds} ${seconds === 1 ? "second" : "seconds"}`);

    return parts.join(", ");
}

function haversineKm(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

// =====================
// IP-BASED VIEWER LOCATION
// =====================
async function fetchViewerLocationFromIpInfo() {
    try {
        const res = await fetch("https://ipinfo.io/json?token=YOUR_TOKEN_HERE", { // <-- Put your ipinfo.io token here
            cache: "no-store"
        });
        if (!res.ok) throw new Error(`ipinfo.io failed (${res.status})`);

        const data = await res.json();
        if (!data.loc || typeof data.loc !== "string") {
            throw new Error("ipinfo.io response missing 'loc'");
        }

        const [latStr, lonStr] = data.loc.split(",");
        const lat = parseFloat(latStr);
        const lon = parseFloat(lonStr);

        if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
            throw new Error("ipinfo.io returned non-numeric coordinates");
        }

        return { lat, lon };
    } catch (e) {
        console.warn("Failed to get viewer location from ipinfo.io:", e);
        return null;
    }
}

function findClosestStopByLocation(stops, lat, lon) {
    let best = null;
    let bestDistKm = Infinity;

    for (const s of stops) {
        if (!Number.isFinite(s.Latitude) || !Number.isFinite(s.Longitude)) continue;
        const d = haversineKm(lat, lon, s.Latitude, s.Longitude);
        if (d < bestDistKm) {
            bestDistKm = d;
            best = s;
        }
    }

    return best;
}

// =====================
// WEATHER
// =====================
function weatherCodeToText(code) {
    const c = Number(code);
    if (!Number.isFinite(c)) return "Unknown conditions";

    if (c === 0) return "Clear sky";
    if (c === 1 || c === 2) return "Mostly clear";
    if (c === 3) return "Overcast";
    if (c === 45 || c === 48) return "Foggy";
    if (c === 51 || c === 53 || c === 55) return "Light drizzle";
    if (c === 56 || c === 57) return "Freezing drizzle";
    if (c === 61 || c === 63 || c === 65) return "Rain";
    if (c === 66 || c === 67) return "Freezing rain";
    if (c === 71 || c === 73 || c === 75) return "Snow";
    if (c === 77) return "Snow grains";
    if (c === 80 || c === 81 || c === 82) return "Rain showers";
    if (c === 85 || c === 86) return "Snow showers";
    if (c === 95) return "Thunderstorm";
    if (c === 96 || c === 99) return "Thunderstorm with hail";
    return "Unknown conditions";
}

// =====================
// MISC HELPERS
// =====================
function formatViewerEtaText(deltaSeconds) {
    if (!Number.isFinite(deltaSeconds)) return "Unknown";

    // Negative or already very close: treat as "anytime"
    if (deltaSeconds <= 0 || deltaSeconds < 30 * 60) {
        return "anytime";
    }

    const hours = deltaSeconds / 3600;

    // Round to nearest half-hour
    const halfHours = Math.round(hours * 2);
    const roundedHours = halfHours / 2;

    const whole = Math.floor(roundedHours);
    const frac = roundedHours - whole;

    const isHalf = Math.abs(frac - 0.5) < 1e-6;

    if (!isHalf) {
        const n = roundedHours.toFixed(0);
        return `${n} ${n === "1" ? "hour" : "hours"}`;
    }

    if (whole === 0) {
        return "½ hour";
    }

    return `${whole}½ hours`;
}

function lerp(a, b, t) {
    return a + (b - a) * t;
}

function wrapDeltaLon(deg) {
    // normalize to [-180, 180)
    return ((deg + 540) % 360) - 180;
}

function normalizeLon(lon) {
    // normalize to [-180, 180)
    return ((lon + 540) % 360) - 180;
}

function interpolateLatLon(a, b, t) {
    const dLon = wrapDeltaLon(b.Longitude - a.Longitude);
    const lon = normalizeLon(a.Longitude + dLon * t);

    return {
        lat: lerp(a.Latitude, b.Latitude, t),
        lon
    };
}

function cityLabel(stop) {
    const city = stop.City || "Unknown";
    const region = stop.Region ? `, ${stop.Region}` : "";
    return `${city}${region}`;
}

function statusCityLabel(stop) {
    if (!stop) return "Unknown";

    const city = stop.City || "Unknown";
    const region = stop.Region || "";
    const dr = Number(stop.DR);

    // Hide region if DR is below 76
    const hideRegion = Number.isFinite(dr) && dr < 76;

    if (hideRegion || !region) {
        return city; // just "City"
    }

    return `${city}, ${region}`; // "City, Region"
}

function toNum(x) {
    const n = Number(x);
    return Number.isFinite(n) ? n : x;
}

async function loadRoute() {
    const res = await fetch(`./${ROUTE_FILE}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`Failed to load route.json (${res.status})`);
    const data = await res.json();

    let stops = Array.isArray(data) ? data : data.route || data.stops || [];
    if (!Array.isArray(stops)) throw new Error("route.json format not recognized.");

    stops = stops.map((s) => ({
        ...s,
        DR: parseDR(s.DR),
        Latitude: Number(s.Latitude),
        Longitude: Number(s.Longitude),
        EggsDelivered: toNum(s["Eggs Delivered"]),
        CarrotsEaten: toNum(s["Carrots eaten"]),
        UnixArrivalArrival: Number(s["Unix Arrival Arrival"]),
        UnixArrival: Number(s["Unix Arrival"]),
        UnixArrivalDeparture: Number(s["Unix Arrival Departure"]),
        WikipediaUrl: typeof s["Wikipedia attr"] === "string" ? s["Wikipedia attr"] : null,
        Timezone: typeof s["Timezone"] === "string" ? s["Timezone"] : null,

        PopulationNum: Number(s["Population Num"]),
        PopulationYear: toNum(s["Population Year"]),
        ElevationMeter: Number(s["Elevation Meter"])
    }));

    stops.sort((a, b) => a.UnixArrivalArrival - b.UnixArrivalArrival);
    return stops;
}

function clamp01(x) {
    return Math.max(0, Math.min(1, x));
}

function cityOnly(stop) {
    return (stop && stop.City) ? stop.City : "Unknown";
}

// ✅ ADD THESE RIGHT HERE (helpers section)
function safeNum(x) {
    const n = Number(x);
    return Number.isFinite(n) ? n : NaN;
}

function parseDR(v) {
    // best case: already numeric-like
    const n = Number(v);
    if (Number.isFinite(n)) return n;

    // salvage from strings like "76 (TAKEOFF)" or "DR 76"
    const m = String(v ?? "").match(/-?\d+/);
    return m ? Number(m[0]) : NaN;
}

function deliveryStartTime(stop) {
    const aA = safeNum(stop.UnixArrivalArrival);
    const a = safeNum(stop.UnixArrival);

    if (Number.isFinite(a) && Number.isFinite(aA)) return Math.max(aA, a);
    if (Number.isFinite(a)) return a;
    return aA;
}

function deliveryEndTime(stop) {
    const aA = safeNum(stop.UnixArrivalArrival);
    const a = safeNum(stop.UnixArrival);
    const d = safeNum(stop.UnixArrivalDeparture);

    if (Number.isFinite(d)) return d;
    if (Number.isFinite(a)) return a;
    return aA;
}

// =====================
// MAIN INIT (MAPBOX)
// =====================
(async function init() {
    try {
        if (typeof mapboxgl === "undefined") {
            console.error("Mapbox GL JS is undefined. Make sure its script is loaded.");
            return;
        }

        // CHANGE LATER IF YOU WANT PRE-START REDIRECT
        const PRE_JOURNEY_START_UTC_MS = Date.UTC(2026, 3, 5, 6, 0, 0);
        if (Date.now() < PRE_JOURNEY_START_UTC_MS) {
            window.location.replace("index.html");
            return;
        }

        // Show initial "Loading..." if element exists
        const statDurationEl = $("statDuration");
        if (statDurationEl) {
            statDurationEl.textContent = "Loading...";
        }

        $("statStatus").textContent = "Loading route…";
        const stops = await loadRoute();

        // Mapbox basic setup
        mapboxgl.accessToken = MAPBOX_TOKEN;

        const firstStop = stops[0];

        const map = new mapboxgl.Map({
            container: "cesiumContainer",
            style: currentStyle === "satellite" ? SATELLITE_STYLE : STANDARD_STYLE,
            center: [firstStop.Longitude, firstStop.Latitude],
            zoom: LOCKED_ZOOM,
            bearing: 0,
            pitch: 0,
            projection: "globe"
        });

        map.on("style.load", () => {

            // Globe projection must always be re-applied after style changes
            map.setProjection("globe");

            if (currentStyle === "standard") {
                // Built-in dusk lighting
                map.setConfigProperty("basemap", "lightPreset", "dusk");

                // Starry dusk sky
                map.setFog({
                    range: [0.6, 8],
                    color: "rgb(186, 210, 235)",
                    "high-color": "rgb(36, 92, 223)",
                    "horizon-blend": 0.02,
                    "space-color": "rgb(11, 11, 25)",
                    "star-intensity": 0.6
                });
            } else {
                const SPACE = "rgb(5, 5, 12)";

                map.setFog({
                    range: [0.8, 10],
                    color: SPACE,
                    "high-color": SPACE,
                    "horizon-blend": 0,
                    "space-color": SPACE,
                    "star-intensity": 0.6
                });
            }
        });

        // Wait for map load before adding markers or using setMinZoom/setMaxZoom
        await new Promise((resolve) => map.on("load", resolve));

        const mapStyleBtn = document.getElementById("mapStyleBtn");

        function updateMapStyleButton() {
            if (!mapStyleBtn) return;

            const isSatellite = (currentStyle === "satellite");

            mapStyleBtn.setAttribute("aria-pressed", String(isSatellite));
            mapStyleBtn.textContent = isSatellite
                ? "Map style: Satellite"
                : "Map style: Standard";
        }

        function toggleMapStyle() {

            // Save current camera
            const center = map.getCenter();
            const zoom = map.getZoom();
            const bearing = map.getBearing();
            const pitch = map.getPitch();

            // Flip mode
            const toSatellite = (currentStyle === "standard");
            currentStyle = toSatellite ? "satellite" : "standard";

            // Persist new style
            saveSettings({ mapStyle: currentStyle });

            // Update button text/aria to match the *new* currentStyle
            updateMapStyleButton();

            // Apply style (will trigger style.load again)
            map.setStyle(toSatellite ? SATELLITE_STYLE : STANDARD_STYLE);

            // Restore camera as soon as the style finishes loading
            map.once("style.load", () => {
                map.jumpTo({ center, zoom, bearing, pitch });
            });
        }

        if (mapStyleBtn) {
            // Make sure the button reflects the saved style on first load
            updateMapStyleButton();
            mapStyleBtn.addEventListener("click", toggleMapStyle);
        }

        map.setMinZoom(UNLOCKED_MIN_ZOOM);
        map.setMaxZoom(UNLOCKED_MAX_ZOOM);

        // Final DR (journey end)
        const FINAL_DR = 1048;
        const finalStop =
            stops.find(s => Number(s.DR) === FINAL_DR) ||
            stops[stops.length - 1];
        const FINAL_ARRIVAL = Number(finalStop.UnixArrivalArrival);

        // Rows for Status and Arriving in
        const statStatusRow = (() => {
            const v = $("statStatus");
            const row = v ? v.closest(".hud-row") : null;
            return row || null;
        })();

        const statEtaRow = (() => {
            const v = $("statEta");
            const row = v ? v.closest(".hud-row") : null;
            return row || null;
        })();

        // Row for Viewer ETA (statDuration)
        const statDurationRow = (() => {
            const v = $("statDuration");
            const row = v ? v.closest(".hud-row") : null;
            return row || null;
        })();

        // Row for Stop Remaining (statStopRemaining)
        const statStopRemainingRow = (() => {
            const v = $("statStopRemaining");
            const row = v ? v.closest(".hud-row") : null;
            return row || null;
        })();

        // Viewer-location based ETA state
        let viewerLocation = null;
        let viewerClosestStop = null;
        let viewerEtaError = false;

        // City info panel DOM
        const cityPanel = $("cityPanel");
        const cityTitleEl = $("cityTitle");
        const cityLocalTimeEl = $("cityLocalTime");
        const cityWeatherEl = $("cityWeather");
        const cityPopulationEl = $("cityPopulation");
        const cityElevationEl = $("cityElevation");
        const cityDirectionEl = $("cityDirection");

        // =====================
        // CITY PANEL MINIMIZE TOGGLE (persisted) - MATCHES YOUR HTML
        // =====================
        const CITY_PANEL_COLLAPSE_KEY = "eb_cityPanel_collapsed_v1";
        let cityPanelCollapsed = (localStorage.getItem(CITY_PANEL_COLLAPSE_KEY) === "1");

        function applyCityPanelCollapsed() {
            if (!cityPanel) return;

            cityPanel.classList.toggle("is-collapsed", cityPanelCollapsed);

            // Hide/show all rows
            const rows = cityPanel.querySelectorAll(".city-panel-row");
            rows.forEach((r) => {
                r.style.display = cityPanelCollapsed ? "none" : "";
            });

            // Also hide hr + footer when collapsed
            const hr = cityPanel.querySelector("hr");
            if (hr) hr.style.display = cityPanelCollapsed ? "none" : "";

            const footer = cityPanel.querySelector("footer");
            if (footer) footer.style.display = cityPanelCollapsed ? "none" : "";

            // Update button arrow
            const btn = cityPanel.querySelector(".city-collapse-btn");
            if (btn) {
                btn.setAttribute("aria-pressed", String(cityPanelCollapsed));
                btn.textContent = cityPanelCollapsed ? "▾" : "▴";
                btn.title = cityPanelCollapsed ? "Expand" : "Minimize";
                btn.setAttribute("aria-label", cityPanelCollapsed ? "Expand city panel" : "Minimize city panel");
            }
        }

        function initCityPanelCollapseUI() {
            if (!cityPanel) return;

            // Ensure the panel can host an absolutely-positioned button
            const cs = window.getComputedStyle(cityPanel);
            if (cs.position === "static") {
                cityPanel.style.position = "relative";
            }

            // Avoid creating twice
            if (cityPanel.querySelector(".city-collapse-btn")) {
                applyCityPanelCollapsed();
                return;
            }

            // Create button (top-left)
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "city-collapse-btn";

            btn.style.position = "absolute";
            btn.style.top = "6px";
            btn.style.left = "6px";
            btn.style.width = "26px";
            btn.style.height = "26px";
            btn.style.borderRadius = "8px";
            btn.style.border = "1px solid rgba(255,255,255,0.25)";
            btn.style.background = "rgba(0,0,0,0.35)";
            btn.style.color = "white";
            btn.style.cursor = "pointer";
            btn.style.display = "grid";
            btn.style.placeItems = "center";
            btn.style.padding = "0";
            btn.style.zIndex = "2";

            btn.addEventListener("click", () => {
                cityPanelCollapsed = !cityPanelCollapsed;
                localStorage.setItem(CITY_PANEL_COLLAPSE_KEY, cityPanelCollapsed ? "1" : "0");
                applyCityPanelCollapsed();
            });

            cityPanel.appendChild(btn);

            // Apply initial state
            applyCityPanelCollapsed();
        }

        initCityPanelCollapseUI();

        let currentTravelDirection = null;

        // Live city data state
        let currentCityStop = null;
        let currentCityTimezone = null;
        let currentCityWeatherText = null;
        let currentCityWeatherFetchPromise = null;
        let lastSegMode = null;
        let lastSegToIndex = null;

        async function fetchCityLiveWeather(stop) {
            if (!stop || !WEATHERAPI_KEY) return null;

            // Reuse in-flight request if we're already fetching for this stop
            if (currentCityWeatherFetchPromise && currentCityStop === stop) {
                return currentCityWeatherFetchPromise;
            }

            const lat = stop.Latitude;
            const lon = stop.Longitude;
            if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
                return null;
            }

            // WeatherAPI "current weather" endpoint
            const url =
                `https://api.weatherapi.com/v1/current.json` +
                `?key=${encodeURIComponent(WEATHERAPI_KEY)}` +
                `&q=${encodeURIComponent(`${lat},${lon}`)}` +
                `&aqi=no`;

            currentCityWeatherFetchPromise = (async () => {
                try {
                    const res = await fetch(url, { cache: "no-store" });
                    if (!res.ok) throw new Error(`weather HTTP ${res.status}`);

                    const data = await res.json();

                    const tempC = Number(data?.current?.temp_c);
                    const tempF = Number(data?.current?.temp_f);
                    const rawDesc = data?.current?.condition?.text || "";
                    const desc = rawDesc || "Unknown conditions";

                    // Timezone preference: route's Timezone, then WeatherAPI tz_id
                    if (typeof stop.Timezone === "string" && stop.Timezone.trim()) {
                        currentCityTimezone = stop.Timezone.trim();
                    } else if (typeof data?.location?.tz_id === "string" && data.location.tz_id.trim()) {
                        currentCityTimezone = data.location.tz_id.trim();
                    } else {
                        currentCityTimezone = null;
                    }

                    if (Number.isFinite(tempC) && Number.isFinite(tempF)) {
                        currentCityWeatherText =
                            `${tempC.toFixed(1)} °C / ${tempF.toFixed(1)} °F, ${desc}`;
                    } else if (Number.isFinite(tempC)) {
                        const f = (tempC * 9) / 5 + 32;
                        currentCityWeatherText =
                            `${tempC.toFixed(1)} °C / ${f.toFixed(1)} °F, ${desc}`;
                    } else {
                        currentCityWeatherText = desc || "Unknown";
                    }

                    return {
                        timezone: currentCityTimezone,
                        weatherText: currentCityWeatherText
                    };
                } catch (err) {
                    console.warn("City weather fetch failed:", err);

                    if (typeof stop.Timezone === "string" && stop.Timezone.trim()) {
                        currentCityTimezone = stop.Timezone.trim();
                    } else {
                        currentCityTimezone = null;
                    }

                    currentCityWeatherText = "Unknown";
                    return null;
                }
            })();

            return currentCityWeatherFetchPromise;
        }

        // Kick off IP-based location lookup (non-blocking)
        fetchViewerLocationFromIpInfo().then((loc) => {
            if (!loc) {
                viewerEtaError = true;
                if (statDurationEl) statDurationEl.textContent = "Unknown";
                return;
            }

            viewerLocation = loc;
            viewerClosestStop = findClosestStopByLocation(stops, loc.lat, loc.lon);
        }).catch((err) => {
            console.warn("Viewer location lookup failed:", err);
            viewerEtaError = true;
            if (statDurationEl) statDurationEl.textContent = "Unknown";
        });

        // Find when DR 76 (takeoff) begins:
        // Prefer exact DR 76; fallback to first DR >= 76 if exact doesn't exist
        const takeoffStop =
            stops.find(s => Number(s.DR) === TAKEOFF_DR) ||
            stops.find(s => Number(s.DR) >= TAKEOFF_DR);

        const TAKEOFF_ARRIVAL = takeoffStop ? Number(takeoffStop.UnixArrivalArrival) : null;

        // Grab the label span that sits next to #statEta (the first span in that hud-row)
        const statEtaLabelEl = (() => {
            const v = document.getElementById("statEta");
            const row = v ? v.closest(".hud-row") : null;
            return row ? row.querySelector("span:first-child") : null;
        })();

        function setEtaLabel(isBefore77) {
            if (!statEtaLabelEl) return;
            statEtaLabelEl.textContent = isBefore77 ? "Countdown to takeoff:" : "Arriving in:";
        }

        function setViewerEtaVisibility(enabled) {
            // enabled = true means show, false means hide
            if (statDurationRow) statDurationRow.style.display = enabled ? "" : "none";
        }

        function setStopRemainingVisibility(enabled) {
            // enabled = true means show, false means hide
            if (statStopRemainingRow) statStopRemainingRow.style.display = enabled ? "" : "none";
        }

        // =====================
        // MAP MARKERS (BUNNY + BASKETS)
        // =====================
        let bunnyMarker = null;
        const basketMarkers = new Map();

        function createBunnyMarker(initialStop) {
            // Outer container for bunny + shadow
            const container = document.createElement("div");
            container.style.position = "relative";
            container.style.width = "40px";
            container.style.height = "40px";
            container.style.pointerEvents = "none";

            // Shadow element (between map and bunny image)
            const shadow = document.createElement("div");
            shadow.style.position = "absolute";
            shadow.style.left = "50%";
            shadow.style.bottom = "4px"; // just under the bunny
            shadow.style.transform = "translateX(-50%)";
            shadow.style.width = "36px";
            shadow.style.height = "22px";
            shadow.style.borderRadius = "50%";
            shadow.style.background = "radial-gradient(circle, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0) 70%)";
            shadow.style.filter = "blur(1px)";
            shadow.style.opacity = "0.8";

            // Bunny image itself
            const img = document.createElement("img");
            img.src = "assets/img/Bunny.png";
            img.alt = "Easter Bunny";
            img.style.position = "absolute";
            img.style.left = "50%";
            img.style.bottom = "0";
            img.style.transform = "translateX(-50%) translateY(4px)";
            img.style.width = "37px";
            img.style.height = "37px";
            img.style.pointerEvents = "none";

            container.appendChild(shadow);
            container.appendChild(img);

            bunnyMarker = new mapboxgl.Marker({
                element: container,
                anchor: "bottom"
            })
                .setLngLat([initialStop.Longitude, initialStop.Latitude])
                .addTo(map);
        }

        function updateBunnyPosition(lon, lat) {
            if (!bunnyMarker) return;
            bunnyMarker.setLngLat([lon, lat]);
        }

        function addBasketForStop(stop) {
            const dr = Number(stop.DR);
            if (Number.isFinite(dr) && dr < BASKET_START_DR) return;

            const key = stop.DR ?? `${stop.UnixArrival}`;
            if (basketMarkers.has(key)) return;

            const cityName = cityLabel(stop);

            // Default: just show the city name
            let descHtml = cityName;

            // If we have a Wikipedia URL, make the city name a clickable link
            if (stop.WikipediaUrl) {
                const safeUrl = stop.WikipediaUrl;
                descHtml =
                    `More info: <a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${cityName}</a>`;
            }

            const img = document.createElement("img");
            img.src = "assets/img/Basket.png";
            img.alt = cityName;
            img.style.width = "24px";
            img.style.height = "24px";

            const marker = new mapboxgl.Marker({
                element: img,
                anchor: "bottom"
            })
                .setLngLat([stop.Longitude, stop.Latitude]);

            const popup = new mapboxgl.Popup({ offset: 24 }).setHTML(descHtml);
            marker.setPopup(popup);

            marker.addTo(map);
            basketMarkers.set(key, marker);
        }

        createBunnyMarker(firstStop);

        // =====================
        // Egg pop FX (Egg.png above bunny while delivering)
        // =====================
        const eggImg = document.createElement("img");
        eggImg.src = "assets/img/Egg.png";
        eggImg.alt = "";
        eggImg.style.position = "absolute";
        eggImg.style.width = "22px";
        eggImg.style.height = "26px";
        eggImg.style.pointerEvents = "none";
        eggImg.style.opacity = "0";          // start invisible
        eggImg.style.zIndex = "2";           // above map, below HUD (HUD is 9999)
        eggImg.style.transform = "translate(-50%, -100%)"; // center horizontally, above point

        document.body.appendChild(eggImg);

        function updateEggFx(timestamp) {
            if (!bunnyMarker) {
                requestAnimationFrame(updateEggFx);
                return;
            }

            // If not delivering, keep egg hidden
            if (!isDelivering) {
                eggImg.style.opacity = "0";
                requestAnimationFrame(updateEggFx);
                return;
            }

            // 0..1 phase repeating every second
            const phase = (timestamp / 1000) % 1;
            const fadeIn = 0.15;
            const fadeOut = 0.20;

            let a = 1;
            if (phase < fadeIn) {
                a = phase / fadeIn;                      // fade in
            } else if (phase > 1 - fadeOut) {
                a = (1 - phase) / fadeOut;              // fade out
            }

            // Base position = bunny screen position
            const lngLat = bunnyMarker.getLngLat();
            const pt = map.project(lngLat);

            const risePx = phase * 28;                // how high it floats per cycle
            const baseAboveBunny = 44;                // px above bunny "head"

            eggImg.style.left = `${pt.x}px`;
            eggImg.style.top = `${pt.y - baseAboveBunny - risePx}px`;
            eggImg.style.opacity = `${Math.max(0, Math.min(1, a))}`;

            requestAnimationFrame(updateEggFx);
        }

        // Start the animation loop
        requestAnimationFrame(updateEggFx);

        // =====================
        // CAMERA LOCK STATE (not persisted; always defaults to locked)
        // =====================
        let isLocked = true;

        function setLocked(nextLocked) {
            isLocked = !!nextLocked;

            const btn = $("lockBtn");
            if (btn) {
                btn.setAttribute("aria-pressed", String(isLocked));
                btn.textContent = isLocked ? "🔓 Unlock Camera" : "🔒 Lock to Bunny";
                btn.title = isLocked ? "Unlock camera" : "Lock camera to Bunny";
            }

            if (isLocked) {
                // Disable user interaction
                map.dragPan.disable();
                map.scrollZoom.disable();
                map.boxZoom.disable();
                map.dragRotate.disable();
                map.keyboard.disable();
                map.doubleClickZoom.disable();
                map.touchZoomRotate.disable();

                // Center on bunny
                if (bunnyMarker) {
                    const ll = bunnyMarker.getLngLat();
                    map.easeTo({
                        center: ll,
                        zoom: LOCKED_ZOOM,
                        pitch: 0,
                        bearing: 0,
                        duration: 800
                    });
                }
            } else {
                // Enable interaction
                map.dragPan.enable();
                map.scrollZoom.enable();
                map.boxZoom.enable();
                map.dragRotate.enable();
                map.keyboard.enable();
                map.doubleClickZoom.enable();
                map.touchZoomRotate.enable();

                map.setMinZoom(UNLOCKED_MIN_ZOOM);
                map.setMaxZoom(UNLOCKED_MAX_ZOOM);
            }
        }

        function followBunnyIfLocked() {
            if (!isLocked || !bunnyMarker) return;
            const ll = bunnyMarker.getLngLat();
            map.jumpTo({
                center: ll,
                zoom: LOCKED_ZOOM,
                pitch: 0,
                bearing: 0
            });
        }

        // Start LOCKED by default every page load
        setLocked(true);

        // =====================
        // HUD + SETTINGS
        // =====================
        function updateHUD({
            status,
            lastText,
            etaSeconds,
            etaText,                 // optional override
            stopRemainingSeconds,
            speedKmh,
            speedMph,
            eggs,
            carrots
        }) {
            $("statStatus").textContent = status ?? "—";
            $("statLast").textContent = lastText ?? "—";

            $("statEta").textContent = (typeof etaText === "string")
                ? etaText
                : formatDurationWords(etaSeconds);

            $("statStopRemaining").textContent = formatDurationWords(stopRemainingSeconds);

            if (Number.isFinite(speedKmh) && Number.isFinite(speedMph)) {
                const kmRounded = Math.round(speedKmh);
                const mphRounded = Math.round(speedMph);

                const kmStr = Math.abs(kmRounded) >= 1000
                    ? formatInt(kmRounded)
                    : kmRounded.toString();

                const mphStr = Math.abs(mphRounded) >= 1000
                    ? formatInt(mphRounded)
                    : mphRounded.toString();

                let speedText;
                if (speedUnitMode === "kmh") {
                    speedText = `${kmStr} km/h`;
                } else {
                    speedText = `${mphStr} mph`;
                }

                $("statSpeed").textContent = speedText;
            } else {
                $("statSpeed").textContent = "—";
            }

            $("statEggs").textContent = formatInt(eggs);
            $("statCarrots").textContent = formatInt(carrots);
        }

        function findSegment(now) {
            const n = stops.length;
            if (!n) return { mode: "pre" };

            const EPS = 0.5;

            function getDr(i) {
                return Number(stops[i]?.DR);
            }

            // For DR>=76 we treat:
            // - "approach/arrive window" as [UnixArrivalArrival .. UnixArrival)
            // - "deliver window" as [UnixArrival .. UnixArrivalDeparture)
            function stopApproachEnd(i) {
                const s = stops[i];
                const aA = Number(s.UnixArrivalArrival);
                const a = Number(s.UnixArrival);

                // If UnixArrival is valid and after ArrivalArrival, use it as the end of "approach"
                if (Number.isFinite(aA) && Number.isFinite(a) && a > aA) return a;

                // Fallback: no distinct arrival moment -> treat approach as 0 seconds long
                return aA;
            }

            function stopDeliverEnd(i) {
                const s = stops[i];
                const aA = Number(s.UnixArrivalArrival);
                const a = Number(s.UnixArrival);
                const d = Number(s.UnixArrivalDeparture);

                // normal preference order
                let end =
                    (Number.isFinite(d) ? d :
                        (Number.isFinite(a) ? a : aA));

                // ✅ IMPORTANT: if this is DR 76 and it's effectively a 0-second stop,
                // create a small "takeoff window" so segment math doesn't collapse.
                const dr = Number(s.DR);
                if (Number.isFinite(dr) && dr === TAKEOFF_DR && Number.isFinite(aA)) {
                    if (!Number.isFinite(end) || end <= aA + 0.5) {
                        end = aA + 8;
                    }
                }

                return end;
            }

            // -----------------------------
            // PART A: DR <= 75 "status checkpoints"
            // (ONLY before takeoff moment)
            // -----------------------------
            const allowPreTimeline =
                !(Number.isFinite(TAKEOFF_ARRIVAL) && now >= (TAKEOFF_ARRIVAL - EPS));

            if (allowPreTimeline) {
                let bestIdx = -1;
                let bestTime = -Infinity;

                for (let i = 0; i < n; i++) {
                    const dr = getDr(i);
                    if (!Number.isFinite(dr) || dr > PRE_STATUS_MAX_DR) continue;

                    const t = Number(stops[i].UnixArrivalArrival);
                    if (!Number.isFinite(t)) continue;

                    if (t <= now + EPS && t > bestTime) {
                        bestTime = t;
                        bestIdx = i;
                    }
                }

                if (bestIdx !== -1) return { mode: "stop", i: bestIdx };

                const firstA = Number(stops[0].UnixArrivalArrival);
                if (Number.isFinite(firstA) && now < firstA - EPS) return { mode: "pre" };
            }

            // -----------------------------
            // PART B: DR >= 76 logic
            // -----------------------------
            for (let i = 0; i < n; i++) {
                const s = stops[i];

                const dr = getDr(i);
                const aA = Number(s.UnixArrivalArrival);
                if (!Number.isFinite(aA)) continue;

                const isPostTakeoff = Number.isFinite(dr) && dr >= TAKEOFF_DR;

                if (isPostTakeoff) {
                    const approachEnd = stopApproachEnd(i); // usually UnixArrival
                    const deliverEnd = stopDeliverEnd(i);   // usually UnixArrivalDeparture

                    // Stop window = from ArrivalArrival until Departure (covers "arrived" + "delivering")
                    if (now >= aA - EPS && now < deliverEnd - EPS) {
                        return { mode: "stop", i };
                    }

                    // Travel window = from this stop’s departure to next stop’s ArrivalArrival
                    if (i + 1 < n) {
                        const nextA = Number(stops[i + 1].UnixArrivalArrival);
                        if (Number.isFinite(nextA)) {
                            const departT = deliverEnd;
                            if (now >= departT - EPS && now < nextA - EPS) {
                                return { mode: "travel", from: i, to: i + 1 };
                            }
                        }
                    }
                } else {
                    // Pre-takeoff fallback behavior for any stray DR<76 records:
                    // Stop window uses ArrivalArrival->Departure like before
                    const d = Number(s.UnixArrivalDeparture);
                    const end = (Number.isFinite(d) && d > aA) ? d : aA;

                    if (now >= aA - EPS && now < end - EPS) {
                        return { mode: "stop", i };
                    }

                    if (i + 1 < n) {
                        const nextA = Number(stops[i + 1].UnixArrivalArrival);
                        if (Number.isFinite(nextA)) {
                            const departT = end;
                            if (now >= departT - EPS && now < nextA - EPS) {
                                return { mode: "travel", from: i, to: i + 1 };
                            }
                        }
                    }
                }
            }

            return { mode: "stop", i: n - 1 };
        }

        function isBeforeDR77ForSegment(seg, stops) {
            if (seg.mode === "pre") return true;

            if (seg.mode === "travel") {
                const to = stops[seg.to];
                const dr = Number(to?.DR);
                return Number.isFinite(dr) && dr < BASKET_START_DR;
            }

            if (seg.mode === "stop") {
                const s = stops[seg.i];
                const dr = Number(s?.DR);
                return Number.isFinite(dr) && dr < BASKET_START_DR;
            }

            return false;
        }

        function isBeforeDR76ForSegment(seg, stops) {
            if (seg.mode === "pre") return true;

            if (seg.mode === "travel") {
                const to = stops[seg.to];
                const dr = Number(to?.DR);
                return Number.isFinite(dr) && dr < TAKEOFF_DR; // TAKEOFF_DR is 76
            }

            if (seg.mode === "stop") {
                const s = stops[seg.i];
                const dr = Number(s?.DR);
                return Number.isFinite(dr) && dr < TAKEOFF_DR;
            }

            return false;
        }

        // ETA override:
        // Before TAKEOFF_ARRIVAL (DR 76), statEta counts down to DR 76.
        // After that, statEta counts down to "next" like normal.
        function etaForHUD(now, normalEtaSeconds) {
            if (Number.isFinite(TAKEOFF_ARRIVAL) && now < TAKEOFF_ARRIVAL) {
                return TAKEOFF_ARRIVAL - now;
            }
            return normalEtaSeconds;
        }

        function updateViewerLocationEta(now) {
            const el = $("statDuration");
            if (!el) return;

            // If the row is hidden, don't waste work or set any text
            if (statDurationRow && statDurationRow.style.display === "none") {
                return;
            }

            if (streamerModeEnabled) {
                el.textContent = "HIDDEN | S.M. enabled";
                return;
            }

            // If we failed earlier
            if (viewerEtaError) {
                if (!el.textContent || el.textContent === "Loading...") {
                    el.textContent = "Unknown";
                }
                return;
            }

            // Still resolving IP / closest stop
            if (!viewerClosestStop) {
                return;
            }

            const arrival = Number(viewerClosestStop.UnixArrivalArrival);
            if (!Number.isFinite(arrival)) {
                el.textContent = "Unknown";
                return;
            }

            const deltaSeconds = arrival - now;
            const text = formatViewerEtaText(deltaSeconds);

            el.textContent = text;
        }

        function computeTravelDirection(fromStop, toStop) {
            if (!fromStop || !toStop) return null;

            const lat1 = fromStop.Latitude;
            const lon1 = fromStop.Longitude;
            const lat2 = toStop.Latitude;
            const lon2 = toStop.Longitude;

            if (
                !Number.isFinite(lat1) || !Number.isFinite(lon1) ||
                !Number.isFinite(lat2) || !Number.isFinite(lon2)
            ) {
                return null;
            }

            const toRad = (d) => (d * Math.PI) / 180;
            const toDeg = (r) => (r * 180) / Math.PI;

            const φ1 = toRad(lat1);
            const φ2 = toRad(lat2);
            const Δλ = toRad(lon2 - lon1);

            const y = Math.sin(Δλ) * Math.cos(φ2);
            const x =
                Math.cos(φ1) * Math.sin(φ2) -
                Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);

            let brng = toDeg(Math.atan2(y, x)); // -180..+180
            brng = (brng + 360) % 360;          // 0..360, 0 = North

            const labels = [
                "North",
                "North-East",
                "East",
                "South-East",
                "South",
                "South-West",
                "West",
                "North-West"
            ];

            const arrows = [
                "↑",  // North
                "↗",  // NE
                "→",  // E
                "↘",  // SE
                "↓",  // S
                "↙",  // SW
                "←",  // W
                "↖"   // NW
            ];

            const sector = Math.round(brng / 45) % 8;
            return {
                text: labels[sector],
                arrow: arrows[sector]
            };
        }

        function updateCityPanel(now, seg) {
            if (!cityPanel) return;

            // Hide if journey complete
            if (Number.isFinite(FINAL_ARRIVAL) && now >= FINAL_ARRIVAL) {
                cityPanel.hidden = true;
                currentCityStop = null;
                applyCityPanelCollapsed();
                return;
            }

            // Decide which stop represents the "current city"
            let s = null;

            if (seg && seg.mode === "stop") {
                s = stops[seg.i];
            } else if (seg && seg.mode === "travel") {
                s = stops[seg.to];
            } else {
                // PRE-JOURNEY (seg.mode === "pre") → show first stop
                s = stops[0];
            }

            if (!s) {
                cityPanel.hidden = true;
                currentCityStop = null;
                return;
            }

            const dr = Number(s.DR);
            // Only show for DR >= CITY_PANEL_MIN_DR
            if (!Number.isFinite(dr) || dr < CITY_PANEL_MIN_DR) {
                cityPanel.hidden = true;
                currentCityStop = null;
                return;
            }

            cityPanel.hidden = false;
            currentCityStop = s;

            // Title: "Information about City"
            if (cityTitleEl) {
                const city = s.City || "Unknown city";
                cityTitleEl.textContent = `Information about: ${city}`;
            }

            if (cityPopulationEl) {
                const pop = Number(s.PopulationNum);
                const year = s.PopulationYear;

                if (Number.isFinite(pop) && pop > 0) {
                    cityPopulationEl.textContent = year
                        ? `${formatInt(pop)} (as of ${year})`
                        : formatInt(pop);
                } else {
                    cityPopulationEl.textContent = "Unknown";
                }
            }

            if (cityElevationEl) {
                const elev = Number(s.ElevationMeter);
                if (Number.isFinite(elev)) {
                    cityElevationEl.textContent = `${formatInt(elev)} meters`;
                } else {
                    cityElevationEl.textContent = "Unknown";
                }
            }

            if (cityDirectionEl) {
                if (currentTravelDirection) {
                    cityDirectionEl.textContent =
                        `${currentTravelDirection.arrow} | ${currentTravelDirection.text}`;
                } else {
                    cityDirectionEl.textContent = "N/A";
                }
            }

            if (cityLocalTimeEl) {
                if (currentCityTimezone) {
                    const nowDate = new Date();
                    try {
                        cityLocalTimeEl.textContent = nowDate.toLocaleTimeString(undefined, {
                            timeZone: currentCityTimezone,
                            hour: "numeric",
                            minute: "2-digit"
                        });
                    } catch {
                        cityLocalTimeEl.textContent = nowDate.toLocaleTimeString(undefined, {
                            hour: "numeric",
                            minute: "2-digit"
                        });
                    }
                } else {
                    cityLocalTimeEl.textContent = "Loading…";
                }
            }

            if (cityWeatherEl) {
                if (currentCityWeatherText) {
                    cityWeatherEl.textContent = currentCityWeatherText;
                } else {
                    cityWeatherEl.textContent = "Loading…";
                }
            }

            if (currentCityStop === s && !currentCityWeatherText) {
                fetchCityLiveWeather(s).then((info) => {
                    if (!info) {
                        if (cityWeatherEl) cityWeatherEl.textContent = "Unknown";
                        if (cityLocalTimeEl && !currentCityTimezone) {
                            cityLocalTimeEl.textContent = "Unknown";
                        }
                        return;
                    }

                    if (cityWeatherEl) cityWeatherEl.textContent = info.weatherText || "Unknown";

                    if (cityLocalTimeEl && info.timezone) {
                        const nowDate = new Date();
                        try {
                            cityLocalTimeEl.textContent = nowDate.toLocaleTimeString(undefined, {
                                timeZone: info.timezone,
                                hour: "numeric",
                                minute: "2-digit"
                            });
                        } catch {
                            cityLocalTimeEl.textContent = nowDate.toLocaleTimeString(undefined, {
                                hour: "numeric",
                                minute: "2-digit"
                            });
                        }
                    }
                });
            }
        }

        // =====================
        // HELP MODAL
        // =====================
        const helpBtn = $("helpBtn");
        const helpOverlay = $("helpOverlay");
        const helpCloseBtn = $("helpCloseBtn");

        function openHelp() {
            if (!helpOverlay) return;
            helpOverlay.classList.add("is-open");
            helpOverlay.setAttribute("aria-hidden", "false");

            const activeTab = helpOverlay.querySelector(".help-tab.is-active");
            if (activeTab) activeTab.focus();
        }

        function closeHelp() {
            if (!helpOverlay) return;
            helpOverlay.classList.remove("is-open");
            helpOverlay.setAttribute("aria-hidden", "true");
            if (helpBtn) helpBtn.focus();
        }

        function setHelpTab(tabKey) {
            if (!helpOverlay) return;

            const tabs = helpOverlay.querySelectorAll(".help-tab");
            const panes = helpOverlay.querySelectorAll(".help-pane");

            tabs.forEach((t) => t.classList.toggle("is-active", t.dataset.tab === tabKey));
            panes.forEach((p) => p.classList.toggle("is-active", p.dataset.pane === tabKey));
        }

        if (helpBtn) helpBtn.addEventListener("click", openHelp);
        if (helpCloseBtn) helpCloseBtn.addEventListener("click", closeHelp);

        const helpTabs = helpOverlay ? helpOverlay.querySelector(".help-tabs") : null;
        if (helpTabs) {
            helpTabs.addEventListener("click", (e) => {
                const btn = e.target.closest(".help-tab");
                if (!btn) return;
                e.preventDefault();
                setHelpTab(btn.dataset.tab);
            });
        }

        window.addEventListener("keydown", (e) => {
            if (e.key !== "Escape") return;
            if (!helpOverlay) return;
            if (!helpOverlay.classList.contains("is-open")) return;
            closeHelp();
        });

        // =====================
        // BACKGROUND MUSIC
        // =====================
        let musicEnabled =
            (typeof initialSettings.musicEnabled === "boolean")
                ? initialSettings.musicEnabled
                : true; // default: on
        let bgAudio = null;
        let musicResumePending = false;

        function initBgMusic() {
            if (bgAudio) return;

            bgAudio = new Audio("assets/audio/music.mp3");
            bgAudio.loop = false;
            bgAudio.volume = MUSIC_VOLUME;

            bgAudio.addEventListener("ended", () => {
                if (!musicEnabled) return;
                setTimeout(() => {
                    if (!musicEnabled || !bgAudio) return;
                    try {
                        bgAudio.currentTime = 0;
                        const p = bgAudio.play();
                        if (p && typeof p.then === "function") {
                            p.then(() => {
                                musicResumePending = false;
                            }).catch(() => {
                                musicResumePending = true;
                            });
                        }
                    } catch (e) {
                        console.warn("Background music replay failed:", e);
                        musicResumePending = true;
                    }
                }, 1000);
            });

            // ⬇⬇ IMPORTANT: don't autoplay if user has music off
            if (!musicEnabled) {
                // Just keep the audio object ready; no play() call.
                musicResumePending = false;
                return;
            }

            try {
                const p = bgAudio.play();
                if (p && typeof p.then === "function") {
                    p.then(() => {
                        musicResumePending = false;
                    }).catch((err) => {
                        console.warn("Autoplay for background music was blocked by the browser:", err);
                        musicResumePending = true;
                    });
                }
            } catch (e) {
                console.warn("Background music initial play failed:", e);
                musicResumePending = true;
            }
        }

        function setMusicEnabled(next) {
            musicEnabled = !!next;
            saveSettings({ musicEnabled });

            const btn = $("musicToggleBtn");
            if (btn) {
                btn.setAttribute("aria-pressed", String(musicEnabled));
                btn.textContent = musicEnabled ? "Music: On" : "Music: Off";
            }

            if (!bgAudio) {
                if (musicEnabled) {
                    initBgMusic();
                }
                return;
            }

            if (musicEnabled) {
                try {
                    const p = bgAudio.play();
                    if (p && typeof p.then === "function") {
                        p.then(() => {
                            musicResumePending = false;
                        }).catch(() => {
                            musicResumePending = true;
                        });
                    }
                } catch (e) {
                    console.warn("Background music play failed:", e);
                    musicResumePending = true;
                }
            } else {
                bgAudio.pause();
                musicResumePending = false;
            }
        }

        function handleUserInteractionForMusic() {
            if (!musicEnabled || !bgAudio || !musicResumePending) return;

            musicResumePending = false;
            try {
                const p = bgAudio.play();
                if (p && typeof p.then === "function") {
                    p.catch(() => {
                        // ignore
                    });
                }
            } catch (e) {
                console.warn("Background music resume on interaction failed:", e);
            }
        }

        ["pointerdown", "click", "keydown", "touchstart"].forEach((ev) => {
            window.addEventListener(ev, handleUserInteractionForMusic, { passive: true });
        });

        const musicToggleBtn = $("musicToggleBtn");
        if (musicToggleBtn) {
            musicToggleBtn.addEventListener("click", () => {
                setMusicEnabled(!musicEnabled);
                if (musicEnabled && !bgAudio) {
                    initBgMusic();
                }
            });
        }

        // Start with previously saved music setting (default: on)
        setMusicEnabled(musicEnabled);
        initBgMusic();

        // =====================
        // SETTINGS BUTTONS
        // =====================
        function updateSpeedUnitButton() {
            const btn = $("travelSpeedTypeBtn");
            if (!btn) return;

            const isMph = (speedUnitMode === "mph");

            btn.setAttribute("aria-pressed", String(isMph));
            btn.textContent = isMph
                ? "Distance converted in: MPH"
                : "Distance converted in: KM/H";
        }

        const travelSpeedTypeBtn = $("travelSpeedTypeBtn");
        if (travelSpeedTypeBtn) {
            travelSpeedTypeBtn.addEventListener("click", () => {
                speedUnitMode = (speedUnitMode === "mph") ? "kmh" : "mph";
                saveSettings({ speedUnitMode });      // persist units
                updateSpeedUnitButton();
            });
        }
        updateSpeedUnitButton();

        function updateStreamerModeButton() {
            const btn = $("streamerModeBtn");
            if (!btn) return;

            btn.setAttribute("aria-pressed", String(streamerModeEnabled));
            btn.textContent = streamerModeEnabled
                ? "Streamer Mode: Enabled"
                : "Streamer Mode: Disabled";
        }

        const streamerModeBtn = $("streamerModeBtn");
        if (streamerModeBtn) {
            streamerModeBtn.addEventListener("click", () => {
                streamerModeEnabled = !streamerModeEnabled;
                saveSettings({ streamerModeEnabled });   // persist
                updateStreamerModeButton();

                updateViewerLocationEta(Date.now() / 1000);
            });
        }
        updateStreamerModeButton();

        const lockBtn = $("lockBtn");
        if (lockBtn) {
            lockBtn.addEventListener("click", () => setLocked(!isLocked));
        }

        // =====================
        // TICK LOOP
        // =====================
        function tick() {
            const now = Date.now() / 1000; // keep fractional seconds

            isDelivering = false;

            const seg = findSegment(now);

            if (seg.mode === "travel") {
                const isNewTravelSegment =
                    lastSegMode !== "travel" || lastSegToIndex !== seg.to;

                if (isNewTravelSegment) {
                    const nextStop = stops[seg.to];
                    if (nextStop) {
                        // Reset cached weather state for the new destination
                        currentCityStop = nextStop;
                        currentCityWeatherText = null;
                        currentCityWeatherFetchPromise = null;

                        // Kick off a live weather fetch for the destination city
                        fetchCityLiveWeather(nextStop);
                    }
                }

                lastSegMode = "travel";
                lastSegToIndex = seg.to;
            } else {
                // Not traveling (pre or stop); just remember the mode
                lastSegMode = seg.mode;
                lastSegToIndex = null;
            }

            // Always add baskets for completed stops, even after DR 1048
            for (const s of stops) {
                if (now >= s.UnixArrivalDeparture) addBasketForStop(s);
                else break;
            }

            const journeyComplete =
                Number.isFinite(FINAL_ARRIVAL) && now >= FINAL_ARRIVAL;

            if (journeyComplete) {
                if (cityPanel) cityPanel.hidden = true;

                // Park bunny at the final stop
                updateBunnyPosition(finalStop.Longitude, finalStop.Latitude);

                // Hide Status and Arriving in rows
                if (statStatusRow) statStatusRow.style.display = "none";
                if (statEtaRow) statEtaRow.style.display = "none";

                // Freeze eggs/carrots at final values
                updateHUD({
                    status: "",
                    lastText: cityLabel(finalStop),
                    etaSeconds: NaN,
                    etaText: "",
                    stopRemainingSeconds: NaN,
                    speedKmh: NaN,
                    speedMph: NaN,
                    eggs: finalStop.EggsDelivered,
                    carrots: finalStop.CarrotsEaten
                });

                followBunnyIfLocked();
                updateViewerLocationEta(now);
                return;
            }

            const before76 = isBeforeDR76ForSegment(seg, stops);
            setEtaLabel(before76);

            const before77 = isBeforeDR77ForSegment(seg, stops);
            setViewerEtaVisibility(!before77);
            setStopRemainingVisibility(!before77);

            if (seg.mode === "pre") {
                const first = stops[0];
                updateBunnyPosition(first.Longitude, first.Latitude);

                updateHUD({
                    status: "Preparing for takeoff…",
                    lastText: "N/A",
                    nextText: before77 ? cityOnly(first) : cityLabel(first),
                    etaSeconds: etaForHUD(now, first.UnixArrivalArrival - now),
                    stopRemainingSeconds: NaN,
                    speedKmh: NaN,
                    speedMph: NaN,
                    eggs: 0,
                    carrots: 0
                });

                followBunnyIfLocked();
                currentTravelDirection = null;
                updateViewerLocationEta(now);
                updateCityPanel(now, seg);
                return;
            }

            if (seg.mode === "stop") {
                const s = stops[seg.i];
                const next = stops[Math.min(seg.i + 1, stops.length - 1)];

                const drNow = Number(s.DR);

                if (Number.isFinite(drNow) && drNow === TAKEOFF_DR) {
                    // Treat DR 76 as "taking off / first hop" instead of "delivering"
                    isDelivering = false;

                    // Keep bunny exactly on the takeoff point during the takeoff window
                    updateBunnyPosition(s.Longitude, s.Latitude);

                    // Count down to the first delivery hop (next stop) if it exists
                    const nextA = next ? Number(next.UnixArrivalArrival) : NaN;
                    const eta = (Number.isFinite(nextA)) ? (nextA - now) : NaN;

                    updateHUD({
                        status: "Takeoff clearance granted — lifting off!",
                        lastText: "N/A",
                        etaSeconds: eta,
                        stopRemainingSeconds: NaN,
                        speedKmh: NaN,
                        speedMph: NaN,
                        eggs: 0,
                        carrots: 0
                    });

                    // Make the lock feel “real” at the moment of takeoff
                    followBunnyIfLocked();
                    currentTravelDirection = null;
                    updateViewerLocationEta(now);
                    updateCityPanel(now, seg);
                    return;
                }
                const preTakeoffStop = Number.isFinite(drNow) && drNow < TAKEOFF_DR;

                // If DR < 76, NEVER deliver (keeps Egg FX off too)
                isDelivering = !preTakeoffStop;

                updateBunnyPosition(s.Longitude, s.Latitude);

                if (preTakeoffStop) {
                    updateHUD({
                        status: s.City || "Preparing…",
                        lastText: "N/A",
                        etaSeconds: etaForHUD(now, NaN),      // etaForHUD will return TAKEOFF_ARRIVAL-now while now<TAKEOFF_ARRIVAL
                        stopRemainingSeconds: NaN,
                        speedKmh: NaN,
                        speedMph: NaN,
                        eggs: 0,
                        carrots: 0
                    });

                    followBunnyIfLocked();
                    currentTravelDirection = null;
                    updateViewerLocationEta(now);
                    updateCityPanel(now, seg);
                    return;
                }

                const stopRemaining = s.UnixArrivalDeparture - now;

                let speedKmh = NaN;
                let speedMph = NaN;
                let prevEggsTotal = 0;
                let prevCarrotsTotal = 0;

                if (seg.i > 0) {
                    const prev = stops[seg.i - 1];

                    const distKm = haversineKm(prev.Latitude, prev.Longitude, s.Latitude, s.Longitude);
                    const travelSec = Math.max(1, s.UnixArrivalArrival - prev.UnixArrivalDeparture);
                    speedKmh = (distKm / travelSec) * 3600;
                    speedMph = speedKmh * 0.621371;

                    prevEggsTotal = Number(prev.EggsDelivered) || 0;
                    prevCarrotsTotal = Number(prev.CarrotsEaten) || 0;
                }

                const cityEggsTotal = Number(s.EggsDelivered) || prevEggsTotal;
                const cityCarrotsTotal = Number(s.CarrotsEaten) || prevCarrotsTotal;

                // ✅ ORIGINAL interpolation: whole stop uses ArrivalArrival -> Departure
                const stopDuration = Math.max(1, s.UnixArrivalDeparture - s.UnixArrivalArrival);
                const stopT = clamp01((now - s.UnixArrivalArrival) / stopDuration);

                const eggsNow = lerp(prevEggsTotal, cityEggsTotal, stopT);
                const carrotsNow = lerp(prevCarrotsTotal, cityCarrotsTotal, stopT);

                updateHUD({
                    status: `Delivering in ${s.City}`,
                    lastText: before77 ? "N/A" : (seg.i > 0 ? cityLabel(stops[seg.i - 1]) : "—"),
                    nextText: next ? (before77 ? cityOnly(next) : cityLabel(next)) : "—",
                    etaText: `Currently delivering eggs in ${s.City}`,
                    etaSeconds: NaN,
                    stopRemainingSeconds: stopRemaining,
                    speedKmh,
                    speedMph,
                    eggs: eggsNow,
                    carrots: carrotsNow
                });

                followBunnyIfLocked();
                currentTravelDirection = null;
            } else if (seg.mode === "travel") {
                const from = stops[seg.from];
                const to = stops[seg.to];
                if (!from || !to) return;

                const toDr = Number(to.DR);
                const preTakeoffTravel = Number.isFinite(toDr) && toDr < TAKEOFF_DR;

                const showRegionInStatus = Number.isFinite(toDr) && toDr >= 76;
                const destinationLabelForStatus = showRegionInStatus
                    ? cityLabel(to)
                    : cityOnly(to);

                // If DR < 76: just show label (no "Heading to:")
                const statusText = preTakeoffTravel
                    ? (to.City || "Preparing…")
                    : `Heading to: ${destinationLabelForStatus}`;

                const departT = from.UnixArrivalDeparture;
                const arriveT = to.UnixArrivalArrival;
                const denom = Math.max(1, arriveT - departT);
                const t = clamp01((now - departT) / denom);

                const pos = interpolateLatLon(from, to, t);
                updateBunnyPosition(pos.lon, pos.lat);

                const distKm = haversineKm(from.Latitude, from.Longitude, to.Latitude, to.Longitude);
                const speedKmh = preTakeoffTravel ? NaN : (distKm / denom) * 3600;
                const speedMph = preTakeoffTravel ? NaN : (speedKmh * 0.621371);

                const eggs = preTakeoffTravel
                    ? 0
                    : lerp(Number(from.EggsDelivered) || 0, Number(to.EggsDelivered) || 0, t);

                const carrots = preTakeoffTravel
                    ? 0
                    : lerp(Number(from.CarrotsEaten) || 0, Number(to.CarrotsEaten) || 0, t);

                updateHUD({
                    status: statusText,
                    lastText: before77 ? "N/A" : cityLabel(from),
                    nextText: before77 ? cityOnly(to) : cityLabel(to),
                    etaSeconds: etaForHUD(now, arriveT - now),
                    stopRemainingSeconds: NaN,
                    speedKmh,
                    speedMph,
                    eggs,
                    carrots
                });

                followBunnyIfLocked();
                currentTravelDirection = computeTravelDirection(from, to);
            }

            updateViewerLocationEta(now);
            updateCityPanel(now, seg);
        }

        tick();
        setInterval(tick, 250);

        console.log(`Loaded route with ${stops.length} stops (Mapbox globe).`);
    } catch (e) {
        console.error("Tracker init failed:", e);
        const el = document.getElementById("statStatus");
        if (el) el.textContent = "Error (see console)";
    }
})();
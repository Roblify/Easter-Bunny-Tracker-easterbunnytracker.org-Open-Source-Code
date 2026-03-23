/* =============================================================================
 *  Easter Bunny Tracker  —  main.js
 *
 *  Sections:
 *    1. Configuration
 *    2. Settings  (localStorage persistence)
 *    3. User Preferences  (defaults from saved settings)
 *    4. Utilities  (pure helpers — no side-effects)
 *       4a. Number / String formatting
 *       4b. Math / Interpolation
 *       4c. Geographic math
 *    5. Data Helpers  (stop accessors, label builders)
 *    6. Route Loading
 *    7. Segment Logic  ← the brain of the tracker
 *    8. Viewer Location  (IP-based, non-blocking)
 *    9. Application Init  (Mapbox map, HUD, markers, tick loop)
 * ============================================================================= */

"use strict";


/* =============================================================================
 *  1. CONFIGURATION
 * ============================================================================= */

const MAPBOX_TOKEN = "YOUR_MAPBOX_API_KEY";

// NOTE: IPInfo tokens cannot be truly hidden in client-side JavaScript — any
// visitor can read the page source or intercept the network request and extract
// the token regardless of how it is encoded.  The only proper solution is to
// proxy the IPInfo request through your own server-side endpoint (e.g. a
// Cloudflare Worker or serverless function) so the token never reaches the
// browser.  Until then, restrict this token to your domain in the IPInfo
// dashboard (ipinfo.io → Token settings → "Allowed domains") to limit misuse.
const _IPT         = atob("YOUR_IPINFO_TOKEN");

const ROUTE_FILE = "data/route.json";

// Delivery-readiness thresholds (DR values)
const BASKET_START_DR = 77;
const CITY_PANEL_MIN_DR = 77;
const TAKEOFF_DR = 76;
const PRE_STATUS_MAX_DR = 75;
const FINAL_DR = 1048;
 
// Other tracker variables
let speedJitter = 0;
 
// Mapbox zoom levels
const LOCKED_ZOOM = 5.2;   // zoom during active delivery (DR >= 76)
const LOCKED_ZOOM_PRE = 3.5;   // zoom before DR 76 and at final stop
const UNLOCKED_MIN_ZOOM = 0.1;
const UNLOCKED_MAX_ZOOM = 13.0;
 
// Cinematic camera
const CINEMATIC_ZOOM_DEFAULT = 6;
const CINEMATIC_LOCKED_PITCH = 67;
const CINEMATIC_SIDE_OFFSET_DEFAULT_DEG = 30;
 
// Map styles
const STANDARD_STYLE = "mapbox://styles/mapbox/standard";
const SATELLITE_STYLE = "mapbox://styles/theroblify/cmmqvyxfl00as01sugspqf5d5";
 
const MUSIC_VOLUME = 0.2;
 
 
/* =============================================================================
 *  2. SETTINGS  (localStorage persistence)
 * ============================================================================= */
 
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
        const next = { ...loadSettings(), ...partial };
        localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(next));
    } catch (e) {
        console.warn("Failed to save settings to localStorage:", e);
    }
}
 
// Read once on startup so preference defaults can reference it
const initialSettings = loadSettings();
 
 
/* =============================================================================
 *  3. USER PREFERENCES  (with persisted defaults)
 * ============================================================================= */
 
let currentStyle = (initialSettings.mapStyle === "standard" || initialSettings.mapStyle === "satellite")
    ? initialSettings.mapStyle
    : "satellite";
 
let speedUnitMode = initialSettings.speedUnitMode === "kmh" ? "kmh" : "mph";
 
let streamerModeEnabled = !!initialSettings.streamerModeEnabled;
let cinematicCamEnabled = !!initialSettings.cinematicCamEnabled;
 
let cinematicSideOffsetDeg = Number.isFinite(Number(initialSettings.cinematicSideOffsetDeg))
    ? Math.max(0, Math.min(180, Number(initialSettings.cinematicSideOffsetDeg)))
    : CINEMATIC_SIDE_OFFSET_DEFAULT_DEG;
 
let cinematicZoom = Number.isFinite(Number(initialSettings.cinematicZoom))
    ? Math.max(1, Math.min(10, Number(initialSettings.cinematicZoom)))
    : CINEMATIC_ZOOM_DEFAULT;
 
let mapDimensionMode = (initialSettings.mapDimensionMode === "2d" || initialSettings.mapDimensionMode === "3d")
    ? initialSettings.mapDimensionMode
    : "2d";
 
 
/* =============================================================================
 *  4. UTILITIES  (pure helpers — no side-effects)
 * ============================================================================= */
 
/** Shorthand for document.getElementById */
function $(id) { return document.getElementById(id); }
 
 
// -- 4a. Number / String formatting ------------------------------------------
 
const _fmtInt = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
 
function formatInt(n) {
    if (n === null || n === undefined || Number.isNaN(n)) return "\u2014";
    return _fmtInt.format(n);
}
 
function formatDurationWords(totalSeconds) {
    if (!Number.isFinite(totalSeconds)) return "\u2014";
 
    let s = Math.max(0, Math.round(totalSeconds));
    if (s === 0) return "0 seconds";
    if (s < 2) return "1 second";
 
    const hours = Math.floor(s / 3600);
    s %= 3600;
    const minutes = Math.floor(s / 60);
    const seconds = s % 60;
 
    const parts = [];
    if (hours > 0) parts.push(`${hours} ${hours === 1 ? "hour" : "hours"}`);
    if (minutes > 0) parts.push(`${minutes} ${minutes === 1 ? "minute" : "minutes"}`);
    if (seconds > 0 || parts.length === 0)
        parts.push(`${seconds} ${seconds === 1 ? "second" : "seconds"}`);
 
    return parts.join(", ");
}
 
function formatViewerEtaText(deltaSeconds) {
    if (!Number.isFinite(deltaSeconds)) return "Unknown";
    if (deltaSeconds <= 0 || deltaSeconds < 30 * 60) return "anytime";
 
    const halfHours = Math.round((deltaSeconds / 3600) * 2);
    const rounded = halfHours / 2;
    const whole = Math.floor(rounded);
    const isHalf = Math.abs(rounded - whole - 0.5) < 1e-6;
 
    if (!isHalf) return `${rounded.toFixed(0)} ${rounded.toFixed(0) === "1" ? "hour" : "hours"}`;
    if (whole === 0) return "\u00bd hour";
    return `${whole}\u00bd hours`;
}
 
 
// -- 4b. Math / Interpolation -------------------------------------------------
 
function clamp01(x) { return Math.max(0, Math.min(1, x)); }
function lerp(a, b, t) { return a + (b - a) * t; }
function wrapDeltaLon(deg) { return ((deg + 540) % 360) - 180; }
function normalizeLon(lon) { return ((lon + 540) % 360) - 180; }
 
function clampZoom1to10(v) {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(1, Math.min(10, Math.round(n * 10) / 10)) : CINEMATIC_ZOOM_DEFAULT;
}
 
function clampDeg0to180(v) {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(0, Math.min(180, Math.round(n))) : CINEMATIC_SIDE_OFFSET_DEFAULT_DEG;
}
 
function interpolateLatLon(a, b, t) {
    const dLon = wrapDeltaLon(b.Longitude - a.Longitude);
    return {
        lat: lerp(a.Latitude, b.Latitude, t),
        lon: normalizeLon(a.Longitude + dLon * t)
    };
}
 
 
// -- 4c. Geographic math ------------------------------------------------------
 
function haversineKm(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const toRad = d => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
 
/** Returns the initial bearing (0-360 degrees) from point 1 to point 2. */
function bearingDeg(lat1, lon1, lat2, lon2) {
    const toRad = d => (d * Math.PI) / 180;
    const toDeg = r => (r * 180) / Math.PI;
    const phi1 = toRad(lat1), phi2 = toRad(lat2);
    const deltaLambda = toRad(lon2 - lon1);
    const y = Math.sin(deltaLambda) * Math.cos(phi2);
    const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(deltaLambda);
    return (toDeg(Math.atan2(y, x)) + 360) % 360;
}
 
/** Returns a { text, arrow } cardinal direction for the travel leg between two stops. */
function computeTravelDirection(fromStop, toStop) {
    if (!fromStop || !toStop) return null;
 
    const { Latitude: lat1, Longitude: lon1 } = fromStop;
    const { Latitude: lat2, Longitude: lon2 } = toStop;
    if (![lat1, lon1, lat2, lon2].every(Number.isFinite)) return null;
 
    const labels = ["North", "North-East", "East", "South-East", "South", "South-West", "West", "North-West"];
    const arrows = ["\u2191", "\u2197", "\u2192", "\u2198", "\u2193", "\u2199", "\u2190", "\u2196"];
    const sector = Math.round(bearingDeg(lat1, lon1, lat2, lon2) / 45) % 8;
 
    return { text: labels[sector], arrow: arrows[sector] };
}
 
 
/* =============================================================================
 *  5. DATA HELPERS  (stop accessors, label builders)
 * ============================================================================= */
 
function toNum(x) { const n = Number(x); return Number.isFinite(n) ? n : x; }
function safeNum(x) { const n = Number(x); return Number.isFinite(n) ? n : NaN; }
 
function parseDR(v) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
    const m = String(v ?? "").match(/-?\d+/);
    return m ? Number(m[0]) : NaN;
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
    return (Number.isFinite(dr) && dr < 76) || !region ? city : `${city}, ${region}`;
}
 
function cityOnly(stop) {
    return (stop && stop.City) ? stop.City : "Unknown";
}
 
function deliveryStartTime(stop) {
    const aA = safeNum(stop.UnixArrivalArrival);
    const a = safeNum(stop.UnixArrival);
    if (Number.isFinite(a) && Number.isFinite(aA)) return Math.max(aA, a);
    return Number.isFinite(a) ? a : aA;
}
 
function deliveryEndTime(stop) {
    const aA = safeNum(stop.UnixArrivalArrival);
    const a = safeNum(stop.UnixArrival);
    const d = safeNum(stop.UnixArrivalDeparture);
    if (Number.isFinite(d)) return d;
    if (Number.isFinite(a)) return a;
    return aA;
}
 
 
/* =============================================================================
 *  6. ROUTE LOADING
 * ============================================================================= */
 
async function loadRoute() {
    const res = await fetch(`./${ROUTE_FILE}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`Failed to load route.json (${res.status})`);
 
    const data = await res.json();
    let stops = Array.isArray(data) ? data : data.route || data.stops || [];
    if (!Array.isArray(stops)) throw new Error("route.json format not recognized.");
 
    stops = stops.map(s => ({
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
 
 
/* =============================================================================
 *  7. SEGMENT LOGIC  <- the brain of the tracker
 *
 *  findSegment(now, stops, takeoffArrival) classifies the current moment into:
 *    { mode: "pre" }                          -- before the journey starts
 *    { mode: "stop",   i }                    -- bunny is at stop i
 *    { mode: "travel", from: i, to: i+1 }     -- bunny is flying between stops
 * ============================================================================= */
 
function findSegment(now, stops, takeoffArrival) {
    const n = stops.length;
    if (!n) return { mode: "pre" };
 
    const EPS = 0.1;
 
    const getDr = i => Number(stops[i]?.DR);
 
    const stopDeliverEnd = i => {
        const s = stops[i];
        const aA = Number(s.UnixArrivalArrival);
        const a = Number(s.UnixArrival);
        const d = Number(s.UnixArrivalDeparture);
        let end = Number.isFinite(d) ? d : (Number.isFinite(a) ? a : aA);
 
        // Takeoff stop gets a small extra window so the "lifting off" status shows briefly
        const dr = Number(s.DR);
        if (Number.isFinite(dr) && dr === TAKEOFF_DR && Number.isFinite(aA)) {
            if (!Number.isFinite(end) || end <= aA + 0.5) end = aA + 8;
        }
        return end;
    };
 
    // -- Pre-timeline phase ---------------------------------------------------
    const allowPreTimeline = !(Number.isFinite(takeoffArrival) && now >= takeoffArrival - EPS);
 
    if (allowPreTimeline) {
        let bestIdx = -1;
        let bestTime = -Infinity;
 
        for (let i = 0; i < n; i++) {
            const dr = getDr(i);
            if (!Number.isFinite(dr) || dr > PRE_STATUS_MAX_DR) continue;
 
            const t = Number(stops[i].UnixArrivalArrival);
            if (!Number.isFinite(t)) continue;
 
            if (t <= now + EPS && t > bestTime) { bestTime = t; bestIdx = i; }
        }
 
        if (bestIdx !== -1) return { mode: "stop", i: bestIdx };
 
        const firstA = Number(stops[0].UnixArrivalArrival);
        if (Number.isFinite(firstA) && now < firstA - EPS) return { mode: "pre" };
    }
 
    // -- Main delivery timeline -----------------------------------------------
    for (let i = 0; i < n; i++) {
        const s = stops[i];
        const dr = getDr(i);
        const aA = Number(s.UnixArrivalArrival);
        if (!Number.isFinite(aA)) continue;
 
        if (Number.isFinite(dr) && dr >= TAKEOFF_DR) {
            // Post-takeoff stop
            const deliverEnd = stopDeliverEnd(i);
            if (now >= aA - EPS && now < deliverEnd - EPS) return { mode: "stop", i };
 
            if (i + 1 < n) {
                const nextA = Number(stops[i + 1].UnixArrivalArrival);
                if (Number.isFinite(nextA) && now >= deliverEnd - EPS && now < nextA - EPS) {
                    return { mode: "travel", from: i, to: i + 1 };
                }
            }
        } else {
            // Pre-takeoff stop
            const d = Number(s.UnixArrivalDeparture);
            const end = (Number.isFinite(d) && d > aA) ? d : aA;
 
            if (now >= aA - EPS && now < end - EPS) return { mode: "stop", i };
 
            if (i + 1 < n) {
                const nextA = Number(stops[i + 1].UnixArrivalArrival);
                if (Number.isFinite(nextA) && now >= end - EPS && now < nextA - EPS) {
                    return { mode: "travel", from: i, to: i + 1 };
                }
            }
        }
    }
 
    return { mode: "stop", i: n - 1 };
}
 
 
// -- Segment classification helpers ------------------------------------------
 
function segmentDR(seg, stops) {
    if (seg.mode === "stop") return Number(stops[seg.i]?.DR ?? null);
    if (seg.mode === "travel") return Number(stops[seg.to]?.DR ?? null);
    return null; // "pre"
}
 
function isBeforeDR(seg, stops, threshold) {
    if (seg.mode === "pre") return true;
    const dr = segmentDR(seg, stops);
    return Number.isFinite(dr) && dr < threshold;
}
 
function isBeforeDR77ForSegment(seg, stops) { return isBeforeDR(seg, stops, BASKET_START_DR); }
function isBeforeDR76ForSegment(seg, stops) { return isBeforeDR(seg, stops, TAKEOFF_DR); }
 
function etaForHUD(now, normalEtaSeconds, takeoffArrival) {
    if (Number.isFinite(takeoffArrival) && now < takeoffArrival) return takeoffArrival - now;
    return normalEtaSeconds;
}
 
 
/* =============================================================================
 *  8. VIEWER LOCATION  (IP-based, non-blocking)
 * ============================================================================= */
 
async function fetchViewerLocationFromIpInfo() {
    try {
        const res = await fetch(`https://ipinfo.io/json?token=${_IPT}`, { cache: "no-store" });
        if (!res.ok) throw new Error(`ipinfo.io failed (${res.status})`);
 
        const data = await res.json();
        if (!data.loc || typeof data.loc !== "string") throw new Error("ipinfo.io response missing 'loc'");
 
        const [latStr, lonStr] = data.loc.split(",");
        const lat = parseFloat(latStr);
        const lon = parseFloat(lonStr);
 
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error("ipinfo.io returned non-numeric coordinates");
 
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
        if (d < bestDistKm) { bestDistKm = d; best = s; }
    }
 
    return best;
}
 
 
/* =============================================================================
 *  9. APPLICATION INIT  (Mapbox map, HUD, markers, tick loop)
 * ============================================================================= */
 
(async function init() {
    try {
 
        // -- Pre-journey gate --------------------------------------------------
        // Redirects anyone who visits before April 4 2026 at 06:00 UTC back to index.html.
        // Remove or disable this once the journey is live.
        const PRE_JOURNEY_START_UTC_MS = Date.UTC(2026, 3, 4, 6, 0, 0);
        if (Date.now() < PRE_JOURNEY_START_UTC_MS) {
            window.location.replace("index.html");
            return;
        }
 
        if (typeof mapboxgl === "undefined") {
            console.error("Mapbox GL JS is undefined. Make sure its script is loaded.");
            return;
        }
 
        // -- Boot -------------------------------------------------------------
 
        const statDurationEl = $("statDuration");
        if (statDurationEl) statDurationEl.textContent = "Loading...";
        $("statStatus").textContent = "Loading route\u2026";
 
        const stops = await loadRoute();
 
        // -- Mapbox setup -----------------------------------------------------
 
        mapboxgl.accessToken = MAPBOX_TOKEN;
        const firstStop = stops[0];
 
        const map = new mapboxgl.Map({
            container: "cesiumContainer",
            style: currentStyle === "satellite" ? SATELLITE_STYLE : STANDARD_STYLE,
            center: [firstStop.Longitude, firstStop.Latitude],
            zoom: LOCKED_ZOOM,
            bearing: 0,
            pitch: 0,
            projection: mapDimensionMode === "3d" ? "globe" : "mercator"
        });
 
        // -- Session state -----------------------------------------------------
        // NOTE: isLocked is declared HERE, before applyMapDimensionMode, so that
        // function can safely reference it when style.load fires early.
 
        let isLocked = true;
 
        // -- Map dimension (2D / 3D) -------------------------------------------
 
        function applyMapDimensionMode() {
            if (mapDimensionMode === "3d") {
                map.setProjection("globe");
 
                if (currentStyle === "standard") {
                    map.setFog({
                        range: [0.6, 8], color: "rgb(186, 210, 235)",
                        "high-color": "rgb(36, 92, 223)", "horizon-blend": 0.02,
                        "space-color": "rgb(11, 11, 25)", "star-intensity": 0.6
                    });
                } else {
                    const SPACE = "rgb(5, 5, 12)";
                    map.setFog({
                        range: [0.8, 10], color: SPACE, "high-color": SPACE,
                        "horizon-blend": 0, "space-color": SPACE, "star-intensity": 0.6
                    });
                }
            } else {
                map.setProjection("mercator");
                map.setFog(null);
                if (isLocked && !cinematicCamEnabled) {
                    map.easeTo({ pitch: 0, bearing: 0, duration: 400 });
                }
            }
        }
 
        map.on("style.load", () => {
            applyMapDimensionMode();
            if (currentStyle === "standard") map.setConfigProperty("basemap", "lightPreset", "dusk");
 
            // -- Hide roads ---------------------------------------------------
            // Try the component-based config property first (Standard / Standard-Satellite styles)
            try {
                map.setConfigProperty("basemap", "showRoadLabels", false);
            } catch (e) {
                // Not supported on this style -- that's fine
            }
 
            // Also hide any traditional road layers that are present in the style
            const layers = map.getStyle().layers;
            for (const layer of layers) {
                const id = (layer.id || "").toLowerCase();
                const sl = (layer["source-layer"] || "").toLowerCase();
                if (id.includes("road") || sl.includes("road")) {
                    map.setLayoutProperty(layer.id, "visibility", "none");
                }
            }
        });
 
        await new Promise(resolve => map.on("load", resolve));
 
        map.setMinZoom(UNLOCKED_MIN_ZOOM);
        map.setMaxZoom(UNLOCKED_MAX_ZOOM);
 
        // -- Route sentinels --------------------------------------------------
 
        const finalStop = stops.find(s => Number(s.DR) === FINAL_DR) || stops[stops.length - 1];
        const FINAL_ARRIVAL = Number(finalStop.UnixArrivalArrival);
 
        const takeoffStop = stops.find(s => Number(s.DR) === TAKEOFF_DR) || stops.find(s => Number(s.DR) >= TAKEOFF_DR);
        const TAKEOFF_ARRIVAL = takeoffStop ? Number(takeoffStop.UnixArrivalArrival) : null;
 
        // -- Remaining session state -------------------------------------------
 
        let isDelivering = false;
        let currentSegDR = null;
        let currentTravelBearingDeg = 0;
        let currentTravelDirection = null;
        let cinematicBearing = 0;
        let lastSegMode = null;
        let lastSegToIndex = null;
 
        // Viewer-location ETA state
        let viewerLocation = null;
        let viewerClosestStop = null;
        let viewerEtaError = false;
 
        // City panel state
        let currentCityStop = null;
        let currentCityTimezone = null;
 
        // -- Camera lock ------------------------------------------------------
 
        function getLockedZoom() {
            if (currentSegDR !== null && Number.isFinite(currentSegDR)) {
                if (currentSegDR < TAKEOFF_DR) return LOCKED_ZOOM_PRE;
                if (currentSegDR === FINAL_DR) return LOCKED_ZOOM_PRE;
            }
            return LOCKED_ZOOM;
        }
 
        function followBunnyIfLocked() {
            if (!isLocked || !bunnyMarker) return;
            const useCine = cinematicCamEnabled;
            map.jumpTo({
                center: bunnyMarker.getLngLat(),
                zoom: useCine ? cinematicZoom : getLockedZoom(),
                pitch: useCine ? CINEMATIC_LOCKED_PITCH : 0,
                bearing: useCine ? cinematicBearing : 0
            });
        }
 
        function setLocked(nextLocked) {
            isLocked = !!nextLocked;
 
            const btn = $("lockBtn");
            if (btn) {
                btn.setAttribute("aria-pressed", String(isLocked));
                btn.textContent = isLocked ? "\uD83D\uDD13 Unlock Camera" : "\uD83D\uDD12 Lock to Bunny";
                btn.title = isLocked ? "Unlock camera" : "Lock camera to Bunny";
            }
 
            if (isLocked) {
                map.dragPan.disable();
                map.scrollZoom.disable();
                map.boxZoom.disable();
                map.dragRotate.disable();
                map.keyboard.disable();
                map.doubleClickZoom.disable();
                map.touchZoomRotate.disable();
 
                if (bunnyMarker) {
                    const useCine = cinematicCamEnabled;
                    map.easeTo({
                        center: bunnyMarker.getLngLat(),
                        zoom: useCine ? cinematicZoom : getLockedZoom(),
                        pitch: useCine ? CINEMATIC_LOCKED_PITCH : 0,
                        bearing: useCine ? cinematicBearing : 0,
                        duration: 800
                    });
                }
            } else {
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
 
        // -- Markers ----------------------------------------------------------
 
        let bunnyMarker = null;
        const basketMarkers = new Map();
 
        function createBunnyMarker(stop) {
            const container = document.createElement("div");
            container.style.cssText = "position:relative;width:40px;height:40px;pointer-events:none;";
 
            const shadow = document.createElement("div");
            shadow.style.cssText = [
                "position:absolute", "left:50%", "bottom:4px",
                "transform:translateX(-50%)", "width:36px", "height:22px",
                "border-radius:50%",
                "background:radial-gradient(circle,rgba(0,0,0,.55) 0%,rgba(0,0,0,0) 70%)",
                "filter:blur(1px)", "opacity:.8"
            ].join(";");
 
            const img = document.createElement("img");
            img.src = "assets/img/Bunny.png";
            img.alt = "Easter Bunny";
            img.style.cssText = [
                "position:absolute", "left:50%", "bottom:0",
                "transform:translateX(-50%) translateY(4px)",
                "width:37px", "height:37px", "pointer-events:none"
            ].join(";");
 
            container.appendChild(shadow);
            container.appendChild(img);
 
            bunnyMarker = new mapboxgl.Marker({ element: container, anchor: "bottom" })
                .setLngLat([stop.Longitude, stop.Latitude])
                .addTo(map);
        }
 
        function updateBunnyPosition(lon, lat) {
            if (bunnyMarker) bunnyMarker.setLngLat([lon, lat]);
        }
 
        function addBasketForStop(stop) {
            const dr = Number(stop.DR);
            if (Number.isFinite(dr) && dr < BASKET_START_DR) return;
 
            const key = stop.DR ?? `${stop.UnixArrival}`;
            if (basketMarkers.has(key)) return;
 
            const cityName = cityLabel(stop);
            const descHtml = stop.WikipediaUrl
                ? `<span style="color:#333;">More info:</span> <a href="${stop.WikipediaUrl}" target="_blank" rel="noopener noreferrer">${cityName}</a>`
                : cityName;
 
            const img = document.createElement("img");
            img.src = "assets/img/Basket.png";
            img.alt = cityName;
            img.style.cssText = "width:24px;height:24px;";
 
            const marker = new mapboxgl.Marker({ element: img, anchor: "bottom" })
                .setLngLat([stop.Longitude, stop.Latitude])
                .setPopup(new mapboxgl.Popup({ offset: 24 }).setHTML(descHtml))
                .addTo(map);
 
            basketMarkers.set(key, marker);
        }
 
        createBunnyMarker(firstStop);
        setLocked(true);
 
        // -- Egg delivery FX --------------------------------------------------
 
        const eggImg = document.createElement("img");
        eggImg.src = "assets/img/Egg.png";
        eggImg.alt = "";
        eggImg.style.cssText = [
            "position:absolute", "width:22px", "height:26px",
            "pointer-events:none", "opacity:0", "z-index:2",
            "transform:translate(-50%,-100%)"
        ].join(";");
        document.body.appendChild(eggImg);
 
        function animateEgg(timestamp) {
            if (!bunnyMarker || !isDelivering) {
                eggImg.style.opacity = "0";
                requestAnimationFrame(animateEgg);
                return;
            }
 
            const phase = (timestamp / 1000) % 1;
            const fadeIn = 0.15;
            const fadeOut = 0.20;
 
            let a = 1;
            if (phase < fadeIn) a = phase / fadeIn;
            else if (phase > 1 - fadeOut) a = (1 - phase) / fadeOut;
 
            const pt = map.project(bunnyMarker.getLngLat());
            const risePx = phase * 28;
 
            eggImg.style.left = `${pt.x}px`;
            eggImg.style.top = `${pt.y - 44 - risePx}px`;
            eggImg.style.opacity = `${Math.max(0, Math.min(1, a))}`;
 
            requestAnimationFrame(animateEgg);
        }
 
        requestAnimationFrame(animateEgg);
 
        // -- HUD DOM refs -----------------------------------------------------
 
        const statStatusRow = $("statStatus")?.closest(".hud-row") ?? null;
        const statEtaRow = $("statEta")?.closest(".hud-row") ?? null;
        const statDurationRow = $("statDuration")?.closest(".hud-row") ?? null;
        const statStopRemainingRow = $("statStopRemaining")?.closest(".hud-row") ?? null;
 
        const statEtaLabelEl = (() => {
            const row = $("statEta")?.closest(".hud-row");
            return row ? row.querySelector("span:first-child") : null;
        })();
 
        // -- HUD update functions ---------------------------------------------
 
        function setEtaLabel(isBefore77) {
            if (statEtaLabelEl) statEtaLabelEl.textContent = isBefore77 ? "Countdown to takeoff:" : "Arriving in:";
        }
 
        function setViewerEtaVisibility(show) {
            if (statDurationRow) statDurationRow.style.display = show ? "" : "none";
        }
 
        function setStopRemainingVisibility(show) {
            if (statStopRemainingRow) statStopRemainingRow.style.display = show ? "" : "none";
        }
 
        function updateHUD({ status, lastText, etaSeconds, etaText, stopRemainingSeconds, speedKmh, speedMph, eggs, carrots }) {
            $("statStatus").textContent = status ?? "\u2014";
            $("statLast").textContent = lastText ?? "\u2014";
 
            $("statEta").textContent = typeof etaText === "string"
                ? etaText
                : formatDurationWords(etaSeconds);
 
            $("statStopRemaining").textContent = formatDurationWords(stopRemainingSeconds);
 
            if (Number.isFinite(speedKmh) && Number.isFinite(speedMph)) {
                const km = Math.round(speedKmh);
                const mph = Math.round(speedMph);
 
                $("statSpeed").textContent = speedUnitMode === "kmh"
                    ? `${Math.abs(km) >= 1000 ? formatInt(km) : km} km/h`
                    : `${Math.abs(mph) >= 1000 ? formatInt(mph) : mph} mph`;
            } else {
                $("statSpeed").textContent = "\u2014";
            }
 
            $("statEggs").textContent = formatInt(eggs);
            $("statCarrots").textContent = formatInt(carrots);
        }
 
        function updateViewerLocationEta(now) {
            if (!statDurationEl) return;
            if (statDurationRow?.style.display === "none") return;
 
            if (streamerModeEnabled) {
                statDurationEl.textContent = "HIDDEN | S.M. enabled";
                return;
            }
            if (viewerEtaError) {
                if (!statDurationEl.textContent || statDurationEl.textContent === "Loading...") {
                    statDurationEl.textContent = "Unknown";
                }
                return;
            }
            if (!viewerClosestStop) return;
 
            const arrival = Number(viewerClosestStop.UnixArrivalArrival);
            statDurationEl.textContent = Number.isFinite(arrival)
                ? formatViewerEtaText(arrival - now)
                : "Unknown";
        }
 
        // -- City panel -------------------------------------------------------
 
        const cityPanel = $("cityPanel");
        const cityTitleEl = $("cityTitle");
        const cityLocalTimeEl = $("cityLocalTime");
        const cityWeatherEl = $("cityWeather");
        const cityPopulationEl = $("cityPopulation");
        const cityElevationEl = $("cityElevation");
        const cityDirectionEl = $("cityDirection");
 
        // City panel collapse state resets on every load — only the user's
        // show/hide preference (set via the external button) is persisted.
        let cityPanelCollapsed = false;
 
        function applyCityPanelCollapsed() {
            if (!cityPanel) return;
            cityPanel.classList.toggle("is-collapsed", cityPanelCollapsed);
 
            cityPanel.querySelectorAll(".city-panel-row").forEach(r => {
                r.style.display = cityPanelCollapsed ? "none" : "";
            });
 
            const hr = cityPanel.querySelector("hr");
            const footer = cityPanel.querySelector("footer");
            if (hr) hr.style.display = cityPanelCollapsed ? "none" : "";
            if (footer) footer.style.display = cityPanelCollapsed ? "none" : "";
 
            const btn = cityPanel.querySelector(".city-collapse-btn");
            if (btn) {
                btn.setAttribute("aria-pressed", String(cityPanelCollapsed));
                btn.textContent = cityPanelCollapsed ? "\u25be" : "\u25b4";
                btn.title = cityPanelCollapsed ? "Expand" : "Minimize";
                btn.setAttribute("aria-label", cityPanelCollapsed ? "Expand city panel" : "Minimize city panel");
            }
        }
 
        function initCityPanelCollapseUI() {
            if (!cityPanel) return;
            applyCityPanelCollapsed();
        }
 
        function updateCityPanel(now, seg) {
            if (!cityPanel) return;
 
            const toggleBtn = $("cityInfoToggleBtn");
 
            if (Number.isFinite(FINAL_ARRIVAL) && now >= FINAL_ARRIVAL) {
                cityPanel.hidden = true;
                if (toggleBtn) toggleBtn.hidden = true;
                currentCityStop = null;
                applyCityPanelCollapsed();
                return;
            }
 
            const s = seg?.mode === "stop" ? stops[seg.i] :
                seg?.mode === "travel" ? stops[seg.to] :
                    stops[0];
 
            if (!s) { cityPanel.hidden = true; currentCityStop = null; return; }
 
            const dr = Number(s.DR);
            if (!Number.isFinite(dr) || dr < CITY_PANEL_MIN_DR) {
                cityPanel.hidden = true;
                if (toggleBtn) toggleBtn.hidden = true;
                currentCityStop = null;
                return;
            }

            // Journey has begun — show the toggle button
            if (toggleBtn) toggleBtn.hidden = false;

            // User has manually hidden the panel — keep button visible but panel hidden
            if (!cityInfoUserVisible) return;

            cityPanel.hidden = false;
            currentCityStop = s;
 
            if (cityTitleEl) cityTitleEl.textContent = `Information about: ${s.City || "Unknown city"}`;
 
            if (cityPopulationEl) {
                const pop = Number(s.PopulationNum);
                cityPopulationEl.textContent = (Number.isFinite(pop) && pop > 0)
                    ? (s.PopulationYear ? `${formatInt(pop)} (as of ${s.PopulationYear})` : formatInt(pop))
                    : "Unknown";
            }
 
            if (cityElevationEl) {
                const elev = Number(s.ElevationMeter);
                cityElevationEl.textContent = Number.isFinite(elev) ? `${formatInt(elev)} meters` : "Unknown";
            }
 
            if (cityDirectionEl) {
                cityDirectionEl.textContent = currentTravelDirection
                    ? `${currentTravelDirection.arrow} | ${currentTravelDirection.text}`
                    : "N/A";
            }
 
            if (cityLocalTimeEl) {
                const tz = s.Timezone || null;
                try {
                    cityLocalTimeEl.textContent = new Date().toLocaleTimeString(undefined, {
                        timeZone: tz || undefined, hour: "numeric", minute: "2-digit"
                    });
                } catch {
                    cityLocalTimeEl.textContent = new Date().toLocaleTimeString(undefined, {
                        hour: "numeric", minute: "2-digit"
                    });
                }
            }
 
            if (cityWeatherEl) {
                cityWeatherEl.innerHTML = s.WikipediaUrl
                    ? `<a href="${s.WikipediaUrl}" target="_blank" rel="noopener noreferrer" style="color:inherit;">Wikipedia article \u2197</a>`
                    : "No article available";
            }
        }
 
        initCityPanelCollapseUI();
 
        // -- Viewer location lookup (non-blocking) -----------------------------
 
        fetchViewerLocationFromIpInfo().then(loc => {
            if (!loc) {
                viewerEtaError = true;
                if (statDurationEl) statDurationEl.textContent = "Unknown";
                return;
            }
            viewerLocation = loc;
            viewerClosestStop = findClosestStopByLocation(stops, loc.lat, loc.lon);
        }).catch(err => {
            console.warn("Viewer location lookup failed:", err);
            viewerEtaError = true;
            if (statDurationEl) statDurationEl.textContent = "Unknown";
        });
 
        // -- Map dimension button ---------------------------------------------
 
        const mapDimensionBtn = $("mapDimensionBtn");
 
        function updateMapDimensionButton() {
            if (!mapDimensionBtn) return;
            const is3d = mapDimensionMode === "3d";
            mapDimensionBtn.setAttribute("aria-pressed", String(is3d));
            mapDimensionBtn.textContent = is3d ? "Map Mode: 3D" : "Map Mode: 2D";
        }
 
        if (mapDimensionBtn) {
            updateMapDimensionButton();
            mapDimensionBtn.addEventListener("click", () => {
                mapDimensionMode = mapDimensionMode === "3d" ? "2d" : "3d";
                saveSettings({ mapDimensionMode });
                updateMapDimensionButton();
                applyMapDimensionMode();
            });
        }
 
        // -- Map style button -------------------------------------------------
 
        const mapStyleBtn = $("mapStyleBtn");
 
        function updateMapStyleButton() {
            if (!mapStyleBtn) return;
            const isSatellite = currentStyle === "satellite";
            mapStyleBtn.setAttribute("aria-pressed", String(isSatellite));
            mapStyleBtn.textContent = isSatellite ? "Map style: Satellite" : "Map style: Standard";
        }
 
        if (mapStyleBtn) {
            updateMapStyleButton();
            mapStyleBtn.addEventListener("click", () => {
                const center = map.getCenter();
                const zoom = map.getZoom();
                const bearing = map.getBearing();
                const pitch = map.getPitch();
 
                currentStyle = currentStyle === "standard" ? "satellite" : "standard";
                saveSettings({ mapStyle: currentStyle });
                updateMapStyleButton();
 
                map.setStyle(currentStyle === "satellite" ? SATELLITE_STYLE : STANDARD_STYLE);
                map.once("style.load", () => map.jumpTo({ center, zoom, bearing, pitch }));
            });
        }
 
        // -- Cinematic camera controls -----------------------------------------
 
        function updateCinematicCamButton() {
            const btn = $("cinematicCamBtn");
            if (!btn) return;
            btn.setAttribute("aria-pressed", String(cinematicCamEnabled));
            btn.textContent = cinematicCamEnabled ? "Camera Angle: Side Tracking" : "Camera Angle: Default";
        }
 
        function updateCinematicOffsetUI() {
            const offsetWrap = $("cineOffsetWrap");
            const offsetSlider = $("cineOffsetSlider");
            const offsetVal = $("cineOffsetVal");
            const zoomWrap = $("cineZoomWrap");
            const zoomSlider = $("cineZoomSlider");
            const zoomVal = $("cineZoomVal");
 
            if (offsetWrap) offsetWrap.hidden = !cinematicCamEnabled;
            if (zoomWrap) zoomWrap.hidden = !cinematicCamEnabled;
            if (offsetSlider) offsetSlider.value = clampDeg0to180(cinematicSideOffsetDeg);
            if (offsetVal) offsetVal.textContent = `${clampDeg0to180(cinematicSideOffsetDeg)}\u00b0`;
            if (zoomSlider) zoomSlider.value = clampZoom1to10(cinematicZoom);
            if (zoomVal) zoomVal.textContent = clampZoom1to10(cinematicZoom);
        }
 
        const cinematicCamBtn = $("cinematicCamBtn");
        if (cinematicCamBtn) {
            cinematicCamBtn.addEventListener("click", () => {
                cinematicCamEnabled = !cinematicCamEnabled;
                saveSettings({ cinematicCamEnabled });
                updateCinematicCamButton();
                updateCinematicOffsetUI();
                if (isLocked) followBunnyIfLocked();
            });
        }
        updateCinematicCamButton();
        updateCinematicOffsetUI();
 
        const cineOffsetSlider = $("cineOffsetSlider");
        if (cineOffsetSlider) {
            cineOffsetSlider.value = String(clampDeg0to180(cinematicSideOffsetDeg));
            cineOffsetSlider.addEventListener("input", () => {
                cinematicSideOffsetDeg = clampDeg0to180(cineOffsetSlider.value);
                saveSettings({ cinematicSideOffsetDeg });
                updateCinematicOffsetUI();
                cinematicBearing = (currentTravelBearingDeg + cinematicSideOffsetDeg) % 360;
                if (isLocked && cinematicCamEnabled) followBunnyIfLocked();
            });
        }
 
        const cineZoomSlider = $("cineZoomSlider");
        if (cineZoomSlider) {
            cineZoomSlider.value = clampZoom1to10(cinematicZoom);
            cineZoomSlider.addEventListener("input", () => {
                cinematicZoom = clampZoom1to10(cineZoomSlider.value);
                saveSettings({ cinematicZoom });
                updateCinematicOffsetUI();
                if (isLocked && cinematicCamEnabled) followBunnyIfLocked();
            });
        }
 
        // -- Speed unit button ------------------------------------------------
 
        function updateSpeedUnitButton() {
            const btn = $("travelSpeedTypeBtn");
            if (!btn) return;
            btn.setAttribute("aria-pressed", String(speedUnitMode === "mph"));
            btn.textContent = speedUnitMode === "mph"
                ? "Distance converted in: MPH"
                : "Distance converted in: KM/H";
        }
 
        const travelSpeedTypeBtn = $("travelSpeedTypeBtn");
        if (travelSpeedTypeBtn) {
            travelSpeedTypeBtn.addEventListener("click", () => {
                speedUnitMode = speedUnitMode === "mph" ? "kmh" : "mph";
                saveSettings({ speedUnitMode });
                updateSpeedUnitButton();
            });
        }
        updateSpeedUnitButton();
 
        // -- Streamer mode button ---------------------------------------------
 
        function updateStreamerModeButton() {
            const btn = $("streamerModeBtn");
            if (!btn) return;
            btn.setAttribute("aria-pressed", String(streamerModeEnabled));
            btn.textContent = streamerModeEnabled ? "Streamer Mode: Enabled" : "Streamer Mode: Disabled";
        }
 
        const streamerModeBtn = $("streamerModeBtn");
        if (streamerModeBtn) {
            streamerModeBtn.addEventListener("click", () => {
                streamerModeEnabled = !streamerModeEnabled;
                saveSettings({ streamerModeEnabled });
                updateStreamerModeButton();
                updateViewerLocationEta(Date.now() / 1000);
            });
        }
        updateStreamerModeButton();
 
        // -- Lock button ------------------------------------------------------
 
        const lockBtn = $("lockBtn");
        if (lockBtn) lockBtn.addEventListener("click", () => setLocked(!isLocked));
 
        // -- City info toggle button ------------------------------------------
        // Hidden during countdown (DR < 77), visible once the journey begins.
 
        // Default true — only false if the user explicitly hid it last session
        let cityInfoUserVisible = localStorage.getItem("eb_cityInfo_visible_v1") !== "0";
 
        function updateCityInfoToggleBtn() {
            const btn = $("cityInfoToggleBtn");
            if (!btn) return;
            btn.setAttribute("aria-pressed", String(cityInfoUserVisible));
            btn.textContent = cityInfoUserVisible ? "\uD83C\uDFD9\uFE0F Hide City Info" : "\uD83C\uDFD9\uFE0F Show City Info";
            btn.title = cityInfoUserVisible ? "Hide city info panel" : "Show city info panel";
        }
 
        const cityInfoToggleBtn = $("cityInfoToggleBtn");
        if (cityInfoToggleBtn) {
            cityInfoToggleBtn.addEventListener("click", () => {
                cityInfoUserVisible = !cityInfoUserVisible;
                localStorage.setItem("eb_cityInfo_visible_v1", cityInfoUserVisible ? "1" : "0");
                updateCityInfoToggleBtn();
                if (!cityInfoUserVisible && cityPanel) cityPanel.hidden = true;
            });
        }
        updateCityInfoToggleBtn();
 
        // -- Help modal -------------------------------------------------------
 
        const helpBtn = $("helpBtn");
        const helpOverlay = $("helpOverlay");
        const helpCloseBtn = $("helpCloseBtn");
 
        function openHelp() {
            if (!helpOverlay) return;
            helpOverlay.classList.add("is-open");
            helpOverlay.setAttribute("aria-hidden", "false");
            helpOverlay.querySelector(".help-tab.is-active")?.focus();
        }
 
        function closeHelp() {
            if (!helpOverlay) return;
            helpOverlay.classList.remove("is-open");
            helpOverlay.setAttribute("aria-hidden", "true");
            helpBtn?.focus();
        }
 
        function setHelpTab(tabKey) {
            if (!helpOverlay) return;
            helpOverlay.querySelectorAll(".help-tab").forEach(t => t.classList.toggle("is-active", t.dataset.tab === tabKey));
            helpOverlay.querySelectorAll(".help-pane").forEach(p => p.classList.toggle("is-active", p.dataset.pane === tabKey));
        }
 
        if (helpBtn) helpBtn.addEventListener("click", openHelp);
        if (helpCloseBtn) helpCloseBtn.addEventListener("click", closeHelp);
 
        // FIX: wire up the backdrop click to close the modal
        helpOverlay?.querySelector(".help-backdrop")?.addEventListener("click", closeHelp);
 
        helpOverlay?.querySelector(".help-tabs")?.addEventListener("click", e => {
            const btn = e.target.closest(".help-tab");
            if (btn) { e.preventDefault(); setHelpTab(btn.dataset.tab); }
        });
 
        window.addEventListener("keydown", e => {
            if (e.key === "Escape" && helpOverlay?.classList.contains("is-open")) closeHelp();
        });
 
        // -- Background music -------------------------------------------------
 
        let musicEnabled = typeof initialSettings.musicEnabled === "boolean"
            ? initialSettings.musicEnabled
            : true;
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
                        bgAudio.play()
                            ?.then(() => { musicResumePending = false; })
                            ?.catch(() => { musicResumePending = true; });
                    } catch { musicResumePending = true; }
                }, 1000);
            });
 
            if (!musicEnabled) return;
 
            try {
                bgAudio.play()
                    ?.then(() => { musicResumePending = false; })
                    ?.catch(err => {
                        console.warn("Autoplay blocked:", err);
                        musicResumePending = true;
                    });
            } catch { musicResumePending = true; }
        }
 
        function setMusicEnabled(next) {
            musicEnabled = !!next;
            saveSettings({ musicEnabled });
 
            const btn = $("musicToggleBtn");
            if (btn) {
                btn.setAttribute("aria-pressed", String(musicEnabled));
                btn.textContent = musicEnabled ? "Music: On" : "Music: Off";
            }
 
            if (!bgAudio) { if (musicEnabled) initBgMusic(); return; }
 
            if (musicEnabled) {
                try {
                    bgAudio.play()
                        ?.then(() => { musicResumePending = false; })
                        ?.catch(() => { musicResumePending = true; });
                } catch { musicResumePending = true; }
            } else {
                bgAudio.pause();
                musicResumePending = false;
            }
        }
 
        function handleUserInteractionForMusic() {
            if (!musicEnabled || !bgAudio || !musicResumePending) return;
            musicResumePending = false;
            try { bgAudio.play()?.catch(() => { }); } catch { }
        }
 
        ["pointerdown", "click", "keydown", "touchstart"].forEach(ev => {
            window.addEventListener(ev, handleUserInteractionForMusic, { passive: true });
        });
 
        const musicToggleBtn = $("musicToggleBtn");
        if (musicToggleBtn) {
            musicToggleBtn.addEventListener("click", () => {
                setMusicEnabled(!musicEnabled);
                if (musicEnabled && !bgAudio) initBgMusic();
            });
        }
 
        setMusicEnabled(musicEnabled);
        initBgMusic();
 
        // -- Tick loop --------------------------------------------------------
 
        function tick() {
            const now = Date.now() / 1000;
            isDelivering = false;
 
            const seg = findSegment(now, stops, TAKEOFF_ARRIVAL);
 
            speedJitter += (Math.random() - 0.5) * 0.8;
            speedJitter = Math.max(-3, Math.min(3, speedJitter));
 
            // Update currentSegDR so getLockedZoom() always reflects the current phase
            currentSegDR =
                seg.mode === "stop" ? Number(stops[seg.i]?.DR ?? null) :
                    seg.mode === "travel" ? Number(stops[seg.to]?.DR ?? null) :
                        null;
 
            // Track the most recent travel destination for city panel continuity
            if (seg.mode === "travel") {
                const isNew = lastSegMode !== "travel" || lastSegToIndex !== seg.to;
                if (isNew && stops[seg.to]) currentCityStop = stops[seg.to];
                lastSegMode = "travel";
                lastSegToIndex = seg.to;
            } else {
                lastSegMode = seg.mode;
                lastSegToIndex = null;
            }
 
            // Drop a basket marker for every stop the bunny has already departed
            for (const s of stops) {
                if (now >= s.UnixArrivalDeparture) addBasketForStop(s);
                else break;
            }
 
            // -- Journey complete ---------------------------------------------
            if (Number.isFinite(FINAL_ARRIVAL) && now >= FINAL_ARRIVAL) {
                if (cityPanel) cityPanel.hidden = true;
 
                updateBunnyPosition(finalStop.Longitude, finalStop.Latitude);
 
                if (statEtaRow) statEtaRow.style.display = "none";
 
                currentSegDR = FINAL_DR;
 
                updateHUD({
                    status: "Easter Island, Chile - The Easter Bunny has completed his journey", lastText: "\u2014",
                    etaSeconds: NaN, etaText: "", stopRemainingSeconds: NaN,
                    speedKmh: NaN, speedMph: NaN,
                    eggs: finalStop.EggsDelivered, carrots: finalStop.CarrotsEaten
                });
 
                followBunnyIfLocked();
                updateViewerLocationEta(now);
                return;
            }
 
            // Shared phase flags used across all modes below
            const before76 = isBeforeDR76ForSegment(seg, stops);
            const before77 = isBeforeDR77ForSegment(seg, stops);
            setEtaLabel(before76);
            setViewerEtaVisibility(!before77);
            setStopRemainingVisibility(!before77);
 
            // -- Pre-journey --------------------------------------------------
            if (seg.mode === "pre") {
                const first = stops[0];
                updateBunnyPosition(first.Longitude, first.Latitude);
 
                updateHUD({
                    status: "Preparing for takeoff\u2026",
                    lastText: "N/A",
                    etaSeconds: etaForHUD(now, first.UnixArrivalArrival - now, TAKEOFF_ARRIVAL),
                    stopRemainingSeconds: NaN,
                    speedKmh: NaN, speedMph: NaN,
                    eggs: 0, carrots: 0
                });
 
                followBunnyIfLocked();
                currentTravelDirection = null;
                updateViewerLocationEta(now);
                updateCityPanel(now, seg);
                return;
            }
 
            // -- At a stop ----------------------------------------------------
            if (seg.mode === "stop") {
                const s = stops[seg.i];
                const next = stops[Math.min(seg.i + 1, stops.length - 1)];
                const drNow = Number(s.DR);
 
                // Special case: DR 76 takeoff clearance stop
                if (Number.isFinite(drNow) && drNow === TAKEOFF_DR) {
                    isDelivering = false;
                    updateBunnyPosition(s.Longitude, s.Latitude);
 
                    const nextA = next ? Number(next.UnixArrivalArrival) : NaN;
                    updateHUD({
                        status: "Takeoff clearance granted \u2014 lifting off!",
                        lastText: "N/A",
                        etaSeconds: Number.isFinite(nextA) ? nextA - now : NaN,
                        stopRemainingSeconds: NaN,
                        speedKmh: NaN, speedMph: NaN,
                        eggs: 0, carrots: 0
                    });
 
                    followBunnyIfLocked();
                    currentTravelDirection = null;
                    updateViewerLocationEta(now);
                    updateCityPanel(now, seg);
                    return;
                }
 
                const preTakeoffStop = Number.isFinite(drNow) && drNow < TAKEOFF_DR;
                isDelivering = !preTakeoffStop;
                updateBunnyPosition(s.Longitude, s.Latitude);
 
                // Pre-takeoff preparation stop
                if (preTakeoffStop) {
                    updateHUD({
                        status: s.City || "Preparing\u2026",
                        lastText: "N/A",
                        etaSeconds: etaForHUD(now, NaN, TAKEOFF_ARRIVAL),
                        stopRemainingSeconds: NaN,
                        speedKmh: NaN, speedMph: NaN,
                        eggs: 0, carrots: 0
                    });
 
                    followBunnyIfLocked();
                    currentTravelDirection = null;
                    updateViewerLocationEta(now);
                    updateCityPanel(now, seg);
                    return;
                }
 
                // Active delivery stop -- calculate speed from previous leg and interpolate totals
                const stopRemaining = s.UnixArrivalDeparture - now;
                let speedKmh = NaN, speedMph = NaN;
                let prevEggs = 0, prevCarrots = 0;
 
                if (seg.i > 0) {
                    const prev = stops[seg.i - 1];
                    const distKm = haversineKm(prev.Latitude, prev.Longitude, s.Latitude, s.Longitude);
                    const travelSec = Math.max(1, s.UnixArrivalArrival - prev.UnixArrivalDeparture);
                    speedKmh = (distKm / travelSec) * 3600;
                    speedMph = speedKmh * 0.621371;
                    prevEggs = Number(prev.EggsDelivered) || 0;
                    prevCarrots = Number(prev.CarrotsEaten) || 0;
                }
 
                const cityEggs = Number(s.EggsDelivered) || prevEggs;
                const cityCarrots = Number(s.CarrotsEaten) || prevCarrots;
                const stopDuration = Math.max(1, s.UnixArrivalDeparture - s.UnixArrivalArrival);
                const stopT = clamp01((now - s.UnixArrivalArrival) / stopDuration);
 
                updateHUD({
                    status: `Delivering in ${s.City}`,
                    lastText: before77 ? "N/A" : (seg.i > 0 ? cityLabel(stops[seg.i - 1]) : "\u2014"),
                    etaText: `Currently delivering eggs in ${s.City}`,
                    etaSeconds: NaN,
                    stopRemainingSeconds: stopRemaining,
                    speedKmh: Number.isFinite(speedKmh) ? speedKmh + speedJitter : NaN,
                    speedMph: Number.isFinite(speedMph) ? speedMph + speedJitter : NaN,
                    eggs: lerp(prevEggs, cityEggs, stopT),
                    carrots: lerp(prevCarrots, cityCarrots, stopT)
                });
 
                followBunnyIfLocked();
                currentTravelDirection = null;
            }
 
            // -- Travelling between stops -------------------------------------
            else if (seg.mode === "travel") {
                const from = stops[seg.from];
                const to = stops[seg.to];
                if (!from || !to) return;
 
                if ([from.Latitude, from.Longitude, to.Latitude, to.Longitude].every(Number.isFinite)) {
                    currentTravelBearingDeg = bearingDeg(from.Latitude, from.Longitude, to.Latitude, to.Longitude);
                    cinematicBearing = (currentTravelBearingDeg + cinematicSideOffsetDeg) % 360;
                }
 
                const toDr = Number(to.DR);
                const preTakeoffTravel = Number.isFinite(toDr) && toDr < TAKEOFF_DR;
                const showRegion = Number.isFinite(toDr) && toDr >= 76;
                const destLabel = showRegion ? cityLabel(to) : cityOnly(to);
                const statusText = preTakeoffTravel ? (to.City || "Preparing\u2026") : `Heading to: ${destLabel}`;
 
                const departT = from.UnixArrivalDeparture;
                const arriveT = to.UnixArrivalArrival;
                const denom = Math.max(1, arriveT - departT);
                const t = clamp01((now - departT) / denom);
                const pos = interpolateLatLon(from, to, t);
 
                updateBunnyPosition(pos.lon, pos.lat);
 
                const distKm = haversineKm(from.Latitude, from.Longitude, to.Latitude, to.Longitude);
                const speedKmh = preTakeoffTravel ? NaN : (distKm / denom) * 3600;
                const speedMph = preTakeoffTravel ? NaN : speedKmh * 0.621371;
 
                updateHUD({
                    status: statusText,
                    lastText: before77 ? "N/A" : cityLabel(from),
                    etaSeconds: etaForHUD(now, arriveT - now, TAKEOFF_ARRIVAL),
                    stopRemainingSeconds: NaN,
                    speedKmh: Number.isFinite(speedKmh) ? speedKmh + speedJitter : NaN,
                    speedMph: Number.isFinite(speedMph) ? speedMph + speedJitter : NaN,
                    eggs: preTakeoffTravel ? 0 : lerp(Number(from.EggsDelivered) || 0, Number(to.EggsDelivered) || 0, t),
                    carrots: preTakeoffTravel ? 0 : lerp(Number(from.CarrotsEaten) || 0, Number(to.CarrotsEaten) || 0, t)
                });
 
                followBunnyIfLocked();
                currentTravelDirection = computeTravelDirection(from, to);
            }
 
            updateViewerLocationEta(now);
            updateCityPanel(now, seg);
        }
 
        // -- Start ------------------------------------------------------------
 
        tick();
        // Store the interval reference so it can be cleared later if needed
        const _tickInterval = setInterval(tick, 100);
 
        console.log(`Loaded route with ${stops.length} stops (Mapbox globe).`);
 
    } catch (e) {
        console.error("Tracker init failed:", e);
        const el = document.getElementById("statStatus");
        if (el) el.textContent = "Error (see console)";
    }
})();

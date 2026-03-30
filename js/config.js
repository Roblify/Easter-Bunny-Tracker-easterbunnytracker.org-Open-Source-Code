/* =============================================================================
 *  Easter Bunny Tracker  —  config.js
 *
 *  Sections:
 *    1. Configuration
 *    2. Settings  (localStorage persistence)
 *    3. User Preferences  (defaults from saved settings)
 * ============================================================================= */

"use strict";


/* =============================================================================
 *  1. CONFIGURATION
 * ============================================================================= */

const MAPBOX_TOKEN = "YOUR_MAPBOX_API_KEY";

// NOTE: IPInfo tokens cannot be hidden in client-side JavaScript — any visitor
// can read the page source or intercept the network request and extract it.
// The only proper solution is to proxy the IPInfo request through your own
// server-side endpoint (e.g. a Cloudflare Worker or serverless function) so the
// token never reaches the browser.  Until then, restrict this token to your
// domain in the IPInfo dashboard (ipinfo.io → Token settings → "Allowed domains")
// to limit misuse.
const _IPT = "YOUR_IPINFO_TOKEN";

const ROUTE_FILE = "data/route.json";

// Server-side timer API (returns a UTC timestamp - keeps all clients in sync)
const TIMER_API_URL = "YOUR_TIMING_API_ENDPOINT_LINK";

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

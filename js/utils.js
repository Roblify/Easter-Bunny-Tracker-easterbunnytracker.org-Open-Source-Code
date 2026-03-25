/* =============================================================================
 *  Easter Bunny Tracker  —  utils.js
 *
 *  Pure helpers — no side-effects.
 *    4a. Number / String formatting
 *    4b. Math / Interpolation
 *    4c. Geographic math
 * ============================================================================= */

"use strict";

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
    if (whole === 0) return "Less than an hour";
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

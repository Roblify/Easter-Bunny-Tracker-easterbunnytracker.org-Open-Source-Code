/* =============================================================================
 *  Easter Bunny Tracker  -  serverTime.js
 *
 *  Fetches the authoritative timestamp from a server-side timer API 
 *  and computes a clock offset so every client displays
 *  synchronised timing regardless of local clock drift or manipulation.
 *
 *  Globals exposed:
 *    initServerTime()        - async; call once at startup, resolves when ready
 *    serverNow()             - returns corrected Date.now() (ms)
 *    serverNowSec()          - returns corrected time in seconds (Unix)
 *    serverTimeReady         - Promise that resolves when offset is known
 * ============================================================================= */

"use strict";

/** Millisecond offset: serverTime − clientTime.  Added to Date.now(). */
let _clockOffsetMs = 0;

/** True once at least one successful sync has completed. */
let _synced = false;

/** Resolves when the first sync finishes (success or fallback). */
let _readyResolve;
const serverTimeReady = new Promise(resolve => { _readyResolve = resolve; });

/**
 * Parse the timestamp string returned by the timer API.
 * Supports:
 *   "MM/DD/YYYY HH:MM:SS"  (assumed UTC)
 *   ISO-8601 / any string accepted by Date.parse()
 *   Raw unix-ms number
 */
function _parseTimerResponse(text) {
    const trimmed = text.replace(/^["'\s]+|["'\s]+$/g, "");

    // Raw numeric (unix ms or unix seconds)
    if (/^\d+(\.\d+)?$/.test(trimmed)) {
        const n = Number(trimmed);
        return n < 1e12 ? n * 1000 : n; // treat < 1e12 as seconds
    }

    // NORAD-style "MM/DD/YYYY HH:MM:SS" - append "Z" so it's parsed as UTC
    const norad = trimmed.match(
        /^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})$/
    );
    if (norad) {
        const [, mo, dd, yyyy, hh, mm, ss] = norad;
        return Date.UTC(+yyyy, +mo - 1, +dd, +hh, +mm, +ss);
    }

    // Fallback: ISO-8601 or anything Date.parse handles
    const ms = Date.parse(trimmed);
    if (Number.isFinite(ms)) return ms;

    throw new Error("Unrecognised timer format: " + trimmed);
}

/**
 * Fetch the server timestamp and compute the clock offset.
 * Uses the midpoint of the request to approximate network latency.
 *
 * @param {string} url  Timer endpoint URL (default: TIMER_API_URL from config)
 * @param {number} retries  Number of retry attempts on failure
 */
async function initServerTime(url, retries = 2) {
    const endpoint = url || (typeof TIMER_API_URL !== "undefined" ? TIMER_API_URL : "");

    if (!endpoint) {
        console.warn("[serverTime] No timer API URL configured - using local clock.");
        _readyResolve();
        return;
    }

    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const t0 = Date.now();
            const res = await fetch(endpoint, { cache: "no-store" });
            const t1 = Date.now();

            if (!res.ok) throw new Error("HTTP " + res.status);

            const body = await res.text();
            const serverMs = _parseTimerResponse(body);
            const roundTripMs = t1 - t0;
            const clientMidpoint = t0 + roundTripMs / 2;

            _clockOffsetMs = serverMs - clientMidpoint;
            _synced = true;

            console.info(
                "[serverTime] Synced. Offset: %s ms  (RTT %s ms)",
                _clockOffsetMs.toFixed(1),
                roundTripMs
            );

            _readyResolve();
            return;
        } catch (err) {
            console.warn(
                "[serverTime] Sync attempt %d failed: %s",
                attempt + 1,
                err.message
            );
        }
    }

    // All retries exhausted - fall back to local clock
    console.warn("[serverTime] All sync attempts failed - falling back to local clock.");
    _readyResolve();
}

/** Corrected Date.now() in milliseconds. */
function serverNow() {
    return Date.now() + _clockOffsetMs;
}

/** Corrected time in Unix seconds. */
function serverNowSec() {
    return serverNow() / 1000;
}

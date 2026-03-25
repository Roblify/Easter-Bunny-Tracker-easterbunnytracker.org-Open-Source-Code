/* =============================================================================
 *  Easter Bunny Tracker  —  viewer.js
 *
 *  8. Viewer Location  (IP-based, non-blocking)
 * ============================================================================= */

"use strict";

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

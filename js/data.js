/* =============================================================================
 *  Easter Bunny Tracker  —  data.js
 *
 *  Sections:
 *    5. Data Helpers  (stop accessors, label builders)
 *    6. Route Loading
 * ============================================================================= */

"use strict";


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

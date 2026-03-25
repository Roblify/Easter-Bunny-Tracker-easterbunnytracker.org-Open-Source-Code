/* =============================================================================
 *  Easter Bunny Tracker  —  tracker.js
 *
 *  7. Segment Logic  <- the brain of the tracker
 *
 *  findSegment(now, stops, takeoffArrival) classifies the current moment into:
 *    { mode: "pre" }                          -- before the journey starts
 *    { mode: "stop",   i }                    -- bunny is at stop i
 *    { mode: "travel", from: i, to: i+1 }     -- bunny is flying between stops
 * ============================================================================= */

"use strict";

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

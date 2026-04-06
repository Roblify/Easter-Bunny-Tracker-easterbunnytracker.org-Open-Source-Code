/* =============================================================================
 *  Easter Bunny Tracker  -  main.js
 *
 *  9. Application Init  (Mapbox map, HUD, markers, tick loop)
 *
 *  Dependencies (loaded via <script> before this file):
 *    config.js  - constants, settings, preferences
 *    utils.js   - pure helpers (formatting, math, geo)
 *    data.js    - data helpers, route loading
 *    tracker.js - findSegment and segment classification
 *    viewer.js  - IP-based viewer location
 * ============================================================================= */

"use strict";

(async function init() {
    try {

        // -- Pre-journey gate --------------------------------------------------
        // Redirects anyone who visits before April 4 2026 at 06:00 UTC back to index.html.
        // Remove or disable this once the journey is live.
        const PRE_JOURNEY_START_UTC_MS = Date.UTC(2026, 3, 4, 6, 0, 0);
        if (serverNow() < PRE_JOURNEY_START_UTC_MS) {
            window.location.replace("index.html");
            return;
        }

        if (typeof mapboxgl === "undefined") {
            console.error("Mapbox GL JS is undefined. Make sure its script is loaded.");
            return;
        }

        // -- WebGL check ------------------------------------------------------
        if (!mapboxgl.supported({ failIfMajorPerformanceCaveat: false })) {
            console.error("WebGL is not supported by this browser.");
            const el = document.getElementById("statStatus");
            if (el) el.textContent = "Your browser does not support WebGL. Please try a different browser or enable hardware acceleration.";
            return;
        }

        // -- Boot -------------------------------------------------------------

        const statDurationEl = $("statDuration");
        if (statDurationEl) statDurationEl.textContent = "Loading...";
        $("statStatus").textContent = "Loading route\u2026";

        // Sync server time and load route data in parallel
        const [, stops] = await Promise.all([initServerTime(), loadRoute()]);

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
            projection: mapDimensionMode === "3d" ? "globe" : "mercator",
            // Render at full device resolution (retina/HiDPI) for sharp tiles
            pixelRatio: window.devicePixelRatio || 1,
            // Fetch higher-resolution tiles than the zoom level normally would
            maxTileCacheSize: 200
        });

        // -- Session state -----------------------------------------------------
        // NOTE: isLocked is declared HERE, before applyMapDimensionMode, so that
        // function can safely reference it when style.load fires early.

        let isLocked = true;

        // -- Device detection -----------------------------------------------------
        const _isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
            (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
        const _isMobile = _isIOS || /Android/i.test(navigator.userAgent);

        // -- Map dimension (2D / 3D) -------------------------------------------

        function applyMapDimensionMode() {
            try {
                if (mapDimensionMode === "3d" && !_isIOS) {
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
                    // Clear fog safely — iOS chokes on null
                    try { map.setFog({}); } catch (e) { /* ignore */ }
                    if (isLocked && !cinematicCamEnabled) {
                        map.easeTo({ pitch: 0, bearing: 0, duration: 400 });
                    }
                }
            } catch (e) {
                console.warn("[map] applyMapDimensionMode failed:", e);
            }
        }

        // -- Style fallback chain ------------------------------------------------
        // Fallback order:
        //   Standard → custom Satellite → stock Mapbox satellite
        //   custom Satellite → stock Mapbox satellite
        //   (stock Mapbox satellite is the final safety net)

        let _fallbackLevel = 0; // 0 = none, 1 = tried custom satellite, 2 = tried stock satellite

        function fallbackStyle(reason) {
            console.warn("[map] Style issue (" + reason + ") — attempting fallback. Level: " + _fallbackLevel);

            if (_fallbackLevel === 0) {
                // First fallback: try custom Satellite (or stock if already on custom satellite)
                if (currentStyle === "satellite") {
                    // Already on custom satellite — skip to stock
                    _fallbackLevel = 1;
                } else {
                    _fallbackLevel = 1;
                    currentStyle = "satellite";
                    saveSettings({ mapStyle: "satellite" });
                    if (typeof updateMapStyleButton === "function") updateMapStyleButton();
                    try { map.setStyle(SATELLITE_STYLE); return; } catch (e) {
                        console.warn("[map] Custom satellite fallback failed:", e);
                    }
                }
            }

            if (_fallbackLevel <= 1) {
                // Final fallback: stock Mapbox satellite (works on all devices)
                _fallbackLevel = 2;
                console.warn("[map] Falling back to stock Mapbox satellite style.");
                currentStyle = "satellite";
                if (typeof updateMapStyleButton === "function") updateMapStyleButton();
                try { map.setStyle(FALLBACK_SATELLITE_STYLE); } catch (e) {
                    console.error("[map] All style fallbacks exhausted:", e);
                }
            }
        }

        map.on("style.load", () => {
            applyMapDimensionMode();

            // setConfigProperty is only for Standard / Standard-Satellite component styles.
            // Skip entirely on stock styles and on iOS (where these calls can cause
            // silent rendering failures on unsupported styles).
            const isComponentStyle = currentStyle === "standard" ||
                (currentStyle === "satellite" && SATELLITE_STYLE.includes("theroblify") && _fallbackLevel < 2);

            if (isComponentStyle && !_isIOS) {
                if (currentStyle === "standard") {
                    try { map.setConfigProperty("basemap", "lightPreset", "dusk"); } catch (e) {
                        console.warn("[map] setConfigProperty lightPreset failed:", e);
                    }
                }

                // -- Hide roads (but preserve borders, labels, and admin boundaries) --
                try { map.setConfigProperty("basemap", "showRoadLabels", false); } catch (e) { /* unsupported */ }
                try { map.setConfigProperty("basemap", "showPlaceLabels", true); } catch (e) { /* unsupported */ }
                try { map.setConfigProperty("basemap", "showPointOfInterestLabels", false); } catch (e) { /* unsupported */ }
            }

            // Layer-level road hiding (works on all style types)
            try {
                const layers = map.getStyle().layers;
                for (const layer of layers) {
                    const id = (layer.id || "").toLowerCase();
                    const sl = (layer["source-layer"] || "").toLowerCase();

                    // Skip anything related to borders, labels, or admin boundaries
                    if (id.includes("admin") || id.includes("boundar") || id.includes("label") ||
                        id.includes("country") || id.includes("state") || id.includes("place") ||
                        sl.includes("admin") || sl.includes("boundar")) {
                        continue;
                    }

                    if (id.includes("road") || sl.includes("road")) {
                        map.setLayoutProperty(layer.id, "visibility", "none");
                    }
                }
            } catch (e) {
                console.warn("[map] Road layer hiding failed:", e);
            }
        });

        // -- Map error recovery -----------------------------------------------

        map.on("error", (e) => {
            const err = e?.error || e;
            const status = err?.status || err?.statusCode || "";
            const msg = err?.message || err?.url || (typeof err === "object" ? JSON.stringify(err) : String(err));
            console.warn("[map] Error event:", status ? `HTTP ${status} — ${msg}` : msg);

            if (_fallbackLevel < 2) {
                fallbackStyle(status ? `HTTP ${status}` : msg);
            }
        });

        // WebGL context lost — the GPU dropped the context entirely
        const canvas = map.getCanvas();
        if (canvas) {
            canvas.addEventListener("webglcontextlost", (e) => {
                console.error("[map] WebGL context lost. The map will attempt to restore automatically.");
                e.preventDefault();  // allow Mapbox to attempt restore
            });
        }

        await new Promise(resolve => map.on("load", resolve));

        // Force canvas resize — fixes iOS Safari where the container
        // dimensions aren't picked up correctly on first render.
        map.resize();
        // Delayed second resize — some iOS devices need a frame to
        // calculate the correct container dimensions after layout.
        setTimeout(() => { try { map.resize(); } catch (e) { /* ignore */ } }, 250);

        // -- Tile-load timeout ------------------------------------------------
        // If Mapbox fires "load" but tiles never actually render (canvas stays
        // empty), fall back after 8 seconds.  The "idle" event means all tiles
        // for the current viewport have been loaded and rendered.
        let _tilesRendered = false;
        map.once("idle", () => { _tilesRendered = true; });
        setTimeout(() => {
            if (!_tilesRendered && _fallbackLevel < 2) {
                console.warn("[map] Tile-load timeout — tiles did not render within 8 seconds.");
                fallbackStyle("tile-load timeout");
            }
        }, 8000);

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
                if (!statDurationEl.textContent || statDurationEl.textContent === "Loading..." || statDurationEl.textContent === "HIDDEN | S.M. enabled") {
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

        // City panel collapse state resets on every load - only the user's
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

            // Journey has begun - show the toggle button
            if (toggleBtn) toggleBtn.hidden = false;

            // User has manually hidden the panel - keep button visible but panel hidden
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
                _fallbackLevel = 0; // reset so fallback chain can re-trigger if needed
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
                updateViewerLocationEta(serverNowSec());
            });
        }
        updateStreamerModeButton();

        // -- Lock button ------------------------------------------------------

        const lockBtn = $("lockBtn");
        if (lockBtn) lockBtn.addEventListener("click", () => setLocked(!isLocked));

        // -- City info toggle button ------------------------------------------
        // Hidden during countdown (DR < 77), visible once the journey begins.

        // Default true - only false if the user explicitly hid it last session
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
            const now = serverNowSec();
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

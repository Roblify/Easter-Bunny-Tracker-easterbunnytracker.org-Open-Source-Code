(() => {
  // April 5, 2026 @ 2:00 AM EDT
  // EDT is UTC-4, so this is 2026-04-05T06:00:00Z
  const TARGET_UTC_MS = Date.UTC(2026, 3, 5, 6, 0, 0);

  const elD = document.getElementById("d");
  const elH = document.getElementById("h");
  const elM = document.getElementById("m");
  const elS = document.getElementById("s");
  const elStatus = document.getElementById("status");

  const pad2 = (n) => String(n).padStart(2, "0");

  function redirectToTracker() {
    // Use replace so back button doesn't bounce people back into the countdown
    window.location.replace("tracker.html");
  }

  function tick() {
    // If countdown elements aren't present, don't crash
    if (!elD || !elH || !elM || !elS) return;

    const now = Date.now();
    const diff = TARGET_UTC_MS - now;

    if (diff <= 0) {
      elD.textContent = "00";
      elH.textContent = "00";
      elM.textContent = "00";
      elS.textContent = "00";
      if (elStatus) elStatus.textContent = "Pre-journey updates are live. Redirecting…";
      redirectToTracker();
      return;
    }

    const totalSeconds = Math.floor(diff / 1000);

    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    // Days can exceed 2 digits, so don't pad days to 2 unless you really want that
    elD.textContent = String(days);
    elH.textContent = pad2(hours);
    elM.textContent = pad2(minutes);
    elS.textContent = pad2(seconds);

    if (elStatus) elStatus.textContent = "Preparing pre-journey updates…";
  }

  tick();
  setInterval(tick, 250);
})();

// -------------------------
// HELP modal UI (countdown page)
// -------------------------
(() => {
  const helpBtn = document.getElementById("helpBtn");
  const helpOverlay = document.getElementById("helpOverlay");
  const helpCloseBtn = document.getElementById("helpCloseBtn");

  if (!helpBtn || !helpOverlay || !helpCloseBtn) return;

  function openHelp() {
    helpOverlay.classList.add("is-open");
    helpOverlay.setAttribute("aria-hidden", "false");

    const activeTab = helpOverlay.querySelector(".help-tab.is-active");
    if (activeTab) activeTab.focus();
  }

  function closeHelp() {
    helpOverlay.classList.remove("is-open");
    helpOverlay.setAttribute("aria-hidden", "true");
    helpBtn.focus();
  }

  function setHelpTab(tabKey) {
    const tabs = helpOverlay.querySelectorAll(".help-tab");
    const panes = helpOverlay.querySelectorAll(".help-pane");

    tabs.forEach((t) => t.classList.toggle("is-active", t.dataset.tab === tabKey));
    panes.forEach((p) => p.classList.toggle("is-active", p.dataset.pane === tabKey));
  }

  helpBtn.addEventListener("click", openHelp);
  helpCloseBtn.addEventListener("click", closeHelp);

  // Backdrop click closes (your backdrop has data-help-close="1")
  helpOverlay.addEventListener("click", (e) => {
    if (e.target && e.target.matches("[data-help-close]")) closeHelp();
  });

  // Tab switching
  const helpTabs = helpOverlay.querySelector(".help-tabs");
  if (helpTabs) {
    helpTabs.addEventListener("click", (e) => {
      const btn = e.target.closest(".help-tab");
      if (!btn) return;
      e.preventDefault();
      setHelpTab(btn.dataset.tab);
    });
  }

  // Escape closes
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && helpOverlay.classList.contains("is-open")) closeHelp();
  });
})();
document.addEventListener("DOMContentLoaded", () => {

  // ---- THEME ----
  const themeBtn = document.getElementById("themeToggle");
  let isLight = localStorage.getItem("theme") === "light";

  function applyTheme() {
    document.body.classList.toggle("light", isLight);
    themeBtn.textContent = isLight ? "Dark" : "Light";
    if (window.dashboardChart) {
      const textColor = getComputedStyle(document.body).getPropertyValue("--text-2").trim();
      const gridColor = getComputedStyle(document.body).getPropertyValue("--border").trim();
      window.dashboardChart.options.scales.x.ticks.color = textColor;
      window.dashboardChart.options.scales.y.ticks.color = textColor;
      window.dashboardChart.options.scales.y.grid.color = gridColor;
      window.dashboardChart.update();
    }
  }

  themeBtn.addEventListener("click", () => {
    isLight = !isLight;
    localStorage.setItem("theme", isLight ? "light" : "dark");
    applyTheme();
  });
  applyTheme();

  // ---- HELPERS ----
  function animateCount(el, target, duration = 900) {
    const start = performance.now();
    const update = (now) => {
      const elapsed = now - start;
      const progress = Math.min(elapsed / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      el.textContent = Math.round(eased * target);
      if (progress < 1) requestAnimationFrame(update);
    };
    requestAnimationFrame(update);
  }

  function animateBar(el, pct, delay = 0) {
    setTimeout(() => { el.style.width = `${Math.min(pct, 100)}%`; }, delay);
  }

  function timeAgo(isoString) {
    if (!isoString || isoString === "Live") return isoString;
    const diff = Math.floor((Date.now() - new Date(isoString).getTime()) / 1000);
    if (diff < 5)   return "just now";
    if (diff < 60)  return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
  }

  // ---- STATE ----
  let totalSeconds = 0;
  let syncedSecondsAgo = 0;
  let currentChartView = "24h";
  let currentTierView  = "24h";
  let chartData = {};

  // ---- SYNC COUNTER (ticks every second) ----
  const syncEl = document.getElementById("syncTime");

  function updateSyncDisplay() {
    if (!syncEl) return;
    syncEl.textContent = syncedSecondsAgo < 5
      ? "Synced just now"
      : `Synced ${syncedSecondsAgo}s ago`;
  }

  setInterval(() => {
    syncedSecondsAgo++;
    updateSyncDisplay();

    totalSeconds++;
    updateUptimeDisplay();

    // Re-render "X min ago" timestamps every 30 s without a network call
    if (syncedSecondsAgo % 30 === 0) refreshJobTimestamps();
  }, 1000);

  // ---- UPTIME ----
  const uptimeEl = document.getElementById("uptimeText");

  function updateUptimeDisplay() {
    if (!uptimeEl) return;
    const d = Math.floor(totalSeconds / 86400);
    const h = Math.floor((totalSeconds % 86400) / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = totalSeconds % 60;
    uptimeEl.textContent = `Uptime: ${d}d ${h}h ${m}m ${s}s`;
  }

  // ---- TOGGLE HELPERS ----
  function setActiveToggle(activeBtn, ...rest) {
    activeBtn.classList.add("active");
    rest.forEach(b => b.classList.remove("active"));
  }

  // ---- METRIC CARDS ----
  function updateMetricCards(dataObj, isAllTime, limits) {
    animateCount(document.getElementById("geminiCount"),  dataObj.gemini);
    animateCount(document.getElementById("groqCount"),    dataObj.groq);
    animateCount(document.getElementById("orCount"),      dataObj.openrouter);
    animateCount(document.getElementById("tavilyCount"),  dataObj.tavily);
    animateCount(document.getElementById("serperCount"),  dataObj.serper);

    animateBar(document.getElementById("geminiBar"),  isAllTime ? 100 : (dataObj.gemini      / limits.gemini)      * 100, 0);
    animateBar(document.getElementById("groqBar"),    isAllTime ? 100 : (dataObj.groq        / limits.groq)        * 100, 50);
    animateBar(document.getElementById("orBar"),      isAllTime ? 100 : (dataObj.openrouter  / limits.openrouter)  * 100, 100);
    animateBar(document.getElementById("tavilyBar"),  isAllTime ? 100 : (dataObj.tavily      / limits.tavily)      * 100, 150);
    animateBar(document.getElementById("serperBar"),  (dataObj.serper / limits.serper) * 100, 200);
  }

  // ---- JOBS TABLE ----
  function timeAgoCell(lastFired) {
    if (!lastFired)            return `<span style="font-family:var(--mono);font-size:0.7rem;color:var(--text-3)">—</span>`;
    if (lastFired === "Live")  return `<span style="font-family:var(--mono);font-size:0.7rem;color:var(--teal)">Live</span>`;
    return `<span style="font-family:var(--mono);font-size:0.7rem;color:var(--teal)">${timeAgo(lastFired)}</span>`;
  }

  function renderJobsTable(jobs) {
    const tbody = document.getElementById("jobsTableBody");
    tbody.innerHTML = "";

    if (!jobs || jobs.length === 0) {
      tbody.innerHTML = `<tr><td colspan="5" class="loading-cell">No processes registered.</td></tr>`;
      return;
    }

    jobs.forEach((job) => {
      const tr = document.createElement("tr");
      if (job.lastFired && job.lastFired !== "Live") tr.dataset.lastFired = job.lastFired;
      tr.innerHTML = `
        <td class="job-name">${job.name}</td>
        <td class="job-schedule">${job.schedule}</td>
        <td class="job-desc"><i>${job.layman}</i></td>
        <td class="job-last-run">${timeAgoCell(job.lastFired)}</td>
        <td><span class="job-status ${job.status}">${job.status}</span></td>
      `;
      tbody.appendChild(tr);
    });
  }

  function refreshJobTimestamps() {
    document.querySelectorAll("#jobsTableBody tr[data-last-fired]").forEach(row => {
      const cell = row.querySelector(".job-last-run");
      if (cell) cell.innerHTML = timeAgoCell(row.dataset.lastFired);
    });
  }

  // ---- CHART ----
  function initOrUpdateChart(labels24H, data24H_success, data24H_errors, labels7D, data7D_success, data7D_errors) {
    chartData = { labels24H, data24H_success, data24H_errors, labels7D, data7D_success, data7D_errors };

    if (window.dashboardChart) {
      const active = currentChartView === "24h";
      window.dashboardChart.data.labels              = active ? labels24H        : labels7D;
      window.dashboardChart.data.datasets[0].data    = active ? data24H_success  : data7D_success;
      window.dashboardChart.data.datasets[1].data    = active ? data24H_errors   : data7D_errors;
      window.dashboardChart.update();
      return;
    }

    const textColor = getComputedStyle(document.body).getPropertyValue("--text-2").trim();
    const gridColor = getComputedStyle(document.body).getPropertyValue("--border").trim();
    const ctx = document.getElementById("usageChart").getContext("2d");

    window.dashboardChart = new Chart(ctx, {
      type: "line",
      data: {
        labels: labels24H,
        datasets: [
          {
            label: "Requests",
            data: data24H_success,
            borderColor: "#3b82f6",
            backgroundColor: "rgba(59, 130, 246, 0.06)",
            fill: true,
            tension: 0.35,
            pointRadius: 3,
            pointBackgroundColor: "#3b82f6",
            borderWidth: 1.5,
          },
          {
            label: "Failures",
            data: data24H_errors,
            borderColor: "#f43f5e",
            borderDash: [4, 4],
            tension: 0.2,
            pointRadius: 2,
            borderWidth: 1,
            fill: false,
          },
        ],
      },
      options: {
        responsive: true,
        animation: { duration: 600, easing: "easeOutQuart" },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: "rgba(13, 17, 23, 0.92)",
            titleFont: { family: "IBM Plex Mono", size: 11 },
            bodyFont: { family: "IBM Plex Mono", size: 11 },
            borderColor: "#1e2a38",
            borderWidth: 1,
            padding: 10,
            callbacks: {
              title: (context) => {
                const label = context[0].label;
                return label.includes("M") ? `Time: ${label}` : `Day: ${label}`;
              },
            },
          },
        },
        scales: {
          y: {
            beginAtZero: true,
            grid: { color: gridColor, lineWidth: 0.5 },
            ticks: { color: textColor, font: { family: "IBM Plex Mono", size: 10 } },
          },
          x: {
            grid: { display: false },
            ticks: { color: textColor, font: { family: "IBM Plex Mono", size: 10 }, maxTicksLimit: 12 },
          },
        },
      },
    });
  }

  // ---- MAIN REFRESH ----
  async function refreshDashboard() {
    try {
      const response = await fetch("/api/status");
      const data = await response.json();
      if (!data.success) throw new Error("API returned failure");

      const { stats, limits, uptime, jobs, version, cronHealthy } = data;
      const hasErrors = stats.errorsToday > 0 || cronHealthy === false;

      // Version
      document.getElementById("versionBadge").textContent = `v${version}`;

      // Status badge
      const badge      = document.getElementById("systemBadge");
      const statusDot  = document.getElementById("statusDot");
      const statusText = document.getElementById("statusText");
      badge.className      = `status-badge ${hasErrors ? "error" : "ok"}`;
      statusDot.className  = `status-dot ${hasErrors ? "err" : "ok pulse"}`;
      statusText.textContent = cronHealthy === false ? "Cron Stalled" : hasErrors ? "Degraded" : "Operational";

      // Uptime — reset to server value on each refresh so client counter stays accurate
      totalSeconds = uptime.days * 86400 + uptime.hours * 3600 + uptime.minutes * 60 + uptime.seconds;
      updateUptimeDisplay();

      // Sync indicator
      syncedSecondsAgo = 0;
      updateSyncDisplay();

      // Uptime blocks (90-day history)
      const vizContainer = document.getElementById("uptimeViz");
      vizContainer.innerHTML = "";
      stats.historyRaw.forEach((day) => {
        const block = document.createElement("div");
        block.className = `uptime-block ${day.status}`;
        const date = new Date(day.usage_date).toLocaleDateString("en-US", {
          weekday: "long", year: "numeric", month: "long", day: "numeric",
        });
        let title = date;
        if (day.status === "ok")    title += " — Operational";
        else if (day.status === "error") title += ` — Degraded (${day.error_count} errors)`;
        else if (day.status === "down")  title += " — Offline / No Heartbeat";
        else title += " — No data recorded";
        block.title = title;
        vizContainer.appendChild(block);
      });

      // AI status label
      const aiStatusEl = document.getElementById("aiStatusText");
      const todayEntry  = stats.historyRaw?.[stats.historyRaw.length - 1];
      const aiIsOffline = todayEntry?.status === "down";
      if (aiIsOffline) {
        aiStatusEl.textContent = "Offline";
        aiStatusEl.style.color = "var(--rose)";
      } else if (hasErrors) {
        aiStatusEl.textContent = "Degraded";
        aiStatusEl.style.color = "var(--amber)";
      } else {
        aiStatusEl.textContent = "Online";
        aiStatusEl.style.color = "var(--green)";
      }

      // Metric cards
      const stats24H = {
        gemini:      stats.gemini,
        groq:        stats.groq,
        openrouter:  stats.openrouter,
        tavily:      stats.tavilyToday,
        serper:      stats.serperToday,
      };
      const statsAllTime = stats.allTimeStats || { gemini: 0, groq: 0, openrouter: 0, tavily: 0, serper: 0 };

      // Cache for toggle buttons
      window._stats24H     = stats24H;
      window._statsAllTime = statsAllTime;
      window._limits       = limits;

      updateMetricCards(
        currentTierView === "24h" ? stats24H : statsAllTime,
        currentTierView !== "24h",
        limits
      );

      // Chart
      const labels7D = stats.historyLabels.map(date =>
        new Date(date).toLocaleDateString("en-US", { weekday: "short" })
      );
      const labels24H = [];
      for (let i = 23; i >= 0; i--) {
        const d = new Date();
        d.setHours(d.getHours() - i);
        labels24H.push(d.toLocaleString("en-US", { hour: "numeric", hour12: true }));
      }
      initOrUpdateChart(labels24H, stats.hourlySuccess, stats.hourlyErrors, labels7D, stats.historyData, stats.errorData);

      // Jobs table
      renderJobsTable(jobs);

      document.body.classList.add("loaded");
    } catch (err) {
      console.error("[dashboard] Refresh failed:", err);
      // Only change UI on first-load failure — don't wipe a loaded dashboard
      if (!document.body.classList.contains("loaded")) {
        const badge = document.getElementById("systemBadge");
        if (badge) badge.className = "status-badge error";
        const statusText = document.getElementById("statusText");
        if (statusText) statusText.textContent = "Error";
        document.body.classList.add("loaded");
      }
    }
  }

  // ---- TOGGLE WIRING (wired once, not per-refresh) ----
  const btnTier24h = document.getElementById("btnTier24h");
  const btnTierAll = document.getElementById("btnTierAll");
  if (btnTier24h && btnTierAll) {
    btnTier24h.addEventListener("click", () => {
      currentTierView = "24h";
      setActiveToggle(btnTier24h, btnTierAll);
      if (window._stats24H) updateMetricCards(window._stats24H, false, window._limits);
    });
    btnTierAll.addEventListener("click", () => {
      currentTierView = "all";
      setActiveToggle(btnTierAll, btnTier24h);
      if (window._statsAllTime) updateMetricCards(window._statsAllTime, true, window._limits);
    });
  }

  const btn24h = document.getElementById("btn24h");
  const btn7d  = document.getElementById("btn7d");
  if (btn24h && btn7d) {
    btn24h.addEventListener("click", () => {
      currentChartView = "24h";
      setActiveToggle(btn24h, btn7d);
      if (window.dashboardChart && chartData.labels24H) {
        window.dashboardChart.data.labels             = chartData.labels24H;
        window.dashboardChart.data.datasets[0].data   = chartData.data24H_success;
        window.dashboardChart.data.datasets[1].data   = chartData.data24H_errors;
        window.dashboardChart.update();
      }
    });
    btn7d.addEventListener("click", () => {
      currentChartView = "7d";
      setActiveToggle(btn7d, btn24h);
      if (window.dashboardChart && chartData.labels7D) {
        window.dashboardChart.data.labels             = chartData.labels7D;
        window.dashboardChart.data.datasets[0].data   = chartData.data7D_success;
        window.dashboardChart.data.datasets[1].data   = chartData.data7D_errors;
        window.dashboardChart.update();
      }
    });
  }

  // ---- INITIAL LOAD + 60-SECOND AUTO-REFRESH ----
  refreshDashboard();
  setInterval(refreshDashboard, 60_000);
});

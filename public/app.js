document.addEventListener("DOMContentLoaded", async () => {
  // Theme
  const themeBtn = document.getElementById("themeToggle");
  let isLight = localStorage.getItem("theme") === "light";

  function applyTheme() {
    document.body.classList.toggle("light", isLight);
    themeBtn.textContent = isLight ? "Dark" : "Light";

    if (window.dashboardChart) {
      const textColor = getComputedStyle(document.body)
        .getPropertyValue("--text-2")
        .trim();
      const gridColor = getComputedStyle(document.body)
        .getPropertyValue("--border")
        .trim();
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

  // Animate a number counting up from 0
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

  // Animate a progress bar filling to a percentage
  function animateBar(el, pct, delay = 0) {
    setTimeout(() => {
      el.style.width = `${Math.min(pct, 100)}%`;
    }, delay);
  }

  try {
    const response = await fetch("/api/status");
    const data = await response.json();
    if (!data.success) throw new Error("API returned failure");

    const { stats, limits, uptime, jobs, version } = data;
    const hasErrors = stats.errorsToday > 0;

    // Version
    document.getElementById("versionBadge").textContent = `v${version}`;

    // Status badge
    const badge = document.getElementById("systemBadge");
    const statusDot = document.getElementById("statusDot");
    const statusText = document.getElementById("statusText");
    badge.className = `status-badge ${hasErrors ? "error" : "ok"}`;
    statusDot.className = `status-dot ${hasErrors ? "err" : "ok pulse"}`;
    statusText.textContent = hasErrors ? "Degraded" : "Operational";

    // Dynamic Uptime Counter
    let { days, hours, minutes, seconds } = uptime;
    let totalSeconds = days * 86400 + hours * 3600 + minutes * 60 + seconds;
    const uptimeEl = document.getElementById("uptimeText");

    const updateUptimeDisplay = () => {
      const d = Math.floor(totalSeconds / 86400);
      const h = Math.floor((totalSeconds % 86400) / 3600);
      const m = Math.floor((totalSeconds % 3600) / 60);
      const s = totalSeconds % 60;
      uptimeEl.textContent = `Uptime: ${d}d ${h}h ${m}m ${s}s`;
    };

    updateUptimeDisplay();
    setInterval(() => {
      totalSeconds++;
      updateUptimeDisplay();
    }, 1000);

    // Sync time
    document.getElementById("syncTime").textContent =
      `Synced: ${new Date().toLocaleTimeString()}`;

    // Uptime blocks (90-day history with gap detection)
    const vizContainer = document.getElementById("uptimeViz");
    vizContainer.innerHTML = ""; // Clear loader if any

    stats.historyRaw.forEach((day) => {
      const block = document.createElement("div");
      block.className = `uptime-block ${day.status}`;
      
      const date = new Date(day.usage_date).toLocaleDateString("en-US", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
      });

      let title = date;
      if (day.status === "ok") title += " — Operational";
      else if (day.status === "error") title += ` — Degraded (${day.error_count} errors)`;
      else if (day.status === "down") title += " — Offline / No Heartbeat";
      else title += " — No data recorded";

      block.title = title;
      vizContainer.appendChild(block);
    });
    
    // AI status label — derived from today's history entry, not just error count.
    // "Online" requires the server to have been running today (row exists in api_usage).
    // "Degraded" = running but had AI errors. "Offline" = no heartbeat today.
    const aiStatusEl = document.getElementById("aiStatusText");
    const todayEntry = stats.historyRaw?.[stats.historyRaw.length - 1];
    const aiIsOffline = todayEntry?.status === "down";
    if (aiIsOffline) {
      aiStatusEl.textContent = "Offline";
      aiStatusEl.style.color = "var(--rose)";
    } else if (hasErrors) {
      aiStatusEl.textContent = "Degraded";
      aiStatusEl.style.color = "var(--amber, #f59e0b)";
    } else {
      aiStatusEl.textContent = "Online";
      aiStatusEl.style.color = "var(--green)";
    }

    // --- API TIER TOGGLE LOGIC ---
    const stats24H = {
      gemini: stats.gemini,
      groq: stats.groq,
      openrouter: stats.openrouter,
      tavily: stats.tavilyToday,
      serper: stats.serperToday,
    };

    const statsAllTime = stats.allTimeStats || {
      gemini: 0,
      groq: 0,
      openrouter: 0,
      tavily: 0,
      serper: 0,
    };

    // Added an 'isAllTime' parameter to handle the UI swap
    function updateMetricCards(dataObj, isAllTime = false) {
      // Update counts
      animateCount(document.getElementById("geminiCount"), dataObj.gemini);
      animateCount(document.getElementById("groqCount"), dataObj.groq);
      animateCount(document.getElementById("orCount"), dataObj.openrouter);
      animateCount(document.getElementById("tavilyCount"), dataObj.tavily);
      animateCount(document.getElementById("serperCount"), dataObj.serper);

      // Update progress bars
      const gemPct = isAllTime ? 100 : (dataObj.gemini / limits.gemini) * 100;
      const groqPct = isAllTime ? 100 : (dataObj.groq / limits.groq) * 100;
      const orPct = isAllTime
        ? 100
        : (dataObj.openrouter / limits.openrouter) * 100;
      const tavPct = isAllTime ? 100 : (dataObj.tavily / limits.tavily) * 100;
      const serpPct = (dataObj.serper / limits.serper) * 100; // Serper calculation never changes

      animateBar(document.getElementById("geminiBar"), gemPct, 0);
      animateBar(document.getElementById("groqBar"), groqPct, 50);
      animateBar(document.getElementById("orBar"), orPct, 100);
      animateBar(document.getElementById("tavilyBar"), tavPct, 150);
      animateBar(document.getElementById("serperBar"), serpPct, 200);
    }

    // Initialize the dashboard with the 24H view
    updateMetricCards(stats24H, false);

    // Button Click Listeners
    const btnTier24h = document.getElementById("btnTier24h");
    const btnTierAll = document.getElementById("btnTierAll");

    if (btnTier24h && btnTierAll) {
      btnTier24h.addEventListener("click", () => {
        btnTier24h.style.background = "var(--bg-2)";
        btnTier24h.style.color = "var(--text-1)";
        btnTierAll.style.background = "transparent";
        btnTierAll.style.color = "var(--text-2)";
        updateMetricCards(stats24H, false);
      });

      btnTierAll.addEventListener("click", () => {
        btnTierAll.style.background = "var(--bg-2)";
        btnTierAll.style.color = "var(--text-1)";
        btnTier24h.style.background = "transparent";
        btnTier24h.style.color = "var(--text-2)";
        updateMetricCards(statsAllTime, true);
      });
    }

    // --- CHART DATA PREPARATION ---
    const labels7D = stats.historyLabels.map((date) =>
      new Date(date).toLocaleDateString("en-US", { weekday: "short" }),
    );
    const data7D_success = stats.historyData;
    const data7D_errors = stats.errorData;

    const labels24H = [];
    for (let i = 23; i >= 0; i--) {
      const d = new Date();
      d.setHours(d.getHours() - i);
      labels24H.push(
        d.toLocaleString("en-US", { hour: "numeric", hour12: true }),
      );
    }
    const data24H_success = stats.hourlySuccess;
    const data24H_errors = stats.hourlyErrors;

    // --- INITIALIZE CHART ---
    const ctx = document.getElementById("usageChart").getContext("2d");
    const textColor = getComputedStyle(document.body)
      .getPropertyValue("--text-2")
      .trim();
    const gridColor = getComputedStyle(document.body)
      .getPropertyValue("--border")
      .trim();

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
            ticks: {
              color: textColor,
              font: { family: "IBM Plex Mono", size: 10 },
            },
          },
          x: {
            grid: { display: false },
            ticks: {
              color: textColor,
              font: { family: "IBM Plex Mono", size: 10 },
              maxTicksLimit: 12,
            },
          },
        },
      },
    });

    // --- CHART TOGGLE LOGIC ---
    const btn24h = document.getElementById("btn24h");
    const btn7d = document.getElementById("btn7d");

    if (btn24h && btn7d) {
      function updateChart(view) {
        if (view === "24h") {
          btn24h.style.background = "var(--bg-2)";
          btn24h.style.color = "var(--text-1)";
          btn7d.style.background = "transparent";
          btn7d.style.color = "var(--text-2)";
          window.dashboardChart.data.labels = labels24H;
          window.dashboardChart.data.datasets[0].data = data24H_success;
          window.dashboardChart.data.datasets[1].data = data24H_errors;
        } else {
          btn7d.style.background = "var(--bg-2)";
          btn7d.style.color = "var(--text-1)";
          btn24h.style.background = "transparent";
          btn24h.style.color = "var(--text-2)";
          window.dashboardChart.data.labels = labels7D;
          window.dashboardChart.data.datasets[0].data = data7D_success;
          window.dashboardChart.data.datasets[1].data = data7D_errors;
        }
        window.dashboardChart.update();
      }

      btn24h.addEventListener("click", () => updateChart("24h"));
      btn7d.addEventListener("click", () => updateChart("7d"));
    }

    // --- JOBS TABLE ---
    const tbody = document.getElementById("jobsTableBody");
    tbody.innerHTML = "";

    if (jobs && jobs.length > 0) {
      jobs.forEach((job) => {
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td class="job-name">${job.name}</td>
          <td class="job-schedule">${job.schedule}</td>
          <td class="job-desc">
            ${job.description}
            <div style="font-size: 0.7rem; color: var(--text-3); margin-top: 0.35rem;">
               <i>${job.layman}</i>
            </div>
          </td>
          <td class="job-last-run">${
            job.lastFired
              ? `<span style="font-family:var(--mono);font-size:0.7rem;color:var(--teal)">${job.lastFired}</span>`
              : `<span style="font-family:var(--mono);font-size:0.7rem;color:var(--text-3)">—</span>`
          }</td>
          <td><span class="job-status ${job.status}">${job.status}</span></td>
        `;
        tbody.appendChild(tr);
      });
    } else {
      tbody.innerHTML = `<tr><td colspan="4" class="loading-cell">No processes registered.</td></tr>`;
    }

    document.body.classList.add("loaded");
  } catch (err) {
    console.error("[dashboard] Initialisation failed:", err);
    const badge = document.getElementById("systemBadge");
    if (badge) badge.className = "status-badge error";
    const statusText = document.getElementById("statusText");
    if (statusText) statusText.textContent = "Error";
    document.body.classList.add("loaded");
  }
});

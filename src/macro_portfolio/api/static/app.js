const providerState = {
  tree: [],
  sourceSelections: {},
  itemNodes: {},
  customItems: [],
};

const dataState = {
  artifacts: {},
  chart: null,
  runId: null,
};

const api = {
  async getRuns() {
    return handle(await fetch("/api/runs"));
  },
  async createRun() {
    return handle(
      await fetch("/api/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: "Research Run" }),
      }),
    );
  },
  async getProvidersConfig() {
    return handle(await fetch("/api/providers/config"));
  },
  async runProviders(runId, payload) {
    return handle(
      await fetch(`/api/runs/${runId}/providers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }),
    );
  },
  async getStage(runId, stage) {
    return handle(await fetch(`/api/runs/${runId}/stages/${stage}`));
  },
  async runData(runId, payload) {
    return handle(
      await fetch(`/api/runs/${runId}/data`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }),
    );
  },
  async getArtifact(runId, stage, name) {
    return handle(await fetch(`/api/runs/${runId}/artifacts/${stage}/${name}`));
  },
  async loadProvidersFromRun(runId, sourceRunId) {
    return handle(
      await fetch(`/api/runs/${runId}/providers/load?source_run_id=${encodeURIComponent(sourceRunId)}`, {
        method: "POST",
      }),
    );
  },
  async openFolder(runId, target) {
    return handle(
      await fetch(`/api/runs/${runId}/open?target=${encodeURIComponent(target)}`, {
        method: "POST",
      }),
    );
  },
};

async function init() {
  bindTabs();
  bindActions();
  await loadProvidersConfig();
  await refreshRuns();
}

function bindTabs() {
  document.querySelectorAll(".tab-button").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll(".tab-button").forEach((node) => node.classList.remove("active"));
      document.querySelectorAll(".page").forEach((node) => node.classList.remove("active"));
      button.classList.add("active");
      document.getElementById(button.dataset.tab).classList.add("active");
    });
  });
}

function bindActions() {
  document.getElementById("create-run").addEventListener("click", async () => {
    const run = await api.createRun();
    await refreshRuns(run.run_id);
  });

  document.getElementById("run-select").addEventListener("change", async () => {
    const runId = currentRunId();
    if (runId) {
      await renderProviders(runId);
      await renderData(runId);
    }
  });

  document.getElementById("run-providers").addEventListener("click", async () => {
    await runProvidersWithItems(null);
  });

  document.getElementById("load-providers-from-run").addEventListener("click", async () => {
    const runId = currentRunId();
    const sourceRunId = document.getElementById("providers-copy-source").value;
    if (!runId || !sourceRunId) {
      setProvidersStatus("请选择当前实验和要载入的历史实验。");
      return;
    }
    if (runId === sourceRunId) {
      setProvidersStatus("当前实验和来源实验相同，无需载入。");
      return;
    }
    setProvidersStatus(`正在载入 ${sourceRunId} 的 providers 数据`);
    try {
      await api.loadProvidersFromRun(runId, sourceRunId);
      await renderProviders(runId);
    } catch (error) {
      setProvidersStatus(`载入失败: ${error.message}`);
    }
  });

  document.getElementById("open-run-folder").addEventListener("click", async () => {
    await openFolder("run");
  });

  document.getElementById("open-providers-folder").addEventListener("click", async () => {
    await openFolder("providers");
  });

  document.getElementById("run-data").addEventListener("click", async () => {
    await runDataStage();
  });

  document.getElementById("open-data-folder").addEventListener("click", async () => {
    await openDataFolder();
  });

  document.getElementById("data-chart-group").addEventListener("change", () => {
    renderChartSeriesToggles();
    updateDataChart();
  });

  document.getElementById("data-chart-frequency").addEventListener("change", () => {
    updateDataChart();
  });

  document.getElementById("data-series-toggles").addEventListener("change", () => {
    updateDataChart();
  });

  document.addEventListener("click", (event) => {
    if (event.target?.id === "add-custom-equity") {
      addCustomEquity();
    }
  });
}

async function loadProvidersConfig() {
  const config = await api.getProvidersConfig();
  providerState.tree = config.provider_tree;
  if (config.prefilled_api_fields.FRED_API_KEY) {
    document.getElementById("fred-api-key").value = config.prefilled_api_fields.FRED_API_KEY;
  }
  for (const category of providerState.tree) {
    for (const group of category.groups) {
      for (const item of group.items) {
        providerState.sourceSelections[item.id] = item.sources[0];
      }
    }
  }
  renderProvidersTree();
}

async function refreshRuns(selectedId = null) {
  const data = await api.getRuns();
  const select = document.getElementById("run-select");
  select.innerHTML = data.items.map((item) => `<option value="${item.run_id}">${item.run_id} · ${item.status}</option>`).join("");
  const copySelect = document.getElementById("providers-copy-source");
  copySelect.innerHTML =
    `<option value="">选择已有实验作为数据来源</option>` +
    data.items.map((item) => `<option value="${item.run_id}">${item.run_id} · ${item.status}</option>`).join("");
  if (selectedId) select.value = selectedId;
  if (!copySelect.value && data.items.length > 1) {
    const fallback = data.items.find((item) => item.run_id !== select.value);
    if (fallback) copySelect.value = fallback.run_id;
  }
  if (select.value) {
    await renderProviders(select.value);
    await renderData(select.value);
  }
}

function currentRunId() {
  return document.getElementById("run-select").value;
}

function renderProvidersTree() {
  const container = document.getElementById("providers-tree");
  container.innerHTML = providerState.tree
    .map(
      (category) => `
        <section class="accordion-card">
          <button class="accordion-toggle is-open" data-target="category-${slugify(category.category)}" type="button">
            <span class="accordion-title">${category.category}</span>
            <span class="accordion-meta">${category.groups.length} 个分组</span>
            <span class="accordion-chevron">▾</span>
          </button>
          <div class="accordion-panel is-open" id="category-${slugify(category.category)}">
            ${category.groups
              .map(
                (group) => `
                  <section class="sub-accordion-card">
                    <button class="sub-accordion-toggle" data-target="group-${slugify(category.category)}-${slugify(group.group)}" type="button">
                      <span class="accordion-title">${group.group}</span>
                      <span class="accordion-meta">${groupItems(category, group).length} 个子类目</span>
                      <span class="accordion-chevron">▸</span>
                    </button>
                    <div class="sub-accordion-panel" id="group-${slugify(category.category)}-${slugify(group.group)}">
                      ${groupItems(category, group).map((item) => providerItemMarkup(item)).join("")}
                      ${category.category === "资产数据" && group.group === "股票" ? customEquityControlsMarkup() : ""}
                    </div>
                  </section>
                `,
              )
              .join("")}
          </div>
        </section>
      `,
    )
    .join("");

  bindAccordionToggles();

  for (const category of providerState.tree) {
    for (const group of category.groups) {
      for (const item of groupItems(category, group)) {
        const select = document.getElementById(`source-${item.id}`);
        if (select) {
          select.addEventListener("change", (event) => {
            providerState.sourceSelections[item.id] = event.target.value;
          });
        }
        const button = document.getElementById(`fetch-${item.id}`);
        if (button) {
          button.addEventListener("click", async () => {
            await runProvidersWithItems([item.id]);
          });
        }
        bindCustomItemControls(item);
      }
    }
  }
}

function bindAccordionToggles() {
  document.querySelectorAll(".accordion-toggle, .sub-accordion-toggle").forEach((button) => {
    button.addEventListener("click", () => {
      const panel = document.getElementById(button.dataset.target);
      const isOpen = button.classList.contains("is-open");
      button.classList.toggle("is-open", !isOpen);
      panel.classList.toggle("is-open", !isOpen);
      const chevron = button.querySelector(".accordion-chevron");
      if (chevron) {
        chevron.textContent = !isOpen ? "▾" : "▸";
      }
    });
  });
}

function providerItemMarkup(item) {
  return `
    <div class="provider-item" id="node-${item.id}">
      <div class="provider-main">
        <div>
          <strong>${item.label}</strong>
          ${item.supports_openbb ? `<span class="source-badge">OpenBB</span>` : ""}
          <p>字段: ${item.column} · 输出文件: ${item.artifact}</p>
          <p>原始计价/单位: ${item.quote_unit || "未标注"}</p>
          ${item.symbol ? `<p>代码: ${item.symbol}</p>` : ""}
        </div>
        <div class="provider-actions">
          ${item.is_custom ? `
            <label>股票名称
              <input id="custom-label-${item.id}" value="${item.label || ""}" />
            </label>
            <label>股票代码
              <input id="custom-symbol-${item.id}" value="${item.symbol || ""}" />
            </label>
          ` : ""}
          ${item.code_field ? `
            <label>${item.code_label}
              <input id="code-${item.id}" value="${item.code_value || ""}" />
            </label>
          ` : ""}
          <label>来源
            <select id="source-${item.id}" ${item.sources.length === 1 ? "disabled" : ""}>
              ${item.sources.map((source) => `<option value="${source}">${sourceOptionLabel(source)}</option>`).join("")}
            </select>
          </label>
          <div class="item-action-row">
            <button class="secondary-button" id="fetch-${item.id}">拉取 / 更新</button>
            ${item.is_custom ? `<button class="ghost-button" id="remove-${item.id}" type="button">删除</button>` : ""}
          </div>
        </div>
      </div>
      <div class="mini-status" id="status-${item.id}">未执行</div>
    </div>
  `;
}

async function runProvidersWithItems(selectedItems) {
  const runId = currentRunId();
  if (!runId) {
    setProvidersStatus("请先创建一个实验 run。");
    return;
  }
  setProvidersStatus(selectedItems ? `运行中: ${selectedItems.join(", ")}` : "运行中: 全量更新");
  try {
    await api.runProviders(runId, collectProvidersPayload(selectedItems));
    await renderProviders(runId);
  } catch (error) {
    setProvidersStatus(`失败: ${error.message}`);
  }
}

function collectProvidersPayload(selectedItems = null) {
  const payload = {
    start_date: document.getElementById("providers-start-date").value,
    end_date: document.getElementById("providers-end-date").value,
    fred_api_key: document.getElementById("fred-api-key").value.trim() || null,
    csi300_code: document.getElementById("code-csi300")?.value || "510300.SH",
    star50_code: document.getElementById("code-star50")?.value || "588000.SH",
    cgb_code: document.getElementById("code-cgb")?.value || "511010.SH",
    hsi_code: document.getElementById("code-hsi_hk")?.value || "2800.HK",
    hstech_code: document.getElementById("code-hstech_hk")?.value || "3033.HK",
    selected_items: selectedItems,
    custom_equities: collectCustomEquities(),
  };
  const fieldValues = {};
  for (const category of providerState.tree) {
    for (const group of category.groups) {
      for (const item of group.items) {
        fieldValues[item.source_field] = providerState.sourceSelections[item.id];
      }
    }
  }
  return { ...payload, ...fieldValues };
}

async function renderProviders(runId) {
  const payload = await api.getStage(runId, "providers");
  const changed = syncCustomItemsFromSummary(payload.summary?.categories || []);
  if (changed) {
    renderProvidersTree();
  }
  setProvidersStatus(buildProvidersStatus(payload));
  document.getElementById("providers-log").textContent = payload.log || "";
  renderProviderResults(payload.summary?.categories || []);
}

async function runDataStage() {
  const runId = currentRunId();
  if (!runId) {
    setDataStatus("请先创建或选择一个实验 run。");
    return;
  }
  setDataStatus("运行中: data");
  try {
    await api.runData(runId, collectDataPayload());
    await renderData(runId);
  } catch (error) {
    setDataStatus(`失败: ${error.message}`);
    document.getElementById("data-log").textContent = String(error.message || error);
  }
}

function collectDataPayload() {
  return {
    us_release_lag: Number(document.getElementById("data-us-lag").value || 1),
    cn_release_lag: Number(document.getElementById("data-cn-lag").value || 0),
    global_release_lag: Number(document.getElementById("data-global-lag").value || 1),
    z_window: Number(document.getElementById("data-z-window").value || 36),
  };
}

async function renderData(runId) {
  if (dataState.runId !== runId) {
    dataState.artifacts = {};
    dataState.runId = runId;
  }
  const payload = await api.getStage(runId, "data");
  setDataStatus(buildStageStatus(payload, "data"));
  document.getElementById("data-log").textContent = payload.log || "";
  renderDataSummary(payload.summary || {});
  renderDataRanges(payload.summary || {});
  if (payload.status === "success") {
    await loadDataArtifacts(runId);
    renderChartSeriesToggles();
    updateDataChart();
  }
}

function setProvidersStatus(text) {
  document.getElementById("providers-status").textContent = text;
}

function setDataStatus(text) {
  document.getElementById("data-status").textContent = text;
}

function renderProviderResults(groups) {
  if (!groups.length) return;

  for (const group of groups) {
    for (const item of group.items) {
      const mini = document.getElementById(`status-${item.id}`);
      if (mini) {
        const dateRange =
          item.start && item.end ? ` · 范围 ${item.start} ~ ${item.end}` : "";
        const frequency = item.frequency ? ` · ${item.frequency}` : "";
        const updatedAt = item.last_updated ? ` · 上次拉取 ${item.last_updated}` : "";
        mini.textContent =
          `${translateStatus(item.status)} · 来源 ${item.selected_source}` +
          ` · ${item.rows} 行 · ${item.non_null} 非空${frequency}${dateRange}${updatedAt}`;
        mini.classList.remove("success", "failed", "idle");
        mini.classList.add(statusClass(item.status));
      }
    }
  }
}

function buildProvidersStatus(payload) {
  const groups = payload.summary?.categories || [];
  const items = groups.flatMap((group) => group.items || []);
  if (!items.length) {
    return `状态: ${payload.status}`;
  }
  const successCount = items.filter((item) => item.status === "success").length;
  const failedCount = items.filter((item) => item.status === "failed").length;
  const pendingCount = items.filter((item) => item.status === "not_run").length;
  return `状态: ${payload.status} · 成功 ${successCount}/${items.length}` +
    (pendingCount ? ` · 未执行 ${pendingCount}` : "") +
    (failedCount ? ` · 失败 ${failedCount}` : "");
}

function buildStageStatus(payload, stageName) {
  if (payload.status !== "success") {
    const error = payload.summary?.error ? ` · ${payload.summary.error}` : "";
    return `状态: ${payload.status}${error}`;
  }
  return `状态: success · ${stageName}`;
}

function renderDataSummary(summary) {
  const container = document.getElementById("data-summary");
  if (!summary || !Object.keys(summary).length) {
    container.innerHTML = `<div class="hint-box">这一层还没有可展示的数据摘要。</div>`;
    return;
  }
  const rawCount = Object.keys(summary.raw_datasets || {}).length;
  const processedCount = Object.keys(summary.processed_datasets || {}).length;
  const cards = [
    ["原始数据组数", rawCount],
    ["处理后数据组数", processedCount],
    ["Feature Rows", summary.feature_rows],
    ["Asset Panel Rows", summary.asset_panel_rows],
    ["核心资产", (summary.asset_names || []).join(", ") || "-"],
    ["特征示例", (summary.feature_columns || []).slice(0, 6).join(", ") || "-"],
  ];
  container.innerHTML = cards
    .map(
      ([label, value]) => `
        <div class="metric-card">
          <div class="metric-label">${label}</div>
          <div class="metric-value">${value ?? "-"}</div>
        </div>
      `,
    )
    .join("");
}

function renderDataRanges(summary) {
  const container = document.getElementById("data-ranges");
  const raw = summary.raw_datasets || {};
  const processed = summary.processed_datasets || {};
  if (!Object.keys(raw).length && !Object.keys(processed).length) {
    container.innerHTML = `<div class="hint-box">这一层还没有可展示的数据范围。</div>`;
    return;
  }
  const rawCards = Object.values(raw)
    .map(
      (item) => `
        <div class="range-card">
          <div class="range-card-head">
            <strong>${item.name}</strong>
            <span class="range-frequency">${item.frequency || "-"}</span>
          </div>
          <div class="range-row"><span>时间范围</span><strong>${item.start || "-"} ~ ${item.end || "-"}</strong></div>
          <div class="range-row"><span>行数</span><strong>${item.rows ?? "-"}</strong></div>
          <div class="range-row"><span>列数</span><strong>${(item.columns || []).length || "-"}</strong></div>
        </div>
      `,
    )
    .join("");
  const processedCards = Object.values(processed)
    .map(
      (item) => `
        <div class="range-card">
          <div class="range-card-head">
            <strong>${item.name}</strong>
            <span class="range-frequency">${item.frequency || "-"}</span>
          </div>
          <div class="range-row"><span>时间范围</span><strong>${item.start || "-"} ~ ${item.end || "-"}</strong></div>
          <div class="range-row"><span>行数</span><strong>${item.rows ?? "-"}</strong></div>
          <div class="range-row"><span>列数</span><strong>${(item.columns || []).length || "-"}</strong></div>
        </div>
      `,
    )
    .join("");
  container.innerHTML = `
    <div class="range-section spotlight-section">
      <div class="group-head">
        <div>
          <p class="eyebrow">Raw Inputs</p>
          <h3>原始输入数据</h3>
        </div>
      </div>
      <div class="intersection-card">
        <div class="intersection-label">原始输入时间交集</div>
        <div class="intersection-value">${summary.intersections?.raw?.start || "-"} ~ ${summary.intersections?.raw?.end || "-"}</div>
      </div>
      <div class="range-grid">${rawCards}</div>
    </div>
    <div class="range-section spotlight-section">
      <div class="group-head">
        <div>
          <p class="eyebrow">Processed Outputs</p>
          <h3>处理后数据</h3>
        </div>
      </div>
      <div class="intersection-card">
        <div class="intersection-label">处理后数据时间交集</div>
        <div class="intersection-value">${summary.intersections?.processed?.start || "-"} ~ ${summary.intersections?.processed?.end || "-"}</div>
      </div>
      <div class="range-grid">${processedCards}</div>
    </div>
  `;
}

async function loadDataArtifacts(runId) {
  const dataArtifacts = ["features", "asset_returns"];
  const providerArtifacts = ["us_macro", "cn_macro", "global_prices", "cn_assets"];
  for (const name of dataArtifacts) {
    if (!dataState.artifacts[name]) {
      dataState.artifacts[name] = await api.getArtifact(runId, "data", name);
    }
  }
  for (const name of providerArtifacts) {
    const key = `providers:${name}`;
    if (!dataState.artifacts[key]) {
      dataState.artifacts[key] = await api.getArtifact(runId, "providers", name);
    }
  }
}

function renderChartSeriesToggles() {
  const group = document.getElementById("data-chart-group").value;
  const container = document.getElementById("data-series-toggles");
  const series = availableSeriesForGroup(group);
  if (!series.length) {
    container.innerHTML = `<div class="hint-box">当前分组没有可展示的序列。</div>`;
    return;
  }
  container.innerHTML = series
    .map(
      (name, index) => `
        <label class="toggle-pill">
          <input type="checkbox" value="${name}" ${index < 4 ? "checked" : ""} />
          <span>${name}</span>
        </label>
      `,
    )
    .join("");
}

function availableSeriesForGroup(group) {
  const globalColumns = (dataState.artifacts["providers:global_prices"]?.columns || []).filter((name) => !["date", "index", "USDCNY"].includes(name));
  const cnAssetColumns = (dataState.artifacts["providers:cn_assets"]?.columns || []).filter((name) => !["date", "index"].includes(name));
  const usMacroColumns = (dataState.artifacts["providers:us_macro"]?.columns || []).filter((name) => !["date", "index"].includes(name));
  const cnMacroColumns = (dataState.artifacts["providers:cn_macro"]?.columns || []).filter((name) => !["date", "index"].includes(name));
  const stockUniverse = ["SPY", "QQQ", "CSI300", "STAR50", "HSI_HK", "HSTECH_HK"];
  const bondUniverse = ["TLT", "CGB"];
  const altUniverse = ["GLD", "SLV", "DBC", "USO", "BTC"];
  const stockLikeGlobal = globalColumns.filter((name) => !bondUniverse.includes(name) && !altUniverse.includes(name));
  const groups = {
    stocks: [...stockLikeGlobal, ...cnAssetColumns.filter((name) => stockUniverse.includes(name))],
    bonds: [...globalColumns.filter((name) => bondUniverse.includes(name)), ...cnAssetColumns.filter((name) => bondUniverse.includes(name))],
    alts: globalColumns.filter((name) => altUniverse.includes(name)),
    us_macro: usMacroColumns,
    cn_macro: cnMacroColumns,
  };
  return Array.from(new Set(groups[group] || []));
}

function updateDataChart() {
  const group = document.getElementById("data-chart-group").value;
  const frequency = document.getElementById("data-chart-frequency").value;
  const selectedSeries = Array.from(document.querySelectorAll("#data-series-toggles input:checked")).map((node) => node.value);
  const rows = chartRowsForGroup(group);
  if (!rows.length || !selectedSeries.length) {
    destroyDataChart();
    return;
  }
  const aggregated = aggregateRows(rows, selectedSeries, frequency);
  const labels = aggregated.map((row) => row.label);
  const datasets = selectedSeries.map((series, index) => ({
    label: series,
    data: aggregated.map((row) => row.values[series]),
    borderColor: chartColor(index),
    backgroundColor: chartColor(index),
    fill: false,
    tension: 0.15,
  }));
  drawDataChart(labels, datasets);
}

function chartRowsForGroup(group) {
  if (group === "stocks") {
    return mergeRowSets([
      dataState.artifacts["providers:global_prices"]?.rows || [],
      dataState.artifacts["providers:cn_assets"]?.rows || [],
    ]);
  }
  if (group === "bonds") {
    return mergeRowSets([
      dataState.artifacts["providers:global_prices"]?.rows || [],
      dataState.artifacts["providers:cn_assets"]?.rows || [],
    ]);
  }
  if (group === "alts") {
    return dataState.artifacts["providers:global_prices"]?.rows || [];
  }
  if (group === "us_macro") {
    return dataState.artifacts["providers:us_macro"]?.rows || [];
  }
  if (group === "cn_macro") {
    return dataState.artifacts["providers:cn_macro"]?.rows || [];
  }
  return [];
}

function mergeRowSets(rowSets) {
  const merged = new Map();
  for (const rows of rowSets) {
    for (const row of rows) {
      const key = row.date || row.index;
      if (!key) continue;
      const existing = merged.get(key) || { date: key };
      merged.set(key, { ...existing, ...row, date: key });
    }
  }
  return Array.from(merged.values()).sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

function aggregateRows(rows, seriesNames, frequency) {
  const buckets = new Map();
  for (const row of rows) {
    const dateValue = row.date || row.index;
    if (!dateValue) continue;
    const date = new Date(dateValue);
    if (Number.isNaN(date.getTime())) continue;
    const key = bucketKey(date, frequency);
    if (!buckets.has(key)) {
      buckets.set(key, { label: key, values: {}, counts: {} });
    }
    const bucket = buckets.get(key);
    for (const name of seriesNames) {
      const value = Number(row[name]);
      if (!Number.isFinite(value)) continue;
      bucket.values[name] = (bucket.values[name] || 0) + value;
      bucket.counts[name] = (bucket.counts[name] || 0) + 1;
    }
  }
  return Array.from(buckets.values())
    .sort((a, b) => a.label.localeCompare(b.label))
    .map((bucket) => ({
      label: bucket.label,
      values: Object.fromEntries(seriesNames.map((name) => [name, bucket.counts[name] ? bucket.values[name] / bucket.counts[name] : null])),
    }));
}

function bucketKey(date, frequency) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  if (frequency === "year") return `${year}`;
  if (frequency === "quarter") return `${year}-Q${Math.floor(date.getMonth() / 3) + 1}`;
  if (frequency === "day") return `${year}-${month}-${day}`;
  return `${year}-${month}`;
}

function drawDataChart(labels, datasets) {
  const canvas = document.getElementById("data-chart");
  const ctx = canvas.getContext("2d");
  destroyDataChart();
  dataState.chart = new Chart(ctx, {
    type: "line",
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "nearest", intersect: false },
      plugins: {
        legend: { position: "bottom" },
        tooltip: { callbacks: { label: (context) => `${context.dataset.label}: ${formatCell(context.raw)}` } },
      },
      scales: {
        x: { ticks: { maxTicksLimit: 12 } },
        y: {
          title: { display: true, text: "数据值" },
          ticks: { callback: (value) => Number(value).toFixed(2) },
        },
      },
    },
  });
}

function destroyDataChart() {
  if (dataState.chart) {
    dataState.chart.destroy();
    dataState.chart = null;
  }
}

function chartColor(index) {
  const palette = ["#145a41", "#b54a3f", "#1c4ea0", "#9a6b14", "#5d2f86", "#127d8a", "#6d7c1d"];
  return palette[index % palette.length];
}

function syncCustomItemsFromSummary(groups) {
  const summaryCustomItems = groups.flatMap((group) => group.items || []).filter((item) => item.is_custom);
  const nextCustomItems = summaryCustomItems.map((item) => ({
    id: item.id,
    label: item.label,
    column: item.column,
    artifact: item.artifact,
    sources: item.sources || ["yahoo", "openbb"],
    source_field: "custom_equity_source",
    quote_unit: item.quote_unit || "USD",
    symbol: item.symbol || "",
    is_custom: true,
    supports_openbb: item.supports_openbb ?? true,
    selected_source: item.selected_source || (item.sources || ["yahoo"])[0],
  }));
  const changed = JSON.stringify(nextCustomItems) !== JSON.stringify(providerState.customItems);
  if (changed) {
    providerState.customItems = nextCustomItems;
    for (const item of providerState.customItems) {
      providerState.sourceSelections[item.id] = item.selected_source || providerState.sourceSelections[item.id] || item.sources[0];
    }
  }
  return changed;
}

function translateStatus(status) {
  if (status === "success") return "成功";
  if (status === "failed") return "失败";
  if (status === "not_run") return "未执行";
  return "未执行";
}

function statusClass(status) {
  if (status === "success") return "success";
  if (status === "failed") return "failed";
  return "idle";
}

function groupItems(category, group) {
  if (category.category === "资产数据" && group.group === "股票") {
    return [...group.items, ...providerState.customItems];
  }
  return group.items;
}

function customEquityControlsMarkup() {
  return `
    <div class="custom-equity-controls">
      <button id="add-custom-equity" class="secondary-button" type="button">+ 添加自定义股票</button>
    </div>
  `;
}

function addCustomEquity() {
  const id = `custom_equity_${Date.now()}`;
  providerState.customItems.push({
    id,
    label: "自定义股票",
    column: id.toUpperCase(),
    artifact: "global_prices.csv",
    sources: ["yahoo", "openbb"],
    source_field: "custom_equity_source",
    quote_unit: "USD",
    symbol: "",
    is_custom: true,
    supports_openbb: true,
  });
  providerState.sourceSelections[id] = "yahoo";
  renderProvidersTree();
}

function bindCustomItemControls(item) {
  if (!item.is_custom) return;
  const removeButton = document.getElementById(`remove-${item.id}`);
  if (removeButton) {
    removeButton.addEventListener("click", () => {
      providerState.customItems = providerState.customItems.filter((entry) => entry.id !== item.id);
      delete providerState.sourceSelections[item.id];
      renderProvidersTree();
    });
  }
}

function collectCustomEquities() {
  return providerState.customItems
    .map((item) => ({
      id: item.id,
      label: document.getElementById(`custom-label-${item.id}`)?.value?.trim() || item.label,
      symbol: document.getElementById(`custom-symbol-${item.id}`)?.value?.trim() || item.symbol,
      source: providerState.sourceSelections[item.id] || "yahoo",
    }))
    .filter((item) => item.symbol);
}

function sourceOptionLabel(source) {
  return source === "openbb" ? "openbb · OpenBB" : source;
}

async function openFolder(target) {
  const runId = currentRunId();
  if (!runId) {
    setProvidersStatus("请先创建一个实验 run。");
    return;
  }
  try {
    const result = await api.openFolder(runId, target);
    setProvidersStatus(`已打开: ${result.path}`);
  } catch (error) {
    setProvidersStatus(`打开失败: ${error.message}`);
  }
}

async function openDataFolder() {
  const runId = currentRunId();
  if (!runId) {
    setDataStatus("请先创建一个实验 run。");
    return;
  }
  try {
    const result = await api.openFolder(runId, "data");
    setDataStatus(`已打开: ${result.path}`);
  } catch (error) {
    setDataStatus(`打开失败: ${error.message}`);
  }
}

async function handle(res) {
  const payload = await res.json();
  if (!res.ok) throw new Error(payload.detail || "Request failed");
  return payload;
}

function formatCell(value) {
  if (value == null) return "";
  if (typeof value === "number") return Number.isFinite(value) ? value.toFixed(4) : "";
  return String(value);
}

function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^\w\u4e00-\u9fa5-]/g, "");
}

init();

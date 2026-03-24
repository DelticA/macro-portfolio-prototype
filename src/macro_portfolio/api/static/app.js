// ============================================================
// STATE
// ============================================================
const providerState = {
  tree: [],
  sourceSelections: {},
  itemNodes: {},
  customItems: [],
};

const dataState = {
  artifacts: {},
  charts: {}, // keyed by group id
  runId: null,
  seriesGroups: {}, // col -> group key
  groupLabels: {},  // group key -> label
};

// ============================================================
// API
// ============================================================
const api = {
  async getRuns() { return handle(await fetch("/api/runs")); },
  async createRun() {
    return handle(await fetch("/api/runs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label: "Research Run" }) }));
  },
  async getProvidersConfig() { return handle(await fetch("/api/providers/config")); },
  async runProviders(runId, payload) {
    return handle(await fetch(`/api/runs/${runId}/providers`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }));
  },
  async getStage(runId, stage) { return handle(await fetch(`/api/runs/${runId}/stages/${stage}`)); },
  async runData(runId, payload) {
    return handle(await fetch(`/api/runs/${runId}/data`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }));
  },
  async runRegime(runId, payload) {
    return handle(await fetch(`/api/runs/${runId}/regime`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }));
  },
  async getArtifact(runId, stage, name) { return handle(await fetch(`/api/runs/${runId}/artifacts/${stage}/${name}`)); },
  async loadProvidersFromRun(runId, sourceRunId) {
    return handle(await fetch(`/api/runs/${runId}/providers/load?source_run_id=${encodeURIComponent(sourceRunId)}`, { method: "POST" }));
  },
  async openFolder(runId, target) {
    return handle(await fetch(`/api/runs/${runId}/open?target=${encodeURIComponent(target)}`, { method: "POST" }));
  },
};

// ============================================================
// INIT
// ============================================================
async function init() {
  bindTabs();
  bindActions();
  await loadProvidersConfig();
  await refreshRuns();
}

function bindTabs() {
  document.querySelectorAll(".tab-button").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll(".tab-button").forEach((n) => n.classList.remove("active"));
      document.querySelectorAll(".page").forEach((n) => n.classList.remove("active"));
      button.classList.add("active");
      document.getElementById(button.dataset.tab).classList.add("active");
    });
  });
}

function activateTab(tabId) {
  document.querySelectorAll(".tab-button").forEach((n) => n.classList.remove("active"));
  document.querySelectorAll(".page").forEach((n) => n.classList.remove("active"));
  const btn = document.querySelector(`.tab-button[data-tab="${tabId}"]`);
  if (btn) btn.classList.add("active");
  const page = document.getElementById(tabId);
  if (page) page.classList.add("active");
}

function bindActions() {
  document.getElementById("create-run").addEventListener("click", async () => {
    const run = await api.createRun();
    await refreshRuns(run.run_id);
  });
  document.getElementById("run-select").addEventListener("change", async () => {
    const runId = currentRunId();
    if (runId) { await renderProviders(runId); await renderData(runId); await renderRegime(runId); }
  });
  document.getElementById("run-providers").addEventListener("click", async () => { await runProvidersWithItems(null); });
  document.getElementById("load-providers-from-run").addEventListener("click", async () => {
    const runId = currentRunId();
    const sourceRunId = document.getElementById("providers-copy-source").value;
    if (!runId || !sourceRunId) { setProvidersStatus("请选择当前实验和要载入的历史实验。"); return; }
    if (runId === sourceRunId) { setProvidersStatus("当前实验和来源实验相同，无需载入。"); return; }
    setProvidersStatus(`正在载入 ${sourceRunId} 的 providers 数据`);
    try { await api.loadProvidersFromRun(runId, sourceRunId); await renderProviders(runId); }
    catch (error) { setProvidersStatus(`载入失败: ${error.message}`); }
  });
  document.getElementById("open-run-folder").addEventListener("click", async () => { await openFolder("run"); });
  document.getElementById("open-providers-folder").addEventListener("click", async () => { await openFolder("providers"); });
  document.getElementById("run-data").addEventListener("click", async () => { await runDataStage(); });
  document.getElementById("open-data-folder").addEventListener("click", async () => { await openDataFolder(); });
  document.getElementById("goto-regime").addEventListener("click", () => { activateTab("regime-page"); });
  document.getElementById("run-regime").addEventListener("click", async () => { await runRegimeStage(); });
  document.getElementById("goto-policy")?.addEventListener("click", () => { activateTab("policy-page"); });
  document.addEventListener("click", (event) => {
    if (event.target?.id === "add-custom-equity") addCustomEquity();
    if (event.target?.classList.contains("chart-normalize-toggle")) {
      const groupKey = event.target.dataset.group;
      updateGroupChart(groupKey);
    }
  });
}

// ============================================================
// PROVIDERS
// ============================================================
async function loadProvidersConfig() {
  const config = await api.getProvidersConfig();
  providerState.tree = config.provider_tree;
  if (config.prefilled_api_fields.FRED_API_KEY) document.getElementById("fred-api-key").value = config.prefilled_api_fields.FRED_API_KEY;
  for (const category of providerState.tree)
    for (const group of category.groups)
      for (const item of group.items)
        providerState.sourceSelections[item.id] = item.sources[0];
  renderProvidersTree();
}

async function refreshRuns(selectedId = null) {
  const data = await api.getRuns();
  const select = document.getElementById("run-select");
  select.innerHTML = data.items.map((item) => `<option value="${item.run_id}">${item.run_id} · ${item.status}</option>`).join("");
  const copySelect = document.getElementById("providers-copy-source");
  copySelect.innerHTML = `<option value="">选择已有实验作为数据来源</option>` + data.items.map((item) => `<option value="${item.run_id}">${item.run_id} · ${item.status}</option>`).join("");
  if (selectedId) select.value = selectedId;
  if (!copySelect.value && data.items.length > 1) {
    const fallback = data.items.find((item) => item.run_id !== select.value);
    if (fallback) copySelect.value = fallback.run_id;
  }
  if (select.value) { await renderProviders(select.value); await renderData(select.value); await renderRegime(select.value); }
}

function currentRunId() { return document.getElementById("run-select").value; }

function renderProvidersTree() {
  const container = document.getElementById("providers-tree");
  container.innerHTML = providerState.tree.map((category) => `
    <section class="accordion-card">
      <button class="accordion-toggle is-open" data-target="category-${slugify(category.category)}" type="button">
        <span class="accordion-title">${category.category}</span>
        <span class="accordion-meta">${category.groups.length} 个分组</span>
        <span class="accordion-chevron">▾</span>
      </button>
      <div class="accordion-panel is-open" id="category-${slugify(category.category)}">
        ${category.groups.map((group) => `
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
        `).join("")}
      </div>
    </section>
  `).join("");

  bindAccordionToggles();
  for (const category of providerState.tree)
    for (const group of category.groups)
      for (const item of groupItems(category, group)) {
        const sel = document.getElementById(`source-${item.id}`);
        if (sel) sel.addEventListener("change", (e) => { providerState.sourceSelections[item.id] = e.target.value; });
        const btn = document.getElementById(`fetch-${item.id}`);
        if (btn) btn.addEventListener("click", async () => { await runProvidersWithItems([item.id]); });
        bindCustomItemControls(item);
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
      if (chevron) chevron.textContent = !isOpen ? "▾" : "▸";
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
          ${item.is_custom ? `<label>股票名称<input id="custom-label-${item.id}" value="${item.label || ""}" /></label><label>股票代码<input id="custom-symbol-${item.id}" value="${item.symbol || ""}" /></label>` : ""}
          ${item.code_field ? `<label>${item.code_label}<input id="code-${item.id}" value="${item.code_value || ""}" /></label>` : ""}
          <label>来源<select id="source-${item.id}" ${item.sources.length === 1 ? "disabled" : ""}>${item.sources.map((s) => `<option value="${s}">${sourceOptionLabel(s)}</option>`).join("")}</select></label>
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
  if (!runId) { setProvidersStatus("请先创建一个实验 run。"); return; }
  setProvidersStatus(selectedItems ? `运行中: ${selectedItems.join(", ")}` : "运行中: 全量更新");
  try { await api.runProviders(runId, collectProvidersPayload(selectedItems)); await renderProviders(runId); }
  catch (error) { setProvidersStatus(`失败: ${error.message}`); }
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
  for (const category of providerState.tree)
    for (const group of category.groups)
      for (const item of group.items)
        fieldValues[item.source_field] = providerState.sourceSelections[item.id];
  return { ...payload, ...fieldValues };
}

async function renderProviders(runId) {
  const payload = await api.getStage(runId, "providers");
  const changed = syncCustomItemsFromSummary(payload.summary?.categories || []);
  if (changed) renderProvidersTree();
  setProvidersStatus(buildProvidersStatus(payload));
  document.getElementById("providers-log").textContent = payload.log || "";
  renderProviderResults(payload.summary?.categories || []);
}

function renderProviderResults(groups) {
  if (!groups.length) return;
  for (const group of groups)
    for (const item of group.items) {
      const mini = document.getElementById(`status-${item.id}`);
      if (mini) {
        const dateRange = item.start && item.end ? ` · 范围 ${item.start} ~ ${item.end}` : "";
        const frequency = item.frequency ? ` · ${item.frequency}` : "";
        const updatedAt = item.last_updated ? ` · 上次拉取 ${item.last_updated}` : "";
        mini.textContent = `${translateStatus(item.status)} · 来源 ${item.selected_source} · ${item.rows} 行 · ${item.non_null} 非空${frequency}${dateRange}${updatedAt}`;
        mini.classList.remove("success", "failed", "idle");
        mini.classList.add(statusClass(item.status));
      }
    }
}

function buildProvidersStatus(payload) {
  const items = (payload.summary?.categories || []).flatMap((g) => g.items || []);
  if (!items.length) return `状态: ${payload.status}`;
  const s = items.filter((i) => i.status === "success").length;
  const f = items.filter((i) => i.status === "failed").length;
  const p = items.filter((i) => i.status === "not_run").length;
  return `状态: ${payload.status} · 成功 ${s}/${items.length}` + (p ? ` · 未执行 ${p}` : "") + (f ? ` · 失败 ${f}` : "");
}

// ============================================================
// DATA STAGE
// ============================================================
async function runDataStage() {
  const runId = currentRunId();
  if (!runId) { setDataStatus("请先创建或选择一个实验 run。"); return; }
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
    destroyAllCharts();
  }
  const payload = await api.getStage(runId, "data");
  setDataStatus(buildStageStatus(payload, "data"));
  document.getElementById("data-log").textContent = payload.log || "";
  renderDataSummary(payload.summary || {});
  renderDataRanges(payload.summary || {});

  if (payload.status === "success") {
    const summary = payload.summary || {};
    dataState.seriesGroups = summary.series_groups || {};
    dataState.groupLabels = summary.timeline?.group_labels || {};
    renderTimelineTable(summary.timeline || {});
    await loadDataArtifacts(runId);
    renderGroupCharts();
    document.getElementById("data-handoff-bar").classList.remove("hidden");
  }
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
  container.innerHTML = cards.map(([label, value]) => `
    <div class="metric-card">
      <div class="metric-label">${label}</div>
      <div class="metric-value">${value ?? "-"}</div>
    </div>
  `).join("");
}

function renderDataRanges(summary) {
  const container = document.getElementById("data-ranges");
  const raw = summary.raw_datasets || {};
  const processed = summary.processed_datasets || {};
  if (!Object.keys(raw).length && !Object.keys(processed).length) {
    container.innerHTML = `<div class="hint-box">这一层还没有可展示的数据范围。</div>`;
    return;
  }
  const makeCard = (item) => `
    <div class="range-card">
      <div class="range-card-head">
        <strong>${item.name}</strong>
        <span class="range-frequency">${item.frequency || "-"}</span>
      </div>
      <div class="range-row"><span>时间范围</span><strong>${item.start || "-"} ~ ${item.end || "-"}</strong></div>
      <div class="range-row"><span>行数</span><strong>${item.rows ?? "-"}</strong></div>
      <div class="range-row"><span>列数</span><strong>${(item.columns || []).length || "-"}</strong></div>
    </div>
  `;
  container.innerHTML = `
    <div class="spotlight-section">
      <div class="group-head"><div><p class="eyebrow">Raw Inputs</p><h3>原始输入数据</h3></div></div>
      <div class="intersection-card">
        <div class="intersection-label">原始输入时间交集</div>
        <div class="intersection-value">${summary.intersections?.raw?.start || "-"} ~ ${summary.intersections?.raw?.end || "-"}</div>
      </div>
      <div class="range-grid">${Object.values(raw).map(makeCard).join("")}</div>
    </div>
    <div class="spotlight-section" style="margin-top:12px">
      <div class="group-head"><div><p class="eyebrow">Processed Outputs</p><h3>处理后数据</h3></div></div>
      <div class="intersection-card">
        <div class="intersection-label">处理后时间交集</div>
        <div class="intersection-value">${summary.intersections?.processed?.start || "-"} ~ ${summary.intersections?.processed?.end || "-"}</div>
      </div>
      <div class="range-grid">${Object.values(processed).map(makeCard).join("")}</div>
    </div>
  `;
}

// ============================================================
// TIMELINE TABLE
// ============================================================
const SOURCE_LABELS = {
  us_macro: "美国宏观 (FRED)",
  cn_macro: "中国宏观 (Akshare)",
  global_prices: "全球价格 (Stooq/Binance)",
  cn_assets: "中国资产 (Akshare)",
};
const SOURCE_COLORS = {
  us_macro: "#145a41",
  cn_macro: "#1c4ea0",
  global_prices: "#9a6b14",
  cn_assets: "#b54a3f",
};

function renderTimelineTable(timeline) {
  const container = document.getElementById("data-timeline");
  const { sources = [], months = [], coverage = {} } = timeline;
  if (!months.length) { container.innerHTML = `<div class="hint-box">无时间覆盖数据。</div>`; return; }

  // For large ranges show quarterly bands in the header
  const showMonths = months.length <= 48;
  const bands = showMonths ? months : _quarterBands(months);

  const headerCells = bands.map((b) => `<th class="tl-head-cell">${showMonths ? b.slice(0, 7) : b}</th>`).join("");

  const rows = sources.map((src) => {
    const cov = coverage[src] || [];
    const color = SOURCE_COLORS[src] || "#888";
    const cells = showMonths
      ? cov.map((has) => `<td class="tl-cell ${has ? "tl-yes" : "tl-no"}" style="${has ? `background:${color}22;border-left:3px solid ${color}` : ""}"></td>`).join("")
      : _quarterCells(cov, months, color);
    return `<tr><td class="tl-source-label" style="border-left:4px solid ${color}">${SOURCE_LABELS[src] || src}</td>${cells}</tr>`;
  });

  container.innerHTML = `
    <div class="spotlight-section">
      <div class="group-head"><div><p class="eyebrow">Time Coverage</p><h3>数据时间对齐</h3></div></div>
      <p style="margin:0 0 10px;font-size:13px;color:var(--muted)">绿色/彩色格 = 有数据；灰色格 = 无数据。交集为所有数据源共有的时间段。</p>
      <div class="timeline-wrap">
        <table class="timeline-table">
          <thead><tr><th class="tl-source-col">数据源</th>${headerCells}</tr></thead>
          <tbody>${rows.join("")}</tbody>
        </table>
      </div>
    </div>
  `;
}

function _quarterBands(months) {
  const seen = new Set();
  const out = [];
  for (const m of months) {
    const [y, mo] = m.split("-").map(Number);
    const q = `${y}-Q${Math.ceil(mo / 3)}`;
    if (!seen.has(q)) { seen.add(q); out.push(q); }
  }
  return out;
}

function _quarterCells(cov, months, color) {
  const qMap = {};
  for (let i = 0; i < months.length; i++) {
    const [y, mo] = months[i].split("-").map(Number);
    const q = `${y}-Q${Math.ceil(mo / 3)}`;
    if (!qMap[q]) qMap[q] = false;
    if (cov[i]) qMap[q] = true;
  }
  return Object.values(qMap).map((has) => `<td class="tl-cell ${has ? "tl-yes" : "tl-no"}" style="${has ? `background:${color}22;border-left:3px solid ${color}` : ""}"></td>`).join("");
}

// ============================================================
// SPLIT GROUP CHARTS (dual axis)
// ============================================================
const CHART_PALETTE = ["#145a41", "#1c4ea0", "#b54a3f", "#9a6b14", "#5d2f86", "#127d8a", "#6d7c1d", "#2d6b8a", "#8a2d6d"];

// Define which artifact feeds which group
const GROUP_ARTIFACT_MAP = {
  asset_price: ["providers:global_prices", "providers:cn_assets"],
  rates: ["providers:us_macro"],
  growth: ["providers:us_macro", "providers:cn_macro"],
  inflation: ["providers:us_macro", "providers:cn_macro"],
  money_supply: ["providers:us_macro", "providers:cn_macro"],
  trade: ["providers:cn_macro"],
  credit: ["providers:cn_macro"],
  fx: ["providers:global_prices"],
  other: ["providers:us_macro", "providers:cn_macro"],
};

async function loadDataArtifacts(runId) {
  const all = [
    ["data", "features"],
    ["data", "asset_returns"],
    ["providers", "us_macro"],
    ["providers", "cn_macro"],
    ["providers", "global_prices"],
    ["providers", "cn_assets"],
  ];
  for (const [stage, name] of all) {
    const key = stage === "providers" ? `providers:${name}` : name;
    if (!dataState.artifacts[key]) {
      try { dataState.artifacts[key] = await api.getArtifact(runId, stage, name); }
      catch (_) { /* ignore missing artifacts */ }
    }
  }
}

function destroyAllCharts() {
  for (const chart of Object.values(dataState.charts)) {
    if (chart) chart.destroy();
  }
  dataState.charts = {};
}

function renderGroupCharts() {
  const container = document.getElementById("data-charts-container");
  // Determine which groups have data
  const availableGroups = new Set(Object.values(dataState.seriesGroups));
  if (!availableGroups.size) { container.innerHTML = `<div class="hint-box">没有可用的分组数据。</div>`; return; }

  destroyAllCharts();

  const groupOrder = ["asset_price", "rates", "inflation", "growth", "money_supply", "trade", "credit", "fx", "other"];
  const html = groupOrder
    .filter((g) => availableGroups.has(g))
    .map((g) => {
      const label = dataState.groupLabels[g] || g;
      return `
        <div class="chart-group-card section-gap" id="chart-card-${g}">
          <div class="chart-group-head">
            <div>
              <p class="eyebrow">Group · ${g}</p>
              <h3>${label}</h3>
            </div>
            <div class="chart-group-controls">
              <label class="toggle-pill">
                <input type="checkbox" class="chart-normalize-toggle" data-group="${g}" />
                <span>归一化对比</span>
              </label>
              <label class="toggle-pill">
                <input type="checkbox" class="chart-show-all-toggle" data-group="${g}" />
                <span>显示全部</span>
              </label>
            </div>
          </div>
          <div id="chart-toggles-${g}" class="toggle-grid" style="margin-top:10px;margin-bottom:10px"></div>
          <div class="chart-wrap">
            <canvas id="chart-canvas-${g}"></canvas>
          </div>
        </div>
      `;
    }).join("");

  container.innerHTML = html || `<div class="hint-box">没有可用的分组数据。</div>`;

  // Bind controls and initialize each chart
  groupOrder.filter((g) => availableGroups.has(g)).forEach((g) => {
    renderGroupToggles(g);
    updateGroupChart(g);

    document.getElementById(`chart-card-${g}`)?.addEventListener("change", (e) => {
      if (e.target.classList.contains("chart-show-all-toggle")) {
        const checked = e.target.checked;
        document.querySelectorAll(`#chart-toggles-${g} input[type=checkbox]`).forEach((cb) => { cb.checked = checked; });
      }
      updateGroupChart(g);
    });
  });
}

function getGroupColumns(g) {
  return Object.entries(dataState.seriesGroups)
    .filter(([, grp]) => grp === g)
    .map(([col]) => col);
}

function getGroupRows(g) {
  const artifactKeys = GROUP_ARTIFACT_MAP[g] || [];
  const rowSets = artifactKeys.map((k) => dataState.artifacts[k]?.rows || []);
  return mergeRowSets(rowSets);
}

function renderGroupToggles(g) {
  const container = document.getElementById(`chart-toggles-${g}`);
  if (!container) return;
  const cols = getGroupColumns(g);
  if (!cols.length) { container.innerHTML = `<div class="hint-box">无序列</div>`; return; }
  container.innerHTML = cols.map((col, i) => `
    <label class="toggle-pill">
      <input type="checkbox" class="series-toggle-${g}" value="${col}" ${i < 5 ? "checked" : ""} />
      <span>${col}</span>
    </label>
  `).join("");
}

function getSelectedSeries(g) {
  return Array.from(document.querySelectorAll(`.series-toggle-${g}:checked`)).map((n) => n.value);
}

function isNormalized(g) {
  return document.querySelector(`.chart-normalize-toggle[data-group="${g}"]`)?.checked ?? false;
}

function updateGroupChart(g) {
  const rows = getGroupRows(g);
  const selectedSeries = getSelectedSeries(g);
  const normalize = isNormalized(g);

  if (!rows.length || !selectedSeries.length) {
    if (dataState.charts[g]) { dataState.charts[g].destroy(); dataState.charts[g] = null; }
    return;
  }

  // Aggregate to monthly (avoid noisy day-frequency)
  const aggregated = aggregateRows(rows, selectedSeries, "month");
  const labels = aggregated.map((r) => r.label);

  // Compute value ranges to decide dual axis
  const seriesData = {};
  for (const s of selectedSeries) {
    seriesData[s] = aggregated.map((r) => {
      const v = r.values[s];
      return v != null && Number.isFinite(v) ? v : null;
    });
  }

  let primarySeries, secondarySeries;
  if (normalize) {
    // Normalize all to index 100 from first non-null
    primarySeries = selectedSeries;
    secondarySeries = [];
  } else {
    const { primary, secondary } = splitByScale(selectedSeries, seriesData);
    primarySeries = primary;
    secondarySeries = secondary;
  }

  const buildDatasets = (seriesList, yAxisID, colorOffset = 0) =>
    seriesList.map((s, i) => {
      let data = seriesData[s];
      if (normalize) data = normalizeToIndex(data);
      return {
        label: s + (normalize ? " (归一)" : ""),
        data,
        borderColor: CHART_PALETTE[(i + colorOffset) % CHART_PALETTE.length],
        backgroundColor: CHART_PALETTE[(i + colorOffset) % CHART_PALETTE.length] + "22",
        yAxisID,
        fill: false,
        tension: 0.2,
        pointRadius: 2,
        borderWidth: 2,
      };
    });

  const datasets = [
    ...buildDatasets(primarySeries, "y", 0),
    ...buildDatasets(secondarySeries, "y1", primarySeries.length),
  ];

  const scales = {
    x: { ticks: { maxTicksLimit: 14, maxRotation: 45 } },
    y: {
      type: "linear",
      position: "left",
      title: { display: true, text: normalize ? "指数 (首值=100)" : (primarySeries.length ? primarySeries.join(" / ") : "") },
      ticks: { callback: (v) => formatAxisTick(v) },
    },
  };
  if (secondarySeries.length) {
    scales.y1 = {
      type: "linear",
      position: "right",
      grid: { drawOnChartArea: false },
      title: { display: true, text: secondarySeries.join(" / ") },
      ticks: { callback: (v) => formatAxisTick(v) },
    };
  }

  const canvas = document.getElementById(`chart-canvas-${g}`);
  if (!canvas) return;
  if (dataState.charts[g]) { dataState.charts[g].destroy(); }
  dataState.charts[g] = new Chart(canvas.getContext("2d"), {
    type: "line",
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { position: "bottom", labels: { boxWidth: 12, font: { size: 11 } } },
        tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${formatCell(ctx.raw)}` } },
      },
      scales,
    },
  });
}

/** Split series into two groups by scale: 10× median-range difference → split */
function splitByScale(seriesList, seriesData) {
  if (seriesList.length <= 1) return { primary: seriesList, secondary: [] };
  const ranges = seriesList.map((s) => {
    const vals = seriesData[s].filter((v) => v != null && Number.isFinite(v));
    if (!vals.length) return { s, range: 0 };
    return { s, range: Math.max(...vals) - Math.min(...vals) };
  });
  const medianRange = _median(ranges.map((r) => r.range));
  const primary = ranges.filter((r) => r.range <= medianRange * 20).map((r) => r.s);
  const secondary = ranges.filter((r) => r.range > medianRange * 20).map((r) => r.s);
  // Guard: if everything ended up secondary, keep them all primary
  if (!primary.length) return { primary: seriesList, secondary: [] };
  return { primary, secondary };
}

function _median(arr) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function normalizeToIndex(data) {
  const first = data.find((v) => v != null && Number.isFinite(v));
  if (first == null || first === 0) return data;
  return data.map((v) => (v != null && Number.isFinite(v) ? (v / first) * 100 : null));
}

function formatAxisTick(v) {
  if (Math.abs(v) >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (Math.abs(v) >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return Number(v).toFixed(2);
}

// ============================================================
// SHARED CHART HELPERS
// ============================================================
function mergeRowSets(rowSets) {
  const merged = new Map();
  for (const rows of rowSets)
    for (const row of rows) {
      const key = row.date || row.index;
      if (!key) continue;
      merged.set(key, { ...(merged.get(key) || { date: key }), ...row, date: key });
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
    if (!buckets.has(key)) buckets.set(key, { label: key, values: {}, counts: {} });
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

// ============================================================
// REGIME STAGE
// ============================================================
async function runRegimeStage() {
  const runId = currentRunId();
  if (!runId) { setRegimeStatus("请先创建或选择一个实验 run。"); return; }
  setRegimeStatus("运行中: regime");
  try {
    const payload = {
      model_name: document.getElementById("regime-model").value,
      smoothing_window: Number(document.getElementById("regime-smoothing").value || 3),
      n_states: Number(document.getElementById("regime-n-states").value || 4),
      feature_columns: null,
    };
    await api.runRegime(runId, payload);
    await renderRegime(runId);
  } catch (error) {
    setRegimeStatus(`失败: ${error.message}`);
    document.getElementById("regime-log").textContent = String(error.message || error);
  }
}

async function renderRegime(runId) {
  const payload = await api.getStage(runId, "regime");
  setRegimeStatus(buildStageStatus(payload, "regime"));
  document.getElementById("regime-log").textContent = payload.log || "";
  renderRegimeSummary(payload.summary || {});
  if (payload.status === "success") {
    document.getElementById("regime-handoff-bar")?.classList.remove("hidden");
  }
}

function renderRegimeSummary(summary) {
  const container = document.getElementById("regime-summary");
  if (!summary || !Object.keys(summary).length || summary.error) {
    container.innerHTML = `<div class="hint-box">${summary.error || "先完成 data 阶段，再执行状态识别。"}</div>`;
    return;
  }
  const counts = summary.counts || {};
  const countCards = Object.entries(counts).map(([regime, count]) => `
    <div class="metric-card">
      <div class="metric-label">状态 · ${regime}</div>
      <div class="metric-value">${count} 期</div>
    </div>
  `).join("");
  container.innerHTML = `
    <div class="metric-card">
      <div class="metric-label">当前状态</div>
      <div class="metric-value">${summary.latest_regime ?? "-"}</div>
    </div>
    <div class="metric-card">
      <div class="metric-label">置信度</div>
      <div class="metric-value">${summary.latest_confidence != null ? (summary.latest_confidence * 100).toFixed(1) + "%" : "-"}</div>
    </div>
    <div class="metric-card">
      <div class="metric-label">模型</div>
      <div class="metric-value">${summary.model_name ?? "-"}</div>
    </div>
    ${countCards}
  `;
}

// ============================================================
// MISC HELPERS
// ============================================================
function setProvidersStatus(text) { document.getElementById("providers-status").textContent = text; }
function setDataStatus(text) { document.getElementById("data-status").textContent = text; }
function setRegimeStatus(text) { document.getElementById("regime-status").textContent = text; }

function buildStageStatus(payload, stageName) {
  if (payload.status !== "success") {
    const error = payload.summary?.error ? ` · ${payload.summary.error}` : "";
    return `状态: ${payload.status}${error}`;
  }
  return `状态: success · ${stageName}`;
}

function translateStatus(status) {
  if (status === "success") return "成功";
  if (status === "failed") return "失败";
  return "未执行";
}
function statusClass(status) {
  if (status === "success") return "success";
  if (status === "failed") return "failed";
  return "idle";
}

function groupItems(category, group) {
  if (category.category === "资产数据" && group.group === "股票")
    return [...group.items, ...providerState.customItems];
  return group.items;
}

function customEquityControlsMarkup() {
  return `<div class="custom-equity-controls"><button id="add-custom-equity" class="secondary-button" type="button">+ 添加自定义股票</button></div>`;
}

function addCustomEquity() {
  const id = `custom_equity_${Date.now()}`;
  providerState.customItems.push({ id, label: "自定义股票", column: id.toUpperCase(), artifact: "global_prices.csv", sources: ["yahoo", "openbb"], source_field: "custom_equity_source", quote_unit: "USD", symbol: "", is_custom: true, supports_openbb: true });
  providerState.sourceSelections[id] = "yahoo";
  renderProvidersTree();
}

function bindCustomItemControls(item) {
  if (!item.is_custom) return;
  const removeButton = document.getElementById(`remove-${item.id}`);
  if (removeButton) {
    removeButton.addEventListener("click", () => {
      providerState.customItems = providerState.customItems.filter((e) => e.id !== item.id);
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

function syncCustomItemsFromSummary(groups) {
  const summaryCustomItems = groups.flatMap((g) => g.items || []).filter((item) => item.is_custom);
  const nextCustomItems = summaryCustomItems.map((item) => ({
    id: item.id, label: item.label, column: item.column, artifact: item.artifact,
    sources: item.sources || ["yahoo", "openbb"], source_field: "custom_equity_source",
    quote_unit: item.quote_unit || "USD", symbol: item.symbol || "", is_custom: true,
    supports_openbb: item.supports_openbb ?? true, selected_source: item.selected_source || (item.sources || ["yahoo"])[0],
  }));
  const changed = JSON.stringify(nextCustomItems) !== JSON.stringify(providerState.customItems);
  if (changed) {
    providerState.customItems = nextCustomItems;
    for (const item of providerState.customItems)
      providerState.sourceSelections[item.id] = item.selected_source || providerState.sourceSelections[item.id] || item.sources[0];
  }
  return changed;
}

function sourceOptionLabel(source) { return source === "openbb" ? "openbb · OpenBB" : source; }

async function openFolder(target) {
  const runId = currentRunId();
  if (!runId) { setProvidersStatus("请先创建一个实验 run。"); return; }
  try { const result = await api.openFolder(runId, target); setProvidersStatus(`已打开: ${result.path}`); }
  catch (error) { setProvidersStatus(`打开失败: ${error.message}`); }
}

async function openDataFolder() {
  const runId = currentRunId();
  if (!runId) { setDataStatus("请先创建一个实验 run。"); return; }
  try { const result = await api.openFolder(runId, "data"); setDataStatus(`已打开: ${result.path}`); }
  catch (error) { setDataStatus(`打开失败: ${error.message}`); }
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
  return String(value).toLowerCase().replace(/\s+/g, "-").replace(/[^\w\u4e00-\u9fa5-]/g, "");
}

init();

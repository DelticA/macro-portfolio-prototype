// ============================================================
// STATE
// ============================================================
const providerState = {
  tree: [],
  sourceSelections: {},
  itemNodes: {},
  customItems: [],
  searchQuery: "",
  scope: "all",
  latestGroups: [],
  latestPayload: null,
};

const dataState = {
  artifacts: {},
  charts: {}, // keyed by group id
  runId: null,
  seriesCatalog: {},
  seriesGroups: {}, // series_id -> group key
  groupLabels: {},  // group key -> label
  chartSelections: {},
  handoffSeriesIds: [],
  handoffSeriesTouched: false,
  selectionPoints: [],
  selectionRange: { startIndex: 0, endIndex: 0 },
  selectionDrag: null,
  chartSelectionDrag: null,
  latestSummary: null,
  appliedSelection: null,
};

const CUSTOM_MARKETS = {
  CN: {
    label: "A 股",
    quoteUnit: "CNY",
    artifact: "cn_assets.csv",
    sources: ["akshare"],
    source_field: "custom_equity_source",
    symbolPlaceholder: "例如 600519.SH / 000001.SZ",
    defaultLabel: "自定义 A 股",
  },
  HK: {
    label: "港股",
    quoteUnit: "HKD",
    artifact: "global_prices.csv",
    sources: ["yahoo", "openbb"],
    source_field: "custom_equity_source",
    symbolPlaceholder: "例如 0700.HK / 9988.HK",
    defaultLabel: "自定义港股",
  },
  US: {
    label: "美股",
    quoteUnit: "USD",
    artifact: "global_prices.csv",
    sources: ["yahoo", "openbb"],
    source_field: "custom_equity_source",
    symbolPlaceholder: "例如 AAPL / MSFT",
    defaultLabel: "自定义美股",
  },
};

const DATA_GROUP_ORDER = ["asset_price", "rates", "inflation", "growth", "money_supply", "trade", "credit", "fx", "other"];

const selectionBandPlugin = {
  id: "selectionBandOverlay",
  beforeDatasetsDraw(chart) {
    const selection = chart.$selectionBand || {};
    const geometry = getChartSelectionGeometry(chart, selection);
    if (!geometry) return;

    const { ctx } = chart;
    ctx.save();
    ctx.fillStyle = "rgba(20, 90, 65, 0.08)";
    ctx.strokeStyle = "rgba(20, 90, 65, 0.26)";
    ctx.lineWidth = 1.5;
    ctx.fillRect(geometry.left, geometry.chartArea.top, geometry.right - geometry.left, geometry.chartArea.bottom - geometry.chartArea.top);
    ctx.beginPath();
    ctx.moveTo(geometry.left, geometry.chartArea.top);
    ctx.lineTo(geometry.left, geometry.chartArea.bottom);
    ctx.moveTo(geometry.right, geometry.chartArea.top);
    ctx.lineTo(geometry.right, geometry.chartArea.bottom);
    ctx.stroke();
    ctx.restore();
  },
  afterDatasetsDraw(chart) {
    const geometry = getChartSelectionGeometry(chart, chart.$selectionBand || {});
    if (!geometry) return;
    const { ctx } = chart;
    const midY = (geometry.chartArea.top + geometry.chartArea.bottom) / 2;
    const handleHeight = Math.min(44, geometry.chartArea.bottom - geometry.chartArea.top - 8);
    const handleWidth = 14;

    ctx.save();
    ctx.strokeStyle = "rgba(20, 90, 65, 0.58)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(geometry.left, geometry.chartArea.top);
    ctx.lineTo(geometry.left, geometry.chartArea.bottom);
    ctx.moveTo(geometry.right, geometry.chartArea.top);
    ctx.lineTo(geometry.right, geometry.chartArea.bottom);
    ctx.stroke();

    drawSelectionHandle(ctx, geometry.left, midY, handleWidth, handleHeight);
    drawSelectionHandle(ctx, geometry.right, midY, handleWidth, handleHeight);
    ctx.restore();
  },
};

if (typeof Chart !== "undefined") {
  Chart.register(selectionBandPlugin);
}

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
  async applyDataSelection(runId, payload) {
    return handle(await fetch(`/api/runs/${runId}/data/selection`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }));
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
  document.getElementById("providers-search")?.addEventListener("input", (event) => {
    providerState.searchQuery = event.target.value.trim().toLowerCase();
    renderProvidersTree();
    if (providerState.latestGroups.length) renderProviderResults(providerState.latestGroups);
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
    if (event.target?.dataset?.addCustomMarket) addCustomEquity(event.target.dataset.addCustomMarket);
    if (event.target?.id === "apply-data-selection") applyDataSelection();
    if (event.target?.id === "use-view-series") useCurrentViewSeriesForHandoff();
    if (event.target?.id === "select-all-mappable-series") selectAllMappableSeriesForHandoff();
    if (event.target?.id === "clear-handoff-series") clearHandoffSeriesSelection();
    if (event.target?.dataset?.providerScope) {
      providerState.scope = event.target.dataset.providerScope;
      document.querySelectorAll("[data-provider-scope]").forEach((button) => button.classList.toggle("is-active", button.dataset.providerScope === providerState.scope));
      renderProvidersTree();
      if (providerState.latestGroups.length) renderProviderResults(providerState.latestGroups);
    }
    if (event.target?.dataset?.selectionPreset) {
      applySelectionPreset(event.target.dataset.selectionPreset);
    }
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
  const filteredCategories = providerState.tree
    .map((category) => ({
      ...category,
      groups: category.groups
        .map((group) => ({ ...group, filteredItems: filteredGroupItems(category, group) }))
        .filter((group) => group.filteredItems.length || (category.category === "资产数据" && group.group === "股票" && providerState.scope !== "macro")),
    }))
    .filter((category) => category.groups.length);

  if (!filteredCategories.length) {
    container.innerHTML = `<div class="hint-box">没有匹配当前检索或筛选条件的 provider 项。</div>`;
    return;
  }

  container.innerHTML = filteredCategories.map((category) => `
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
              <span class="accordion-meta">${group.filteredItems.length} 个子类目</span>
              <span class="accordion-chevron">▸</span>
            </button>
            <div class="sub-accordion-panel" id="group-${slugify(category.category)}-${slugify(group.group)}">
              ${group.filteredItems.map((item) => providerItemMarkup(item)).join("")}
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

function filteredGroupItems(category, group) {
  return groupItems(category, group).filter((item) => providerItemMatchesView(item, category, group));
}

function providerItemMatchesView(item, category, group) {
  const scope = providerState.scope;
  if (scope === "assets" && category.category !== "资产数据") return false;
  if (scope === "macro" && category.category !== "宏观经济数据") return false;
  if (scope === "custom" && !item.is_custom) return false;
  const query = providerState.searchQuery;
  if (!query) return true;
  const haystack = [
    item.label,
    item.column,
    item.symbol,
    item.market_label,
    item.artifact,
    item.quote_unit,
    category.category,
    group.group,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return haystack.includes(query);
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
  const customConfig = item.is_custom ? customMarketConfig(item.market || "US") : null;
  return `
    <div class="provider-item" id="node-${item.id}">
      <div class="provider-main">
        <div>
          <strong>${item.label}</strong>
          ${item.supports_openbb ? `<span class="source-badge">OpenBB</span>` : ""}
          ${item.market_label ? `<span class="source-badge market-badge">${item.market_label}</span>` : ""}
          <p>字段: ${item.column} · 输出文件: ${item.artifact}</p>
          <p>原始计价/单位: ${item.quote_unit || "未标注"}</p>
          ${item.symbol ? `<p>代码: ${item.symbol}</p>` : ""}
        </div>
        <div class="provider-actions">
          ${item.is_custom ? `
            <label>市场
              <select id="custom-market-${item.id}">
                ${Object.entries(CUSTOM_MARKETS).map(([marketKey, marketConfig]) => `<option value="${marketKey}" ${marketKey === (item.market || "US") ? "selected" : ""}>${marketConfig.label}</option>`).join("")}
              </select>
            </label>
            <label>股票名称<input id="custom-label-${item.id}" value="${item.label || ""}" /></label>
            <label>股票代码<input id="custom-symbol-${item.id}" value="${item.symbol || ""}" placeholder="${customConfig?.symbolPlaceholder || ""}" /></label>
          ` : ""}
          ${item.code_field ? `<label>${item.code_label}<input id="code-${item.id}" value="${item.code_value || ""}" /></label>` : ""}
          <label>来源<select id="source-${item.id}" ${item.sources.length === 1 ? "disabled" : ""}>${item.sources.map((s) => `<option value="${s}" ${s === (providerState.sourceSelections[item.id] || item.selected_source || item.sources[0]) ? "selected" : ""}>${sourceOptionLabel(s)}</option>`).join("")}</select></label>
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
  providerState.latestPayload = payload;
  providerState.latestGroups = payload.summary?.categories || [];
  syncCustomItemsFromSummary(payload.summary?.categories || []);
  renderProvidersRibbon(payload);
  renderProvidersOverview(payload);
  renderProvidersSpotlight(payload);
  renderProvidersTree();
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

function renderProvidersRibbon(payload) {
  const container = document.getElementById("providers-ribbon");
  const runId = currentRunId();
  const items = flattenProviderItems(payload.summary?.categories || []);
  const successItems = items.filter((item) => item.status === "success");
  const failedItems = items.filter((item) => item.status === "failed");
  const dateRange = providerResearchRange(successItems);
  const sourceCount = new Set(successItems.map((item) => item.selected_source).filter(Boolean)).size;
  container.innerHTML = `
    <div class="ribbon-grid">
      <div class="ribbon-card">
        <span class="ribbon-label">Current Run</span>
        <span class="ribbon-value">${runId ? `<span class="mono-chip">${runId}</span>` : "-"}</span>
        <div class="ribbon-meta">当前 provider 阶段状态 ${renderStatusChipLabel(payload.status)}</div>
      </div>
      <div class="ribbon-card">
        <span class="ribbon-label">Research Window</span>
        <span class="ribbon-value">${document.getElementById("providers-start-date")?.value || "-"} → ${document.getElementById("providers-end-date")?.value || "-"}</span>
        <div class="ribbon-meta">用于本次实验的原始拉取区间</div>
      </div>
      <div class="ribbon-card">
        <span class="ribbon-label">Coverage</span>
        <span class="ribbon-value">${dateRange.start || "-"} → ${dateRange.end || "-"}</span>
        <div class="ribbon-meta">成功拉取项 ${successItems.length}/${items.length || 0} · 失败 ${failedItems.length}</div>
      </div>
      <div class="ribbon-card">
        <span class="ribbon-label">Source Mix</span>
        <span class="ribbon-value">${sourceCount || 0} 个来源</span>
        <div class="ribbon-meta">${providerSourceSummary(successItems) || "尚无成功拉取项"}</div>
      </div>
    </div>
  `;
}

function renderProvidersOverview(payload) {
  const container = document.getElementById("providers-overview");
  const items = flattenProviderItems(payload.summary?.categories || []);
  if (!items.length) {
    container.innerHTML = `<div class="hint-box">这里会显示 provider 成功率、覆盖范围和来源分布。</div>`;
    return;
  }
  const success = items.filter((item) => item.status === "success");
  const failed = items.filter((item) => item.status === "failed");
  const notRun = items.filter((item) => item.status === "not_run");
  const totalRows = success.reduce((sum, item) => sum + (item.rows || 0), 0);
  const avgNonNull = success.length ? Math.round(success.reduce((sum, item) => sum + (item.non_null || 0), 0) / success.length) : 0;
  const cards = [
    ["成功率", items.length ? `${Math.round((success.length / items.length) * 100)}%` : "-"],
    ["失败项", failed.length],
    ["待执行", notRun.length],
    ["总行数", formatCompactNumber(totalRows)],
    ["均值非空", avgNonNull],
    ["筛选结果", filteredProviderCountLabel()],
  ];
  container.innerHTML = cards.map(([label, value]) => `
    <div class="metric-card">
      <div class="metric-label">${label}</div>
      <div class="metric-value">${value}</div>
    </div>
  `).join("");
}

function renderProvidersSpotlight(payload) {
  const container = document.getElementById("providers-spotlight");
  const items = flattenProviderItems(payload.summary?.categories || []);
  if (!items.length) {
    container.innerHTML = `<div class="hint-box">这里会显示最新更新项、失败项和研究提示。</div>`;
    return;
  }
  const failed = items.filter((item) => item.status === "failed");
  const recent = [...items]
    .filter((item) => item.last_updated)
    .sort((a, b) => String(b.last_updated).localeCompare(String(a.last_updated)))
    .slice(0, 5);
  const spotlightItems = failed.length ? failed.slice(0, 4) : recent;
  const headline = failed.length ? "需要关注的失败项" : "最近更新的序列";
  const note = failed.length
    ? "先处理失败项，再看 log 细节；失败来源通常是代码、权限或区间不兼容。"
    : "优先核对最近更新的关键序列，确认频率与研究假设一致。";
  container.innerHTML = `
    <div class="spotlight-section">
      <div class="group-head">
        <div><p class="eyebrow">Desk View</p><h3>${headline}</h3></div>
        ${renderStatusChip(payload.status)}
      </div>
      <div class="spotlight-list">
        ${spotlightItems.map((item) => `
          <div class="spotlight-row">
            <div>
              <strong>${item.label}</strong>
              <p>${item.column} · ${item.artifact} · ${item.frequency || "未知"}</p>
            </div>
            <div class="spotlight-meta">
              ${renderStatusChip(item.status)}
              <span>${item.start && item.end ? `${shortDate(item.start)} → ${shortDate(item.end)}` : "无覆盖区间"}</span>
            </div>
          </div>
        `).join("")}
      </div>
      <div class="workspace-note" style="margin-top:12px"><strong>研究提示</strong><br />${note}</div>
    </div>
  `;
}

function flattenProviderItems(groups) {
  return groups.flatMap((group) => group.items || []);
}

function providerResearchRange(items) {
  const starts = items.map((item) => item.start).filter(Boolean).sort();
  const ends = items.map((item) => item.end).filter(Boolean).sort();
  return { start: starts[0] ? shortDate(starts[0]) : null, end: ends.length ? shortDate(ends[ends.length - 1]) : null };
}

function providerSourceSummary(items) {
  const counts = {};
  for (const item of items) {
    const key = item.selected_source || item.source || "unknown";
    counts[key] = (counts[key] || 0) + 1;
  }
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([source, count]) => `${source} ${count}`)
    .join(" · ");
}

function filteredProviderCountLabel() {
  const total = providerState.tree.flatMap((category) => category.groups.flatMap((group) => filteredGroupItems(category, group))).length;
  return `${total} 项`;
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
    dataState.seriesCatalog = {};
    dataState.seriesGroups = {};
    dataState.chartSelections = {};
    dataState.handoffSeriesIds = [];
    dataState.handoffSeriesTouched = false;
    dataState.appliedSelection = null;
    destroyAllCharts();
  }
  const payload = await api.getStage(runId, "data");
  dataState.latestSummary = payload.summary || {};
  if (payload.status === "success") {
    const summary = payload.summary || {};
    dataState.seriesCatalog = summary.series_catalog || {};
    dataState.seriesGroups = summary.series_groups || {};
    dataState.groupLabels = summary.timeline?.group_labels || {};
    ensureHandoffSeriesSelection(summary);
  } else {
    dataState.seriesCatalog = {};
    dataState.seriesGroups = {};
  }
  setDataStatus(buildStageStatus(payload, "data"));
  document.getElementById("data-log").textContent = payload.log || "";
  renderDataRibbon(payload.summary || {});
  renderDataSummary(payload.summary || {});
  renderDataRanges(payload.summary || {});
  renderDataSelection(payload.summary || {});
  renderDataSnapshot(payload.summary || {});
  renderDataSelectionNotes(payload.summary || {});

  if (payload.status === "success") {
    const summary = payload.summary || {};
    renderTimelineTable(summary.timeline || {});
    await loadDataArtifacts(runId);
    renderGroupCharts();
    refreshSelectionHighlights();
    refreshHandoffSelectionSummary();
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

function renderDataRibbon(summary) {
  const container = document.getElementById("data-ribbon");
  const selection = resolveDataSelectionSummary(summary);
  const available = selection.available;
  const applied = selection.applied;
  const current = currentEditorSelection(selection);
  const editorSeriesIds = currentEditorSeriesIds(selection);
  const appliedSeriesIds = selection.appliedDisplaySeriesIds || [];
  const defaultSeriesCount = defaultHandoffSeriesIds().length;
  const cards = [
    {
      label: "Processed Intersection",
      value: `${shortDate(summary.intersections?.processed?.start)} → ${shortDate(summary.intersections?.processed?.end)}`,
      meta: `原始交集 ${shortDate(summary.intersections?.raw?.start)} → ${shortDate(summary.intersections?.raw?.end)}`,
    },
    {
      label: "Editor Window",
      value: `${shortDate(current.start)} → ${shortDate(current.end)}`,
      meta: selectionIsDirty(current, applied, editorSeriesIds, appliedSeriesIds) ? "当前为未应用草稿窗口" : "当前编辑窗口已与已应用窗口同步",
    },
    {
      label: "Applied Window",
      value: applied.start ? `${shortDate(applied.start)} → ${shortDate(applied.end)}` : "全量处理后数据",
      meta: applied.start ? `第三部分当前读取 ${appliedSeriesIds.length || defaultSeriesCount} 个条目` : `尚未单独保存 handoff 窗口，默认读取 ${defaultSeriesCount} 个可建模条目`,
    },
    {
      label: "Handoff Universe",
      value: `${editorSeriesIds.length} 条`,
      meta: `${editorSeriesIds.filter((id) => dataState.seriesCatalog[id]?.mappable_to_regime).length} 条可建模 · ${(summary.asset_names || []).length} 个核心资产`,
    },
  ];
  container.innerHTML = `<div class="ribbon-grid">${cards.map((card) => `
    <div class="ribbon-card">
      <span class="ribbon-label">${card.label}</span>
      <span class="ribbon-value">${card.value}</span>
      <div class="ribbon-meta">${card.meta}</div>
    </div>
  `).join("")}</div>`;
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

function renderDataSnapshot(summary) {
  const container = document.getElementById("data-snapshot");
  if (!summary || !Object.keys(summary).length) {
    container.innerHTML = `<div class="hint-box">这里会显示处理后的关键摘要。</div>`;
    return;
  }
  const processed = summary.processed_datasets || {};
  const cards = [
    ["特征矩阵", `${summary.feature_rows ?? "-"} 行`],
    ["资产面板", `${summary.asset_panel_rows ?? "-"} 行`],
    ["收益矩阵", `${processed.asset_returns?.rows ?? "-"} 行`],
    ["缺失率", processed.features?.missing_ratio != null ? `${(processed.features.missing_ratio * 100).toFixed(1)}%` : "-"],
  ];
  container.innerHTML = cards.map(([label, value]) => `
    <div class="metric-card">
      <div class="metric-label">${label}</div>
      <div class="metric-value">${value}</div>
    </div>
  `).join("");
}

function renderDataSelectionNotes(summary) {
  const container = document.getElementById("data-selection-notes");
  const selection = resolveDataSelectionSummary(summary);
  const editor = currentEditorSelection(selection);
  const applied = selection.applied;
  const editorSeriesIds = currentEditorSeriesIds(selection);
  const appliedSeriesIds = selection.appliedDisplaySeriesIds || [];
  const notes = [
    {
      title: "编辑窗口",
      body: `${shortDate(editor.start)} → ${shortDate(editor.end)}`,
      meta: selectionIsDirty(editor, applied, editorSeriesIds, appliedSeriesIds) ? "尚未应用到第三部分" : "已与下游保持同步",
    },
    {
      title: "已应用窗口",
      body: applied.start ? `${shortDate(applied.start)} → ${shortDate(applied.end)}` : "尚未单独保存",
      meta: applied.start ? "当前 regime / policy / backtest 将优先读取这段区间" : "下游仍读取全量处理后数据",
    },
    {
      title: "条目集合",
      body: `${editorSeriesIds.length} 条已选 · ${editorSeriesIds.filter((id) => dataState.seriesCatalog[id]?.mappable_to_regime).length} 条可建模`,
      meta: appliedSeriesIds.length
        ? `已应用 ${appliedSeriesIds.length} 条 · 缺失率 ${selection.coverage?.raw_missing_ratio != null ? (selection.coverage.raw_missing_ratio * 100).toFixed(1) + "%" : "-"}`
        : `未应用时默认使用 ${defaultHandoffSeriesIds().length} 条可建模序列`,
    },
  ];
  container.innerHTML = `
    <div class="spotlight-section">
      <div class="group-head"><div><p class="eyebrow">Research Handoff</p><h3>窗口状态</h3></div></div>
      <div class="spotlight-list">
        ${notes.map((note) => `
          <div class="spotlight-row">
            <div>
              <strong>${note.title}</strong>
              <p>${note.body}</p>
            </div>
            <div class="spotlight-meta"><span>${note.meta}</span></div>
          </div>
        `).join("")}
      </div>
      <div class="workspace-note" style="margin-top:12px"><strong>快捷建议</strong><br />先在图表中框定研究窗口，再点击“应用到第三部分”，这样后续状态识别和策略结果会更可追溯。</div>
    </div>
  `;
}

function renderDataSelection(summary) {
  const container = document.getElementById("data-selection-panel");
  const selection = resolveDataSelectionSummary(summary);
  const available = selection.available;
  const applied = selection.applied;
  dataState.appliedSelection = applied.start ? { ...applied } : null;
  if (!available.start || !available.end) {
    container.innerHTML = `<div class="hint-box">处理完成后，这里会显示可供第三部分使用的时间区间。</div>`;
    return;
  }
  const editorWindow = currentEditorSelection(selection);
  const activeStart = editorWindow.start || applied.start || available.start;
  const activeEnd = editorWindow.end || applied.end || available.end;
  const selectedRows = selection.selectedRows;
  const editorSeriesIds = currentEditorSeriesIds(selection);
  const currentViewSeriesIds = currentChartSeriesSelection();
  const editorModelableCount = editorSeriesIds.filter((id) => dataState.seriesCatalog[id]?.mappable_to_regime).length;
  const editorDisplayOnlyCount = editorSeriesIds.length - editorModelableCount;
  const selectionPoints = buildSelectionPoints(available.start, available.end);
  dataState.selectionPoints = selectionPoints;
  const startIndex = selectionPointIndex(activeStart, selectionPoints);
  const endIndex = selectionPointIndex(activeEnd, selectionPoints);
  dataState.selectionRange = { startIndex, endIndex };
  const overview = buildSelectionOverview(summary.timeline || {}, selectionPoints);
  const seriesGroupsMarkup = DATA_GROUP_ORDER
    .map((groupKey) => {
      const seriesItems = getGroupSeries(groupKey);
      if (!seriesItems.length) return "";
      return `
        <section class="series-picker-section">
          <div class="series-picker-head">
            <div>
              <strong>${dataState.groupLabels[groupKey] || groupKey}</strong>
              <span>${seriesItems.length} 条</span>
            </div>
          </div>
          <div class="series-picker-grid">
            ${seriesItems.map((item) => {
              const checked = editorSeriesIds.includes(item.id);
              return `
                <label class="series-picker-pill ${checked ? "is-selected" : ""} ${item.mappable_to_regime ? "" : "is-display-only"}">
                  <input type="checkbox" class="handoff-series-toggle" value="${item.id}" ${checked ? "checked" : ""} />
                  <span class="series-picker-main">
                    <strong>${item.label}</strong>
                    <span>${item.short_label || item.column}${item.market_label ? ` · ${item.market_label}` : ""}${item.quote_unit ? ` · ${item.quote_unit}` : ""}</span>
                  </span>
                  <span class="series-picker-badge ${item.mappable_to_regime ? "is-modelable" : "is-display-only"}">${item.mappable_to_regime ? "可建模" : "仅浏览"}</span>
                </label>
              `;
            }).join("")}
          </div>
        </section>
      `;
    })
    .join("");
  container.innerHTML = `
    <div class="spotlight-section">
      <div class="group-head"><div><p class="eyebrow">Handoff Window</p><h3>给第三部分的数据区间</h3></div></div>
      <div class="intersection-card">
        <div class="intersection-label">可选范围</div>
        <div class="intersection-value">${shortDate(available.start)} ~ ${shortDate(available.end)}</div>
      </div>
      <div class="intersection-card" style="margin-top:10px">
        <div class="intersection-label">当前生效范围</div>
        <div class="intersection-value">${shortDate(activeStart)} ~ ${shortDate(activeEnd)}</div>
      </div>
      <div class="selection-slider-card">
        <div class="selection-slider-head">
          <strong>图形化时间范围选择</strong>
          <span>${selectionIsDirty({ start: activeStart, end: activeEnd }, applied, editorSeriesIds, selection.appliedDisplaySeriesIds) ? "存在未应用草稿窗口" : "当前窗口已应用到下游阶段"}</span>
        </div>
        <div id="data-selection-brush" class="selection-brush">
          <svg class="selection-overview-chart" viewBox="0 0 1000 120" preserveAspectRatio="none" aria-hidden="true">
            <defs>
              <linearGradient id="selection-overview-fill" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stop-color="rgba(20,90,65,0.34)"></stop>
                <stop offset="100%" stop-color="rgba(20,90,65,0.04)"></stop>
              </linearGradient>
            </defs>
            <path d="${overview.areaPath}" fill="url(#selection-overview-fill)"></path>
            <path d="${overview.linePath}" class="selection-overview-line"></path>
          </svg>
          <div id="data-selection-window" class="selection-window">
            <button id="data-selection-handle-start" class="selection-handle selection-handle-start" type="button" aria-label="拖动开始时间"></button>
            <div class="selection-window-fill"></div>
            <button id="data-selection-handle-end" class="selection-handle selection-handle-end" type="button" aria-label="拖动结束时间"></button>
          </div>
        </div>
        <div class="selection-slider-labels">
          <span>${shortDate(selectionPoints[0])}</span>
          <span id="data-selection-slider-current">${shortDate(activeStart)} ~ ${shortDate(activeEnd)}</span>
          <span>${shortDate(selectionPoints[selectionPoints.length - 1])}</span>
        </div>
        <div class="preset-row">
          <button type="button" class="secondary-button preset-button" data-selection-preset="full">全量交集</button>
          <button type="button" class="secondary-button preset-button" data-selection-preset="3y">近 3 年</button>
          <button type="button" class="secondary-button preset-button" data-selection-preset="5y">近 5 年</button>
          <button type="button" class="secondary-button preset-button" data-selection-preset="10y">近 10 年</button>
        </div>
      </div>
      <div class="form-grid" style="margin-top:12px">
        <label>开始日期<input id="data-selection-start" type="date" value="${toDateInputValue(activeStart)}" min="${toDateInputValue(available.start)}" max="${toDateInputValue(available.end)}" /></label>
        <label>结束日期<input id="data-selection-end" type="date" value="${toDateInputValue(activeEnd)}" min="${toDateInputValue(available.start)}" max="${toDateInputValue(available.end)}" /></label>
      </div>
      <div class="selection-universe-card">
        <div class="selection-universe-head">
          <div>
            <strong>交给第三部分的数据类</strong>
            <span>可以手动勾选，也可以直接读取当前图表里勾选展示的条目。</span>
          </div>
          <div class="selection-universe-stats">
            <span class="mono-chip" id="data-selection-picked-count">已选 ${editorSeriesIds.length}</span>
            <span class="mono-chip" id="data-selection-modelable-count">可建模 ${editorModelableCount}</span>
            <span class="mono-chip" id="data-selection-view-count">当前图表勾选 ${currentViewSeriesIds.length}</span>
            <span class="mono-chip" id="data-selection-missing-rate">缺失率 -</span>
          </div>
        </div>
        <div class="selection-action-row">
          <button id="use-view-series" class="secondary-button" type="button">使用当前图表勾选条目</button>
          <button id="select-all-mappable-series" class="secondary-button" type="button">全选可建模条目</button>
          <button id="clear-handoff-series" class="ghost-button" type="button">清空当前条目</button>
        </div>
        <div id="data-selection-handoff-note" class="workspace-note" style="margin-top:12px">
          ${editorDisplayOnlyCount ? `当前已选中 ${editorDisplayOnlyCount} 条仅浏览序列；这些条目会记录在 handoff 元数据里，但不会进入第三部分建模。` : "当前已选条目都会成为第三部分读取的筛选后特征输入。"}
        </div>
        <div class="series-picker-layout">${seriesGroupsMarkup || `<div class="hint-box">当前没有可选数据条目。</div>`}</div>
      </div>
      <div class="folder-actions" style="margin-top:12px">
        <button id="apply-data-selection" class="secondary-button">应用到第三部分</button>
      </div>
      <div class="hint-box" style="margin-top:12px">
        <strong>说明</strong>
        <div>第三部分会优先读取这里应用后的区间；未应用时默认读取全部处理后数据。</div>
        ${applied.start ? `<div>当前筛选后行数: features ${selectedRows.features ?? "-"} · asset_returns ${selectedRows.asset_returns ?? "-"} · asset_panel ${selectedRows.asset_panel ?? "-"}</div>` : `<div>当前仍在使用完整处理后数据。</div>`}
      </div>
    </div>
  `;
  bindDataSelectionControls();
  syncDataSelectionBrush();
  refreshHandoffSelectionSummary();
}

async function applyDataSelection() {
  const runId = currentRunId();
  if (!runId) { setDataStatus("请先创建或选择一个实验 run。"); return; }
  const start = document.getElementById("data-selection-start")?.value;
  const end = document.getElementById("data-selection-end")?.value;
  if (!start || !end) { setDataStatus("请选择完整的起止日期。"); return; }
  const editorSeriesIds = currentEditorSeriesIds();
  if (!editorSeriesIds.length) { setDataStatus("请至少选择一个要交给第三部分的数据条目。"); return; }
  setDataStatus(`运行中: 选定区间 ${start} -> ${end}`);
  try {
    await api.applyDataSelection(runId, { start_date: start, end_date: end, display_series_ids: editorSeriesIds });
    dataState.handoffSeriesTouched = false;
    await renderData(runId);
  } catch (error) {
    setDataStatus(`失败: ${error.message}`);
  }
}

function bindDataSelectionControls() {
  const startInput = document.getElementById("data-selection-start");
  const endInput = document.getElementById("data-selection-end");
  const brush = document.getElementById("data-selection-brush");
  const startHandle = document.getElementById("data-selection-handle-start");
  const endHandle = document.getElementById("data-selection-handle-end");
  const windowEl = document.getElementById("data-selection-window");
  if (!startInput || !endInput || !brush || !startHandle || !endHandle || !windowEl) return;

  const syncFromDates = (changedField) => {
    let startIndex = selectionPointIndex(startInput.value, dataState.selectionPoints);
    let endIndex = selectionPointIndex(endInput.value, dataState.selectionPoints);
    if (startIndex > endIndex) {
      if (changedField === "start") endIndex = startIndex;
      else startIndex = endIndex;
    }
    applySelectionIndices(startIndex, endIndex);
  };

  startInput.addEventListener("change", () => syncFromDates("start"));
  endInput.addEventListener("change", () => syncFromDates("end"));

  startHandle.addEventListener("pointerdown", (event) => startSelectionDrag(event, "start"));
  endHandle.addEventListener("pointerdown", (event) => startSelectionDrag(event, "end"));
  windowEl.addEventListener("pointerdown", (event) => {
    if (event.target === startHandle || event.target === endHandle) return;
    startSelectionDrag(event, "window");
  });
  brush.addEventListener("pointerdown", (event) => {
    if (event.target.closest(".selection-window")) return;
    const index = selectionIndexFromClientX(event.clientX);
    const { startIndex, endIndex } = dataState.selectionRange;
    const next = Math.abs(index - startIndex) <= Math.abs(index - endIndex)
      ? { startIndex: Math.min(index, endIndex), endIndex: Math.max(index, endIndex) }
      : { startIndex: Math.min(startIndex, index), endIndex: Math.max(startIndex, index) };
    applySelectionIndices(next.startIndex, next.endIndex);
  });

  document.querySelectorAll(".handoff-series-toggle").forEach((node) => {
    node.addEventListener("change", () => {
      dataState.handoffSeriesIds = Array.from(document.querySelectorAll(".handoff-series-toggle:checked")).map((checkbox) => checkbox.value);
      dataState.handoffSeriesTouched = true;
      document.querySelectorAll(".series-picker-pill").forEach((pill) => {
        const checkbox = pill.querySelector(".handoff-series-toggle");
        pill.classList.toggle("is-selected", Boolean(checkbox?.checked));
      });
      renderDataRibbon(dataState.latestSummary || {});
      renderDataSelectionNotes(dataState.latestSummary || {});
      refreshHandoffSelectionSummary();
    });
  });
}

function applySelectionIndices(startIndex, endIndex) {
  const points = dataState.selectionPoints;
  if (!points.length) return;
  dataState.selectionRange = {
    startIndex: clamp(startIndex, 0, points.length - 1),
    endIndex: clamp(endIndex, 0, points.length - 1),
  };
  if (dataState.selectionRange.startIndex > dataState.selectionRange.endIndex) {
    dataState.selectionRange.endIndex = dataState.selectionRange.startIndex;
  }
  const startInput = document.getElementById("data-selection-start");
  const endInput = document.getElementById("data-selection-end");
  if (startInput) startInput.value = toDateInputValue(points[dataState.selectionRange.startIndex]);
  if (endInput) endInput.value = toDateInputValue(points[dataState.selectionRange.endIndex]);
  syncDataSelectionBrush();
  renderDataRibbon(dataState.latestSummary || {});
  renderDataSelectionNotes(dataState.latestSummary || {});
  refreshHandoffSelectionSummary();
  refreshSelectionHighlights();
}

function syncDataSelectionBrush() {
  const brush = document.getElementById("data-selection-brush");
  const windowEl = document.getElementById("data-selection-window");
  const current = document.getElementById("data-selection-slider-current");
  if (!brush || !windowEl || !current) return;
  const maxIndex = Math.max(dataState.selectionPoints.length - 1, 1);
  const startPct = (dataState.selectionRange.startIndex / maxIndex) * 100;
  const endPct = (dataState.selectionRange.endIndex / maxIndex) * 100;
  windowEl.style.left = `${startPct}%`;
  windowEl.style.width = `${Math.max(endPct - startPct, 2)}%`;
  current.textContent = `${document.getElementById("data-selection-start")?.value || "-"} ~ ${document.getElementById("data-selection-end")?.value || "-"}`;
}

function startSelectionDrag(event, mode) {
  event.preventDefault();
  dataState.selectionDrag = {
    mode,
    anchorX: event.clientX,
    startIndex: dataState.selectionRange.startIndex,
    endIndex: dataState.selectionRange.endIndex,
  };
  window.addEventListener("pointermove", handleSelectionDrag);
  window.addEventListener("pointerup", stopSelectionDrag, { once: true });
}

function handleSelectionDrag(event) {
  if (!dataState.selectionDrag) return;
  const brush = document.getElementById("data-selection-brush");
  if (!brush || dataState.selectionPoints.length <= 1) return;
  const startIndexFromPointer = selectionIndexFromClientX(dataState.selectionDrag.anchorX);
  const currentIndex = selectionIndexFromClientX(event.clientX);
  const deltaSteps = currentIndex - startIndexFromPointer;
  const maxIndex = dataState.selectionPoints.length - 1;

  if (dataState.selectionDrag.mode === "start") {
    applySelectionIndices(
      clamp(dataState.selectionDrag.startIndex + deltaSteps, 0, dataState.selectionDrag.endIndex),
      dataState.selectionDrag.endIndex,
    );
    return;
  }
  if (dataState.selectionDrag.mode === "end") {
    applySelectionIndices(
      dataState.selectionDrag.startIndex,
      clamp(dataState.selectionDrag.endIndex + deltaSteps, dataState.selectionDrag.startIndex, maxIndex),
    );
    return;
  }
  const width = dataState.selectionDrag.endIndex - dataState.selectionDrag.startIndex;
  const nextStart = clamp(dataState.selectionDrag.startIndex + deltaSteps, 0, maxIndex - width);
  applySelectionIndices(nextStart, nextStart + width);
}

function stopSelectionDrag() {
  dataState.selectionDrag = null;
  window.removeEventListener("pointermove", handleSelectionDrag);
}

function selectionIndexFromClientX(clientX) {
  const brush = document.getElementById("data-selection-brush");
  if (!brush || dataState.selectionPoints.length <= 1) return 0;
  const rect = brush.getBoundingClientRect();
  const ratio = clamp((clientX - rect.left) / rect.width, 0, 1);
  return Math.round(ratio * (dataState.selectionPoints.length - 1));
}

function currentSelectionDates() {
  const start = document.getElementById("data-selection-start")?.value || toDateInputValue(dataState.selectionPoints[dataState.selectionRange.startIndex]);
  const end = document.getElementById("data-selection-end")?.value || toDateInputValue(dataState.selectionPoints[dataState.selectionRange.endIndex]);
  return { start, end };
}

function currentEditorSelection(selection = resolveDataSelectionSummary(dataState.latestSummary || {})) {
  const startInput = document.getElementById("data-selection-start");
  const endInput = document.getElementById("data-selection-end");
  return {
    start: startInput?.value || selection.applied.start || selection.available.start || null,
    end: endInput?.value || selection.applied.end || selection.available.end || null,
  };
}

function selectionIsDirty(
  editor = currentEditorSelection(),
  applied = dataState.appliedSelection || {},
  editorSeriesIds = currentEditorSeriesIds(),
  appliedSeriesIds = resolveDataSelectionSummary(dataState.latestSummary || {}).appliedDisplaySeriesIds || [],
) {
  const baselineStart = applied.start || dataState.latestSummary?.selection?.available_range?.start || dataState.latestSummary?.intersections?.processed?.start || null;
  const baselineEnd = applied.end || dataState.latestSummary?.selection?.available_range?.end || dataState.latestSummary?.intersections?.processed?.end || null;
  const baselineSeriesIds = appliedSeriesIds.length ? appliedSeriesIds : defaultHandoffSeriesIds();
  return (
    shortDate(editor.start) !== shortDate(baselineStart)
    || shortDate(editor.end) !== shortDate(baselineEnd)
    || !seriesSelectionEquals(editorSeriesIds, baselineSeriesIds)
  );
}

function applySelectionPreset(preset) {
  if (!dataState.selectionPoints.length) return;
  const endIndex = dataState.selectionPoints.length - 1;
  let startIndex = 0;
  if (preset === "3y") startIndex = Math.max(0, endIndex - 36);
  else if (preset === "5y") startIndex = Math.max(0, endIndex - 60);
  else if (preset === "10y") startIndex = Math.max(0, endIndex - 120);
  applySelectionIndices(startIndex, endIndex);
}

function refreshHandoffSelectionSummary() {
  const editorSeriesIds = currentEditorSeriesIds();
  const modelableCount = editorSeriesIds.filter((id) => dataState.seriesCatalog[id]?.mappable_to_regime).length;
  const currentViewCount = currentChartSeriesSelection().length;
  const displayOnlyCount = editorSeriesIds.length - modelableCount;
  const { missingRatio, observedCells, totalCells } = selectionCoverageStats(editorSeriesIds);
  const picked = document.getElementById("data-selection-picked-count");
  const modelable = document.getElementById("data-selection-modelable-count");
  const currentView = document.getElementById("data-selection-view-count");
  const missingRate = document.getElementById("data-selection-missing-rate");
  const note = document.getElementById("data-selection-handoff-note");
  if (picked) picked.textContent = `已选 ${editorSeriesIds.length}`;
  if (modelable) modelable.textContent = `可建模 ${modelableCount}`;
  if (currentView) currentView.textContent = `当前图表勾选 ${currentViewCount}`;
  if (missingRate) {
    missingRate.textContent = missingRatio == null ? "缺失率 -" : `缺失率 ${(missingRatio * 100).toFixed(1)}%`;
  }
  if (note) {
    const coverageText = missingRatio == null
      ? "等待载入选中条目的时间覆盖情况。"
      : `当前窗口内观测到 ${observedCells}/${totalCells} 个数据点，整体缺失率 ${(missingRatio * 100).toFixed(1)}%。`;
    note.innerHTML = displayOnlyCount
      ? `${coverageText}<br />当前已选中 ${displayOnlyCount} 条仅浏览序列；这些条目会记录在 handoff 元数据里，但不会进入第三部分建模。`
      : `${coverageText}<br />当前已选条目都会成为第三部分读取的筛选后特征输入。`;
  }
}

function refreshSelectionHighlights() {
  refreshTimelineSelection();
  refreshGroupChartSelection();
}

function refreshTimelineSelection() {
  const { start, end } = currentSelectionDates();
  if (!start || !end) return;
  const startMonth = start.slice(0, 7);
  const endMonth = end.slice(0, 7);
  document.querySelectorAll("[data-band-kind][data-band-key]").forEach((cell) => {
    const kind = cell.dataset.bandKind;
    const key = cell.dataset.bandKey;
    const selected = kind === "quarter" ? quarterIntersectsSelection(key, startMonth, endMonth) : monthWithinSelection(key, startMonth, endMonth);
    cell.classList.toggle("is-selected-window", selected);
  });
}

function refreshGroupChartSelection() {
  const { start, end } = currentSelectionDates();
  if (!start || !end) return;
  for (const [groupKey, chart] of Object.entries(dataState.charts)) {
    if (!chart) continue;
    chart.$selectionBand = { start, end };
    chart.update("none");
    const chip = document.getElementById(`chart-window-${groupKey}`);
    if (chip) chip.textContent = `研究窗口 · ${shortDate(start)} → ${shortDate(end)}`;
  }
}

function monthWithinSelection(month, startMonth, endMonth) {
  return month >= startMonth && month <= endMonth;
}

function quarterIntersectsSelection(quarter, startMonth, endMonth) {
  const [yearRaw, quarterRaw] = quarter.split("-Q");
  const year = Number(yearRaw);
  const q = Number(quarterRaw);
  const quarterStart = `${year}-${String((q - 1) * 3 + 1).padStart(2, "0")}`;
  const quarterEnd = `${year}-${String(q * 3).padStart(2, "0")}`;
  return !(quarterEnd < startMonth || quarterStart > endMonth);
}

function getChartSelectionGeometry(chart, selection = chart?.$selectionBand || {}) {
  if (!selection.start || !selection.end) return null;
  const labels = chart.data?.labels || [];
  const xScale = chart.scales?.x;
  const chartArea = chart.chartArea;
  if (!labels.length || !xScale || !chartArea) return null;

  const startMonth = selection.start.slice(0, 7);
  const endMonth = selection.end.slice(0, 7);
  let startIndex = labels.findIndex((label) => String(label) >= startMonth);
  let endIndex = -1;
  for (let i = labels.length - 1; i >= 0; i--) {
    if (String(labels[i]) <= endMonth) {
      endIndex = i;
      break;
    }
  }
  if (startIndex < 0) startIndex = 0;
  if (endIndex < 0 || startIndex > endIndex) return null;

  const step = labels.length > 1 ? Math.abs(xScale.getPixelForValue(1) - xScale.getPixelForValue(0)) : chartArea.right - chartArea.left;
  const left = Math.max(chartArea.left, xScale.getPixelForValue(startIndex) - step / 2);
  const right = Math.min(chartArea.right, xScale.getPixelForValue(endIndex) + step / 2);
  if (!(right > left)) return null;
  return { labels, chartArea, startIndex, endIndex, step, left, right };
}

function drawSelectionHandle(ctx, x, centerY, width, height) {
  const left = x - width / 2;
  const top = centerY - height / 2;
  const radius = Math.min(width / 2, 7);
  ctx.save();
  ctx.fillStyle = "rgba(255,255,255,0.98)";
  ctx.strokeStyle = "rgba(20, 90, 65, 0.72)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(left, top, width, height, radius);
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.strokeStyle = "rgba(20, 90, 65, 0.52)";
  ctx.lineWidth = 1.4;
  for (let offset = -6; offset <= 6; offset += 6) {
    ctx.moveTo(x - 2.5, centerY + offset);
    ctx.lineTo(x + 2.5, centerY + offset);
  }
  ctx.stroke();
  ctx.restore();
}

function bindChartSelectionControls(groupKey, chart) {
  const canvas = chart.canvas;
  if (!canvas) return;
  canvas.onpointerdown = (event) => startChartSelectionDrag(event, groupKey, chart);
  canvas.onpointermove = (event) => updateChartSelectionCursor(chart, event.clientX);
  canvas.onpointerleave = () => {
    if (!dataState.chartSelectionDrag) canvas.style.cursor = "default";
  };
}

function startChartSelectionDrag(event, groupKey, chart) {
  const labels = chart.data?.labels || [];
  if (!labels.length) return;
  const pointIndex = chartLabelIndexFromClientX(chart, event.clientX);
  if (pointIndex == null) return;
  const selectionIndex = selectionIndexFromMonthLabel(labels[pointIndex]);
  const mode = chartSelectionModeFromClientX(chart, event.clientX);
  const current = dataState.selectionRange;

  event.preventDefault();
  chart.canvas.style.cursor = mode === "window" ? "grabbing" : "ew-resize";
  dataState.chartSelectionDrag = {
    groupKey,
    chart,
    mode,
    anchorPointIndex: pointIndex,
    anchorSelectionIndex: selectionIndex,
    startIndex: current.startIndex,
    endIndex: current.endIndex,
  };
  if (mode === "brush") {
    applySelectionIndices(selectionIndex, selectionIndex);
  }
  window.addEventListener("pointermove", handleChartSelectionDrag);
  window.addEventListener("pointerup", stopChartSelectionDrag, { once: true });
}

function handleChartSelectionDrag(event) {
  const drag = dataState.chartSelectionDrag;
  if (!drag) return;
  const labels = drag.chart.data?.labels || [];
  if (!labels.length) return;
  const pointIndex = chartLabelIndexFromClientX(drag.chart, event.clientX);
  if (pointIndex == null) return;
  const selectionIndex = selectionIndexFromMonthLabel(labels[pointIndex]);
  const maxIndex = dataState.selectionPoints.length - 1;

  if (drag.mode === "start") {
    applySelectionIndices(clamp(selectionIndex, 0, drag.endIndex), drag.endIndex);
    return;
  }
  if (drag.mode === "end") {
    applySelectionIndices(drag.startIndex, clamp(selectionIndex, drag.startIndex, maxIndex));
    return;
  }
  if (drag.mode === "window") {
    const width = drag.endIndex - drag.startIndex;
    const delta = selectionIndex - drag.anchorSelectionIndex;
    const nextStart = clamp(drag.startIndex + delta, 0, maxIndex - width);
    applySelectionIndices(nextStart, nextStart + width);
    return;
  }
  applySelectionIndices(
    Math.min(drag.anchorSelectionIndex, selectionIndex),
    Math.max(drag.anchorSelectionIndex, selectionIndex),
  );
}

function stopChartSelectionDrag() {
  if (dataState.chartSelectionDrag?.chart?.canvas) {
    dataState.chartSelectionDrag.chart.canvas.style.cursor = "default";
  }
  dataState.chartSelectionDrag = null;
  window.removeEventListener("pointermove", handleChartSelectionDrag);
}

function chartSelectionModeFromClientX(chart, clientX) {
  const geometry = getChartSelectionGeometry(chart, chart.$selectionBand || {});
  const rect = chart.canvas.getBoundingClientRect();
  const x = clientX - rect.left;
  if (!geometry) return "brush";
  const handleTolerance = clamp(geometry.step * 0.45, 10, 20);
  if (Math.abs(x - geometry.left) <= handleTolerance) return "start";
  if (Math.abs(x - geometry.right) <= handleTolerance) return "end";
  if (x > geometry.left && x < geometry.right) return "window";
  return "brush";
}

function updateChartSelectionCursor(chart, clientX) {
  if (dataState.chartSelectionDrag) return;
  const mode = chartSelectionModeFromClientX(chart, clientX);
  chart.canvas.style.cursor = mode === "window" ? "grab" : mode === "brush" ? "crosshair" : "ew-resize";
}

function chartLabelIndexFromClientX(chart, clientX) {
  const xScale = chart.scales?.x;
  const chartArea = chart.chartArea;
  const labels = chart.data?.labels || [];
  if (!xScale || !chartArea || !labels.length) return null;
  const rect = chart.canvas.getBoundingClientRect();
  const x = clientX - rect.left;
  if (x < chartArea.left || x > chartArea.right) return null;
  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  labels.forEach((_, index) => {
    const distance = Math.abs(x - xScale.getPixelForValue(index));
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  });
  return bestIndex;
}

function selectionIndexFromMonthLabel(label) {
  const target = String(label).slice(0, 7);
  const direct = dataState.selectionPoints.findIndex((point) => point.slice(0, 7) === target);
  if (direct >= 0) return direct;
  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  dataState.selectionPoints.forEach((point, index) => {
    const distance = Math.abs(new Date(point).getTime() - new Date(`${target}-01`).getTime());
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  });
  return bestIndex;
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

  const headerCells = bands.map((b) => `<th class="tl-head-cell" data-band-kind="${showMonths ? "month" : "quarter"}" data-band-key="${b}">${showMonths ? b.slice(0, 7) : b}</th>`).join("");

  const rows = sources.map((src) => {
    const cov = coverage[src] || [];
    const color = SOURCE_COLORS[src] || "#888";
    const cells = showMonths
      ? cov.map((has, index) => `<td class="tl-cell ${has ? "tl-yes" : "tl-no"}" data-band-kind="month" data-band-key="${months[index]}" style="${has ? `background:${color}22;border-left:3px solid ${color}` : ""}"></td>`).join("")
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
  refreshTimelineSelection();
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
    if (!qMap[q]) qMap[q] = { has: false };
    if (cov[i]) qMap[q].has = true;
  }
  return Object.entries(qMap).map(([quarter, info]) => `<td class="tl-cell ${info.has ? "tl-yes" : "tl-no"}" data-band-kind="quarter" data-band-key="${quarter}" style="${info.has ? `background:${color}22;border-left:3px solid ${color}` : ""}"></td>`).join("");
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
    try { dataState.artifacts[key] = await api.getArtifact(runId, stage, name); }
    catch (_) { delete dataState.artifacts[key]; }
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
  const availableGroups = new Set(allSeriesCatalogItems().map((item) => item.group));
  if (!availableGroups.size) { container.innerHTML = `<div class="hint-box">没有可用的分组数据。</div>`; return; }

  destroyAllCharts();

  const html = DATA_GROUP_ORDER
    .filter((g) => availableGroups.has(g))
    .map((g) => {
      const label = dataState.groupLabels[g] || g;
      return `
        <div class="chart-group-card section-gap" id="chart-card-${g}">
          <div class="chart-group-head">
            <div>
              <p class="eyebrow">Group · ${g}</p>
              <h3>${label}</h3>
              <div class="mono-chip chart-window-chip" id="chart-window-${g}">研究窗口 · -</div>
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
  DATA_GROUP_ORDER.filter((g) => availableGroups.has(g)).forEach((g) => {
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
  return getGroupSeries(g).map((item) => item.id);
}

function getGroupRows(g) {
  const artifactKeys = GROUP_ARTIFACT_MAP[g] || [];
  const rowSets = artifactKeys.map((k) => dataState.artifacts[k]?.rows || []);
  return mergeRowSets(rowSets);
}

function rawSeriesPoints(seriesId) {
  const meta = dataState.seriesCatalog[seriesId];
  if (!meta) return [];
  const artifactKey = `providers:${meta.artifact}`;
  const rows = dataState.artifacts[artifactKey]?.rows || [];
  return rows
    .map((row) => {
      const date = row.date || row.index;
      const value = row[meta.column];
      if (!date || value == null || value === "") return null;
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) return null;
      return { date, value: numeric };
    })
    .filter(Boolean)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

function aggregateSeriesPoints(points, frequency = "month") {
  const buckets = new Map();
  for (const point of points) {
    const date = new Date(point.date);
    if (Number.isNaN(date.getTime())) continue;
    const label = bucketKey(date, frequency);
    buckets.set(label, point.value);
  }
  return Array.from(buckets.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([label, value]) => ({ label, value }));
}

function buildSeriesMatrix(seriesIds, frequency = "month") {
  const labelSet = new Set();
  const perSeries = {};
  for (const seriesId of seriesIds) {
    const points = aggregateSeriesPoints(rawSeriesPoints(seriesId), frequency);
    perSeries[seriesId] = new Map(points.map((point) => [point.label, point.value]));
    points.forEach((point) => labelSet.add(point.label));
  }
  const labels = Array.from(labelSet).sort((a, b) => a.localeCompare(b));
  const seriesData = {};
  for (const seriesId of seriesIds) {
    const pointMap = perSeries[seriesId] || new Map();
    seriesData[seriesId] = labels.map((label) => (pointMap.has(label) ? pointMap.get(label) : null));
  }
  return { labels, seriesData };
}

function renderGroupToggles(g) {
  const container = document.getElementById(`chart-toggles-${g}`);
  if (!container) return;
  const seriesItems = getGroupSeries(g);
  if (!seriesItems.length) { container.innerHTML = `<div class="hint-box">无序列</div>`; return; }
  const savedSelection = (dataState.chartSelections[g] || []).filter((id) => seriesItems.some((item) => item.id === id));
  const selectedIds = savedSelection.length ? new Set(savedSelection) : new Set(seriesItems.slice(0, 5).map((item) => item.id));
  dataState.chartSelections[g] = Array.from(selectedIds);
  container.innerHTML = seriesItems.map((item) => `
    <label class="toggle-pill toggle-pill-series ${selectedIds.has(item.id) ? "is-selected" : ""}">
      <input type="checkbox" class="series-toggle series-toggle-${g}" value="${item.id}" ${selectedIds.has(item.id) ? "checked" : ""} />
      <span>${item.short_label || item.column}</span>
    </label>
  `).join("");
  const showAllToggle = document.querySelector(`.chart-show-all-toggle[data-group="${g}"]`);
  if (showAllToggle) showAllToggle.checked = selectedIds.size === seriesItems.length;
}

function getSelectedSeries(g) {
  const selected = Array.from(document.querySelectorAll(`.series-toggle-${g}:checked`)).map((n) => n.value);
  dataState.chartSelections[g] = selected;
  return selected;
}

function isNormalized(g) {
  return document.querySelector(`.chart-normalize-toggle[data-group="${g}"]`)?.checked ?? false;
}

function updateGroupChart(g) {
  const selectedSeries = getSelectedSeries(g);
  const normalize = isNormalized(g);
  const seriesItems = getGroupSeries(g);
  const selectedItems = seriesItems.filter((item) => selectedSeries.includes(item.id));
  document.querySelectorAll(`#chart-toggles-${g} .toggle-pill-series`).forEach((pill) => {
    const checkbox = pill.querySelector("input[type=checkbox]");
    pill.classList.toggle("is-selected", Boolean(checkbox?.checked));
  });

  if (!selectedItems.length) {
    if (dataState.charts[g]) { dataState.charts[g].destroy(); dataState.charts[g] = null; }
    refreshHandoffSelectionSummary();
    return;
  }

  const { labels, seriesData } = buildSeriesMatrix(selectedSeries, "month");
  if (!labels.length) {
    if (dataState.charts[g]) { dataState.charts[g].destroy(); dataState.charts[g] = null; }
    refreshHandoffSelectionSummary();
    return;
  }

  let primarySeries, secondarySeries;
  if (normalize) {
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
      const meta = dataState.seriesCatalog[s] || {};
      return {
        label: `${meta.label || meta.short_label || s}${normalize ? " (归一)" : ""}`,
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
      title: {
        display: true,
        text: normalize ? "指数 (首值=100)" : (primarySeries.length ? primarySeries.map((id) => dataState.seriesCatalog[id]?.short_label || id).join(" / ") : ""),
      },
      ticks: { callback: (v) => formatAxisTick(v) },
    },
  };
  if (secondarySeries.length) {
    scales.y1 = {
      type: "linear",
      position: "right",
      grid: { drawOnChartArea: false },
      title: { display: true, text: secondarySeries.map((id) => dataState.seriesCatalog[id]?.short_label || id).join(" / ") },
      ticks: { callback: (v) => formatAxisTick(v) },
    };
  }

  const canvas = document.getElementById(`chart-canvas-${g}`);
  if (!canvas) return;
  if (dataState.charts[g]) { dataState.charts[g].destroy(); }
  const selection = currentSelectionDates();
  const chart = new Chart(canvas.getContext("2d"), {
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
  chart.$selectionBand = selection;
  bindChartSelectionControls(g, chart);
  dataState.charts[g] = chart;
  refreshHandoffSelectionSummary();
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
      if (row[name] == null || row[name] === "") continue;
      const value = Number(row[name]);
      if (!Number.isFinite(value)) continue;
      bucket.values[name] = (bucket.values[name] || 0) + value;
      bucket.counts[name] = (bucket.counts[name] || 0) + 1;
    }
  }
  const sorted = Array.from(buckets.values())
    .sort((a, b) => a.label.localeCompare(b.label))
    .map((bucket) => ({
      label: bucket.label,
      values: Object.fromEntries(seriesNames.map((name) => [name, bucket.counts[name] ? bucket.values[name] / bucket.counts[name] : null])),
    }));

  // Forward-fill null buckets so sparse-frequency series (quarterly GDP, etc.)
  // show as a step function rather than gaps in the chart.
  const lastSeen = {};
  for (const bucket of sorted) {
    for (const name of seriesNames) {
      if (bucket.values[name] != null) {
        lastSeen[name] = bucket.values[name];
      } else if (lastSeen[name] != null) {
        bucket.values[name] = lastSeen[name];
      }
    }
  }
  return sorted;
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
  const selectionCard = summary.selection ? `
    <div class="metric-card">
      <div class="metric-label">输入区间</div>
      <div class="metric-value">${shortDate(summary.selection.start)} ~ ${shortDate(summary.selection.end)}</div>
    </div>
  ` : "";
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
    ${selectionCard}
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
  if (status === "running") return "运行中";
  if (status === "created") return "已创建";
  return "未执行";
}
function statusClass(status) {
  if (status === "success") return "success";
  if (status === "failed") return "failed";
  if (status === "running" || status === "created") return status;
  return "idle";
}

function renderStatusChip(status) {
  return `<span class="status-chip ${statusClass(status)}">${translateStatus(status)}</span>`;
}

function renderStatusChipLabel(status) {
  return translateStatus(status || "idle");
}

function formatCompactNumber(value) {
  if (value == null || !Number.isFinite(Number(value))) return "-";
  const numeric = Number(value);
  if (Math.abs(numeric) >= 1e6) return `${(numeric / 1e6).toFixed(1)}M`;
  if (Math.abs(numeric) >= 1e3) return `${(numeric / 1e3).toFixed(1)}K`;
  return `${Math.round(numeric)}`;
}

function groupItems(category, group) {
  if (category.category === "资产数据" && group.group === "股票")
    return [...group.items, ...providerState.customItems];
  return group.items;
}

function customEquityControlsMarkup() {
  return `
    <div class="custom-equity-controls">
      <div class="custom-add-row">
        <button class="secondary-button" type="button" data-add-custom-market="CN">+ 添加 A 股</button>
        <button class="secondary-button" type="button" data-add-custom-market="HK">+ 添加港股</button>
        <button class="secondary-button" type="button" data-add-custom-market="US">+ 添加美股</button>
      </div>
    </div>
  `;
}

function customMarketConfig(market) {
  return CUSTOM_MARKETS[market] || CUSTOM_MARKETS.US;
}

function customItemTemplate(market = "US") {
  const config = customMarketConfig(market);
  const id = `custom_equity_${Date.now()}`;
  return {
    id,
    label: config.defaultLabel,
    column: `${market}_${id}`.toUpperCase(),
    artifact: config.artifact,
    sources: [...config.sources],
    source_field: config.source_field,
    quote_unit: config.quoteUnit,
    symbol: "",
    market,
    market_label: config.label,
    symbol_placeholder: config.symbolPlaceholder,
    is_custom: true,
    supports_openbb: config.sources.includes("openbb"),
  };
}

function addCustomEquity(market = "US") {
  const item = customItemTemplate(market);
  providerState.customItems.push(item);
  providerState.sourceSelections[item.id] = item.sources[0];
  renderProvidersTree();
}

function bindCustomItemControls(item) {
  if (!item.is_custom) return;
  const marketSelect = document.getElementById(`custom-market-${item.id}`);
  if (marketSelect) {
    marketSelect.addEventListener("change", (event) => {
      const nextMarket = event.target.value;
      const config = customMarketConfig(nextMarket);
      providerState.customItems = providerState.customItems.map((entry) => {
        if (entry.id !== item.id) return entry;
        return {
          ...entry,
          market: nextMarket,
          market_label: config.label,
          artifact: config.artifact,
          sources: [...config.sources],
          quote_unit: config.quoteUnit,
          symbol_placeholder: config.symbolPlaceholder,
          supports_openbb: config.sources.includes("openbb"),
        };
      });
      providerState.sourceSelections[item.id] = config.sources[0];
      renderProvidersTree();
    });
  }
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
      market: document.getElementById(`custom-market-${item.id}`)?.value || item.market || "US",
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
    market: item.market || "US", market_label: item.market_label || customMarketConfig(item.market || "US").label,
    symbol_placeholder: customMarketConfig(item.market || "US").symbolPlaceholder,
  }));
  const changed = JSON.stringify(nextCustomItems) !== JSON.stringify(providerState.customItems);
  if (changed) {
    providerState.customItems = nextCustomItems;
    for (const item of providerState.customItems)
      providerState.sourceSelections[item.id] = item.selected_source || providerState.sourceSelections[item.id] || item.sources[0];
  }
  return changed;
}

function sourceOptionLabel(source) {
  if (source === "openbb") return "openbb · OpenBB";
  if (source === "akshare") return "akshare · A 股";
  return source;
}

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

function toDateInputValue(value) {
  return value ? String(value).slice(0, 10) : "";
}

function shortDate(value) {
  return value ? String(value).slice(0, 10) : "-";
}

function resolveDataSelectionSummary(summary) {
  const selection = summary.selection || {};
  return {
    available: selection.available_range || summary.intersections?.processed || {},
    applied: selection.applied_range || {},
    appliedDisplaySeriesIds: selection.applied_display_series_ids || [],
    appliedFeatureColumns: selection.applied_feature_columns || [],
    appliedUnmappedSeriesIds: selection.applied_unmapped_series_ids || [],
    coverage: selection.coverage || {},
    selectedRows: selection.selected_rows || {},
  };
}

function allSeriesCatalogItems() {
  return Object.values(dataState.seriesCatalog || {});
}

function getGroupSeries(g) {
  return allSeriesCatalogItems()
    .filter((item) => item.group === g)
    .sort((a, b) => {
      if (Boolean(b.mappable_to_regime) !== Boolean(a.mappable_to_regime)) {
        return Number(Boolean(b.mappable_to_regime)) - Number(Boolean(a.mappable_to_regime));
      }
      return String(a.label || a.short_label || "").localeCompare(String(b.label || b.short_label || ""), "zh-CN");
    });
}

function defaultHandoffSeriesIds() {
  return allSeriesCatalogItems()
    .filter((item) => item.mappable_to_regime)
    .map((item) => item.id);
}

function ensureHandoffSeriesSelection(summary) {
  const availableIds = new Set(Object.keys(summary.series_catalog || {}));
  const appliedIds = (summary.selection?.applied_display_series_ids || []).filter((id) => availableIds.has(id));
  if (appliedIds.length) {
    dataState.handoffSeriesIds = appliedIds;
    dataState.handoffSeriesTouched = false;
    dataState.appliedSelection = summary.selection?.applied_range || null;
    return;
  }
  const currentIds = (dataState.handoffSeriesIds || []).filter((id) => availableIds.has(id));
  dataState.handoffSeriesIds = currentIds.length ? currentIds : defaultHandoffSeriesIds();
  dataState.handoffSeriesTouched = currentIds.length > 0;
  dataState.appliedSelection = summary.selection?.applied_range || null;
}

function currentEditorSeriesIds(selection = resolveDataSelectionSummary(dataState.latestSummary || {})) {
  const availableIds = new Set(Object.keys(dataState.seriesCatalog || {}));
  const currentIds = (dataState.handoffSeriesIds || []).filter((id) => availableIds.has(id));
  if (dataState.handoffSeriesTouched) return currentIds;
  if (currentIds.length) return currentIds;
  if ((selection.appliedDisplaySeriesIds || []).length) {
    return selection.appliedDisplaySeriesIds.filter((id) => availableIds.has(id));
  }
  return defaultHandoffSeriesIds();
}

function seriesSelectionEquals(left = [], right = []) {
  if (left.length !== right.length) return false;
  const leftSorted = [...left].sort();
  const rightSorted = [...right].sort();
  return leftSorted.every((value, index) => value === rightSorted[index]);
}

function currentChartSeriesSelection() {
  const domSelection = Array.from(document.querySelectorAll(".series-toggle:checked")).map((node) => node.value);
  const seriesIds = domSelection.length ? domSelection : Object.values(dataState.chartSelections || {}).flat();
  return [...new Set(seriesIds)].filter((id) => dataState.seriesCatalog[id]);
}

function monthLabelsBetween(start, end) {
  if (!start || !end) return [];
  const labels = [];
  const startDate = new Date(`${String(start).slice(0, 10)}T00:00:00Z`);
  const endDate = new Date(`${String(end).slice(0, 10)}T00:00:00Z`);
  let cursor = new Date(Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), 1));
  const endCursor = new Date(Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth(), 1));
  while (cursor <= endCursor) {
    labels.push(`${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, "0")}`);
    cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
  }
  return labels;
}

function selectionCoverageStats(seriesIds = currentEditorSeriesIds(), start = currentSelectionDates().start, end = currentSelectionDates().end) {
  const labels = monthLabelsBetween(start, end);
  if (!labels.length || !seriesIds.length) {
    return { missingRatio: null, observedCells: 0, totalCells: 0 };
  }
  let observedCells = 0;
  for (const seriesId of seriesIds) {
    const pointMap = new Map(aggregateSeriesPoints(rawSeriesPoints(seriesId), "month").map((point) => [point.label, point.value]));
    labels.forEach((label) => {
      if (pointMap.get(label) != null) observedCells += 1;
    });
  }
  const totalCells = labels.length * seriesIds.length;
  return {
    missingRatio: totalCells ? 1 - observedCells / totalCells : null,
    observedCells,
    totalCells,
  };
}

function setHandoffSeriesSelection(seriesIds) {
  dataState.handoffSeriesIds = [...new Set((seriesIds || []).filter((id) => dataState.seriesCatalog[id]))];
  dataState.handoffSeriesTouched = true;
  renderDataSelection(dataState.latestSummary || {});
  renderDataRibbon(dataState.latestSummary || {});
  renderDataSelectionNotes(dataState.latestSummary || {});
  refreshHandoffSelectionSummary();
}

function useCurrentViewSeriesForHandoff() {
  setHandoffSeriesSelection(currentChartSeriesSelection());
}

function selectAllMappableSeriesForHandoff() {
  setHandoffSeriesSelection(defaultHandoffSeriesIds());
}

function clearHandoffSeriesSelection() {
  setHandoffSeriesSelection([]);
}

function buildSelectionOverview(timeline, selectionPoints) {
  const months = timeline.months || [];
  const sources = timeline.sources || [];
  const coverage = timeline.coverage || {};
  const monthCountMap = new Map(
    months.map((month, index) => [
      month,
      sources.reduce((sum, source) => sum + (coverage[source]?.[index] ? 1 : 0), 0),
    ]),
  );
  const values = selectionPoints.map((point) => monthCountMap.get(point.slice(0, 7)) ?? 0);
  const maxValue = Math.max(...values, 1);
  const width = 1000;
  const height = 120;
  const paddingX = 10;
  const paddingTop = 10;
  const baseline = 106;
  const innerWidth = Math.max(width - paddingX * 2, 1);
  const span = Math.max(selectionPoints.length - 1, 1);
  const linePoints = values.map((value, index) => {
    const x = paddingX + (index / span) * innerWidth;
    const y = baseline - (value / maxValue) * (baseline - paddingTop);
    return [x, y];
  });
  const linePath = linePoints.map(([x, y], index) => `${index === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`).join(" ");
  const areaPath = `${linePath} L ${(paddingX + innerWidth).toFixed(2)} ${baseline} L ${paddingX.toFixed(2)} ${baseline} Z`;
  return { linePath, areaPath };
}

function buildSelectionPoints(startValue, endValue) {
  if (!startValue || !endValue) return [];
  const points = [];
  let cursor = new Date(toDateInputValue(startValue));
  const end = new Date(toDateInputValue(endValue));
  cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 0));
  const normalizedEnd = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 0));
  while (cursor <= normalizedEnd) {
    points.push(cursor.toISOString().slice(0, 10));
    cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 2, 0));
  }
  if (!points.length || points[0] !== toDateInputValue(startValue)) {
    points.unshift(toDateInputValue(startValue));
  }
  if (points[points.length - 1] !== toDateInputValue(endValue)) {
    points.push(toDateInputValue(endValue));
  }
  return [...new Set(points)];
}

function selectionPointIndex(value, points) {
  const target = toDateInputValue(value);
  const directIndex = points.indexOf(target);
  if (directIndex >= 0) return directIndex;
  const targetTime = new Date(target).getTime();
  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  points.forEach((point, index) => {
    const distance = Math.abs(new Date(point).getTime() - targetTime);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  });
  return bestIndex;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function slugify(value) {
  return String(value).toLowerCase().replace(/\s+/g, "-").replace(/[^\w\u4e00-\u9fa5-]/g, "");
}

init();

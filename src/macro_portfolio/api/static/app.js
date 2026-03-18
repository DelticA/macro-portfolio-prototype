const providerState = {
  tree: [],
  sourceSelections: {},
  itemNodes: {},
  customItems: [],
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
    if (runId) await renderProviders(runId);
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
  if (select.value) await renderProviders(select.value);
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

function setProvidersStatus(text) {
  document.getElementById("providers-status").textContent = text;
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

async function handle(res) {
  const payload = await res.json();
  if (!res.ok) throw new Error(payload.detail || "Request failed");
  return payload;
}

function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^\w\u4e00-\u9fa5-]/g, "");
}

init();

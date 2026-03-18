const providerState = {
  tree: [],
  sourceSelections: {},
  itemNodes: {},
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
  if (selectedId) select.value = selectedId;
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
                      <span class="accordion-meta">${group.items.length} 个子类目</span>
                      <span class="accordion-chevron">▸</span>
                    </button>
                    <div class="sub-accordion-panel" id="group-${slugify(category.category)}-${slugify(group.group)}">
                      ${group.items.map((item) => providerItemMarkup(item)).join("")}
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
      for (const item of group.items) {
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
          <p>字段: ${item.column} · 输出文件: ${item.artifact}</p>
        </div>
        <div class="provider-actions">
          <label>来源
            <select id="source-${item.id}" ${item.sources.length === 1 ? "disabled" : ""}>
              ${item.sources.map((source) => `<option value="${source}">${source}</option>`).join("")}
            </select>
          </label>
          <button class="secondary-button" id="fetch-${item.id}">拉取 / 更新</button>
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
    csi300_code: document.getElementById("csi300-code").value,
    star50_code: document.getElementById("star50-code").value,
    cgb_code: document.getElementById("cgb-code").value,
    selected_items: selectedItems,
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
  setProvidersStatus(`状态: ${payload.status}`);
  document.getElementById("providers-log").textContent = payload.log || "";
  renderProviderResults(payload.summary?.categories || []);
  renderPreview(document.getElementById("providers-preview"), payload.preview || {});
}

function setProvidersStatus(text) {
  document.getElementById("providers-status").textContent = text;
}

function renderProviderResults(groups) {
  const container = document.getElementById("providers-results");
  if (!groups.length) {
    container.innerHTML = "";
    return;
  }

  for (const group of groups) {
    for (const item of group.items) {
      const mini = document.getElementById(`status-${item.id}`);
      if (mini) mini.textContent = `${item.status} · ${item.selected_source}`;
    }
  }

  container.innerHTML = groups
    .map(
      (group) => `
        <section class="result-group">
          <div class="group-head">
            <h3>${group.category} / ${group.group}</h3>
          </div>
          <div class="result-list">
            ${group.items
              .map(
                (item) => `
                  <div class="result-item ${item.status}">
                    <div>
                      <strong>${item.label}</strong>
                      <p>来源: ${item.selected_source} · 文件: ${item.artifact} · 字段: ${item.column}</p>
                    </div>
                    <div class="result-meta">
                      <span class="pill ${item.status}">${item.status}</span>
                      <span>${item.rows} rows</span>
                      <span>${item.non_null} non-null</span>
                    </div>
                  </div>
                `,
              )
              .join("")}
          </div>
        </section>
      `,
    )
    .join("");
}

function renderPreview(container, preview) {
  const entries = Object.entries(preview);
  if (!entries.length) {
    container.innerHTML = "";
    return;
  }
  container.innerHTML = entries
    .map(([name, rows]) => {
      const columns = rows.length ? Object.keys(rows[0]) : [];
      return `
        <div class="preview-card">
          <strong>${name}</strong>
          <table>
            <thead><tr>${columns.map((column) => `<th>${column}</th>`).join("")}</tr></thead>
            <tbody>${rows.map((row) => `<tr>${columns.map((column) => `<td>${formatValue(row[column])}</td>`).join("")}</tr>`).join("")}</tbody>
          </table>
        </div>
      `;
    })
    .join("");
}

function formatValue(value) {
  if (value == null) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
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

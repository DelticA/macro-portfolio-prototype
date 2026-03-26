# Macro Portfolio Prototype

English version: [README_EN.md](README_EN.md)

面向宏观量化研究的本地实验工作台。当前版本把研究流程拆成 5 个连续阶段：

1. `providers`：拉取原始宏观与资产数据
2. `data`：做时点对齐、特征工程、资产收益面板构建
3. `regime`：生成状态/信号
4. `policy`：做组合构建并叠加风险层
5. `backtest`：做滚动回测、指标评估和基准比较

项目不是单纯的 notebook 集合，而是一个带 `run_id`、阶段 artifact、日志、API 和网页工作台的研究框架。所有实验都落在 `runs/<run_id>/` 下，便于回溯和比较。

## 1. 适用场景

这个项目适合做以下类型的研究：

- 宏观状态驱动的多资产配置
- 中美双区域景气/通胀框架
- 先筛选研究窗口和输入变量，再将筛选后的数据交给下游建模
- 同一份信号上尝试不同组合构建与风控叠加
- 本地迭代定制化策略，而不是一开始就接复杂交易执行

当前内置的交易资产池仍是核心 9 类资产：

- `SPY`
- `QQQ`
- `TLT`
- `GLD`
- `DBC`
- `BTC`
- `CSI300`
- `STAR50`
- `CGB`

第 1 页新增的 A 股 / 港股 / 美股自定义股票，当前已经能进入数据浏览与部分特征输入链路；但默认还没有进入第 4、5 页的可交易资产池。

## 2. 快速开始

启动本地工作台：

```bash
cd /path/to/macro-portfolio-prototype
PYTHONPATH=src python scripts/run_lab_api.py
```

然后打开：

- `http://127.0.0.1:8010/`

运行测试：

```bash
PYTHONPATH=src pytest
```

如果仓库里已经有本地虚拟环境，也可以用：

```bash
PYTHONPATH=src ./venv/bin/python scripts/run_lab_api.py
PYTHONPATH=src ./venv/bin/python -m pytest
```

## 3. 顶层架构

系统分成 4 层：

### 3.1 UI / API 层

- 前端页面在 `src/macro_portfolio/api/static/`
- FastAPI 入口在 `src/macro_portfolio/api/app.py`
- 页面按阶段拆分，对应后端阶段接口

### 3.2 Pipeline 编排层

- `src/macro_portfolio/services/pipeline.py`
- `PipelineService` 负责串联各阶段
- 每个阶段都负责：
  - 校验上游阶段是否成功
  - 读取上游 artifact
  - 生成本阶段 artifact / summary / log
  - 更新 `run.json`

### 3.3 研究模型层

- `src/macro_portfolio/data.py`：数据对齐与特征工程
- `src/macro_portfolio/regime.py` + `src/macro_portfolio/models/regime/`：状态识别
- `src/macro_portfolio/policy.py` + `src/macro_portfolio/models/policy/`：组合构建
- `src/macro_portfolio/models/risk/`：风险叠加层
- `src/macro_portfolio/backtest.py`：滚动回测引擎

### 3.4 实验存储层

- `src/macro_portfolio/engine/run_store.py`
- `src/macro_portfolio/engine/artifacts.py`
- 每个实验一个 `run_id`
- 每个阶段一个目录
- 每个目录里有 `csv/json` artifact
- 另有分阶段日志 `logs/<stage>.log`

## 4. 五个环节的原理

## 4.1 第一部分：数据获取 `providers`

### 原理

这一层解决的是“从哪里拿原始数据”和“原始数据按什么口径组织”。

它不是直接把所有数据塞进一个大表，而是先按研究语义拆成 4 份基础原始数据集：

- `us_macro.csv`
- `cn_macro.csv`
- `global_prices.csv`
- `cn_assets.csv`

这样做的原因是：

- 宏观数据和价格数据的频率、发布日期、缺失模式完全不同
- 中国资产需要后续额外做汇率转换
- 页面上需要保留“我拉了哪些条目、用哪个 source、覆盖到哪天”的研究上下文

### 当前支持的数据源

- `FRED`
- `Stooq`
- `Yahoo Finance`
- `Binance`
- `Akshare`
- `OpenBB`（可选）

### 这一层做了什么

- 按条目拉取数据，而不是只能全量拉取
- 支持 A 股 / 港股 / 美股自定义股票
- 记录每个条目的：
  - label
  - source
  - artifact
  - column
  - start / end
  - rows / non_null
  - frequency

### 产物

- `providers/us_macro.csv`
- `providers/cn_macro.csv`
- `providers/global_prices.csv`
- `providers/cn_assets.csv`
- `providers/catalog.json`

## 4.2 第二部分：数据处理 `data`

### 原理

这一层解决的是“研究时点上到底看到了什么数据”。

核心有 3 件事：

1. 把不同频率的数据统一到月末研究频率
2. 按地区和数据类型施加发布滞后，避免未来函数
3. 把原始序列转成可建模特征和资产收益面板

### 关键实现

`MacroDataset.build_feature_table(...)` 会对宏观和全局价格特征做：

- 月末对齐
- 去重
- `ffill`
- 区域滞后处理
- 特征工程

当前每条序列会生成这些特征：

- `*_level`
- `*_mom`
- `*_yoy`
- `*_z`
- `*_pct`

`MacroDataset.build_asset_panel(...)` 会对价格数据做：

- 月度收益计算
- 中国资产从 CNY 研究口径换算到 USD 研究口径
- 生成统一资产面板

### 为什么要单独做“数据选择”

第二页不是只做预览，而是正式负责下游 handoff。

你可以在这一层同时筛：

- 时间窗口
- 要交给第三部分的条目集合

筛选后，系统会落出独立的下游输入，而不是只在前端临时记住。

### 数据选择逻辑

- `display_series_ids`：你在第二页勾选的原始序列
- `feature_columns`：这些原始序列实际映射到的特征列
- `selected_series.csv`：筛选后的原始展示序列窗口
- `selected_features.csv`：真正交给第三部分的处理后特征
- `selected_asset_returns.csv` / `selected_asset_panel.csv`：同步裁切后的资产收益和面板

页面上展示的整体缺失率，反映的是：

- 你勾选的序列
- 在你当前选定窗口内
- 实际观测点数 / 应有点数

### 产物

- `data/features.csv`
- `data/asset_returns.csv`
- `data/asset_panel.csv`
- `data/summary.json`
- `data/selection.json`
- `data/selected_series.csv`
- `data/selected_features.csv`
- `data/selected_asset_returns.csv`
- `data/selected_asset_panel.csv`

## 4.3 第三部分：状态识别 `regime`

### 原理

这一层本质上是信号层。当前 UI 名字仍然叫“状态识别”，但架构上它已经是下游策略层的 signal provider。

默认输入来源：

- 如果第二页已应用筛选，则优先使用 `selected_features.csv`
- 否则使用完整的 `features.csv`

### 内置模型

- `rule_based`
- `kmeans`
- `gmm`

### 规则模型的基本思想

规则模型分两步：

1. `RegionalRegimeModel`
   - 分别计算美国和中国的增长 / 通胀分数
   - 用象限法映射成区域状态
2. `PortfolioRegimeAggregator`
   - 把中美区域状态汇总成组合层状态
   - 输出组合状态和置信度

当前组合层状态包括：

- `global_easing_growth`
- `reflation`
- `disinflationary_slowdown`
- `stagflation_pressure`
- `china_recovery_us_weak`

### 为什么输出要单独落盘

因为第 4 页不应该重复拟合状态模型。它应该消费一个清晰、固定的信号产物。

### 产物

- `regime/regime.csv`
- `regime/diagnostics.json`
- `regime/summary.json`

## 4.4 第四部分：策略决策 `policy`

### 原理

这一层现在已经不再是“一个黑盒 policy”，而是拆成两层：

1. `portfolio_model`
2. `risk_model`

这是一种更适合后续量化研究扩展的范式。后续要接定制策略时，可以只换组合构建，或者只换风控层，而不必重写整层。

### 组合构建层 `portfolio_model`

当前内置：

- `template_rule`
- `risk_parity`
- `cvar`

底层核心类是 `PortfolioPolicy`，主要做这些事：

- 根据状态切换模板权重
- 根据资产类型和状态施加上下界
- 用 `CVaR + tracking + turnover` 目标求解
- 若优化失败则退化到 risk parity
- 施加中美权益上限
- 过滤太小的调仓动作

### 风控层 `risk_model`

当前内置：

- `none`
- `confidence_guard`
- `vol_target`

两种风控层都采用“把风险资产资本往防御资产转移”的设计：

- `confidence_guard`
  - 当状态置信度低于阈值时，降低风险资产仓位
- `vol_target`
  - 当最近窗口组合实现波动率高于目标时，降低风险资产仓位

### 为什么要保留 raw / final 两套权重

因为研究上要分清：

- 组合构建层本来想配什么
- 风控层后来改了多少

所以系统会同时保存：

- `weights_target_raw.csv`
- `weights_target.csv`

### 产物

- `policy/weights_target_raw.csv`
- `policy/weights_target.csv`
- `policy/strategy_manifest.json`
- `policy/summary.json`

## 4.5 第五部分：回测分析 `backtest`

### 原理

这一层做的是月频 walk-forward 回测。

基本流程是：

1. 在每个月 t
2. 用过去 `training_window` 个月收益作为训练窗口
3. 读取当月状态信号
4. 通过 `portfolio_model + risk_model` 得到目标权重
5. 计算当月收益、换手和交易成本
6. 更新净值和持仓历史

### 关键设计点

- 回测消费的是“完整策略栈”而不是单独的优化器
- 交易成本按换手收取
- 输出同时包含：
  - `nav`
  - `weights`
  - `benchmarks`
  - `attribution`
  - `metrics`

### 当前基准

- `permanent_portfolio`
- `sixty_forty`
- `risk_parity_static`

### 产物

- `backtest/nav.csv`
- `backtest/weights.csv`
- `backtest/benchmarks.csv`
- `backtest/attribution.csv`
- `backtest/metrics.json`
- `backtest/strategy_manifest.json`
- `backtest/summary.json`

## 5. 数据流与 artifact 流

完整链路可以理解成下面这个有状态的数据流：

```text
providers
  -> us_macro.csv / cn_macro.csv / global_prices.csv / cn_assets.csv
  -> data
      -> features.csv / asset_returns.csv / asset_panel.csv
      -> optional selection
          -> selected_series.csv / selected_features.csv / selected_asset_returns.csv / selected_asset_panel.csv
      -> regime
          -> regime.csv
          -> policy
              -> weights_target_raw.csv / weights_target.csv
              -> backtest
                  -> nav.csv / weights.csv / metrics.json / benchmarks.csv / attribution.csv
```

如果第二页应用了筛选，下游优先走筛选后的 artifact。

## 6. Run 目录结构

每个实验都在 `runs/<run_id>/` 下。

典型结构如下：

```text
runs/<run_id>/
  run.json
  logs/
    providers.log
    data.log
    regime.log
    policy.log
    backtest.log
  providers/
    us_macro.csv
    cn_macro.csv
    global_prices.csv
    cn_assets.csv
    catalog.json
  data/
    features.csv
    asset_returns.csv
    asset_panel.csv
    summary.json
    selection.json
    selected_series.csv
    selected_features.csv
    selected_asset_returns.csv
    selected_asset_panel.csv
  regime/
    regime.csv
    diagnostics.json
    summary.json
  policy/
    weights_target_raw.csv
    weights_target.csv
    strategy_manifest.json
    summary.json
  backtest/
    nav.csv
    weights.csv
    benchmarks.csv
    attribution.csv
    metrics.json
    strategy_manifest.json
    summary.json
```

## 7. 代码结构

核心目录如下：

```text
src/macro_portfolio/
  api/
    app.py                 # FastAPI 入口
    static/                # 前端工作台
  engine/
    artifacts.py           # csv/json 读写
    run_store.py           # run 元数据与日志
    schemas.py             # API 请求模型
  models/
    regime/                # 状态识别模型
    policy/                # 组合构建模型
    risk/                  # 风控叠加模型
  services/
    pipeline.py            # 五阶段编排
    registry.py            # 模型注册表
  data.py                  # 数据对齐与特征工程
  providers.py             # 数据源适配器
  regime.py                # 规则状态模型
  policy.py                # 组合构建核心
  backtest.py              # 回测引擎
  live.py                  # 默认资产池与 live pipeline 辅助
```

## 8. 扩展范式

这个版本的架构重点是给后续定制化策略留扩展位。

### 8.1 新增状态模型

在 `src/macro_portfolio/models/regime/` 下新增模型，并在 `services/registry.py` 注册。

适合接入的方向：

- 更复杂的聚类
- 隐马尔可夫模型
- 监督学习信号模型
- 因子打分模型

### 8.2 新增组合构建模型

在 `src/macro_portfolio/models/policy/` 下新增模型，并在 `services/registry.py` 注册。

适合接入：

- Black-Litterman
- mean-variance
- hierarchical risk parity
- 跟踪误差约束优化

### 8.3 新增风控叠加层

在 `src/macro_portfolio/models/risk/` 下新增模型。

适合接入：

- drawdown guard
- exposure cap
- macro veto
- liquidity filter

### 8.4 自定义交易资产池

当前默认交易池来自 `live.py` 里的 `DEFAULT_ASSETS`。如果后续要把自定义股票正式接进第 4、5 页，需要把“研究序列”和“可交易资产池”解耦得更彻底。

## 9. API 示例

创建新实验：

```bash
curl -X POST http://127.0.0.1:8010/api/runs \
  -H 'Content-Type: application/json' \
  -d '{"label":"research run"}'
```

拉取原始数据：

```bash
curl -X POST http://127.0.0.1:8010/api/runs/<run_id>/providers \
  -H 'Content-Type: application/json' \
  -d '{
    "start_date":"2018-01-01",
    "end_date":"2026-03-17"
  }'
```

执行数据处理：

```bash
curl -X POST http://127.0.0.1:8010/api/runs/<run_id>/data \
  -H 'Content-Type: application/json' \
  -d '{
    "us_release_lag":1,
    "cn_release_lag":0,
    "global_release_lag":1,
    "z_window":36
  }'
```

应用第二页筛选：

```bash
curl -X POST http://127.0.0.1:8010/api/runs/<run_id>/data/selection \
  -H 'Content-Type: application/json' \
  -d '{
    "start_date":"2020-01-31",
    "end_date":"2024-12-31",
    "display_series_ids":["us_macro::cpi","cn_macro::pmi","global_prices::SPY"]
  }'
```

执行状态识别：

```bash
curl -X POST http://127.0.0.1:8010/api/runs/<run_id>/regime \
  -H 'Content-Type: application/json' \
  -d '{
    "model_name":"rule_based",
    "smoothing_window":3,
    "n_states":4
  }'
```

执行组合构建：

```bash
curl -X POST http://127.0.0.1:8010/api/runs/<run_id>/policy \
  -H 'Content-Type: application/json' \
  -d '{
    "model_name":"cvar",
    "portfolio_model":"cvar",
    "risk_model":"confidence_guard",
    "execution_model":"immediate",
    "training_window":60,
    "transaction_cost_bps":5.0,
    "overrides":{}
  }'
```

执行回测：

```bash
curl -X POST http://127.0.0.1:8010/api/runs/<run_id>/backtest \
  -H 'Content-Type: application/json' \
  -d '{
    "model_name":"cvar",
    "portfolio_model":"cvar",
    "risk_model":"vol_target",
    "execution_model":"immediate",
    "training_window":60,
    "transaction_cost_bps":5.0,
    "overrides":{}
  }'
```

## 10. 数据源配置

### 默认不需要 key

- Stooq ETF 价格
- Binance BTC 历史
- Akshare 中国宏观与资产
- OpenBB 本地安装后可选

### 你大概率需要的 key

- `FRED_API_KEY`

设置方式：

```bash
export FRED_API_KEY="your_fred_key"
```

也可以放进 git 忽略的 `.env.secrets`：

```bash
FRED_API_KEY=your_fred_key
```

## 11. 当前限制

- 第 4、5 页的可交易 universe 仍固定为核心 9 类资产
- 执行层当前只是 `immediate`，还没有更细粒度的撮合 / 滑点 / 流动性建模
- 第二页筛选后，display-only 序列会保存在 handoff 元数据里，但不会直接进入状态模型
- 当前回测频率是月频，不是日频或事件驱动

## 12. 设计取向

这个项目当前更像“宏观量化研究工作台”而不是“生产交易系统”。

设计上优先保证的是：

- 研究链路清晰
- 每一步都可追溯
- 数据筛选和下游输入严格对应
- 模型层可以插拔
- 本地实验成本低

等研究范式稳定之后，再把 live / execution 做重。

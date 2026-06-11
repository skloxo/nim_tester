# API 模型测试平台 开发者指南 (DEVELOPER.md)

这份文档主要面向希望参与框架扩展、优化或调试的**开发人员**与 **AI Agent**，旨在帮助您在几分钟内理清项目的技术底座、代码结构与核心算法，以实现快速上手和迭代。

---

## 🛠️ 技术栈与依赖说明

1. **运行环境**：[Bun](https://bun.sh) (推荐 v1.1.0+)。本项目利用 Bun 提供的原生超快启动、极速 `fetch` 连接池复用、以及轻量级 `bun:sqlite`。
2. **Web 框架**：[Hono](https://hono.dev)。用于轻量级 API 驱动和 Server-Sent Events (SSE) 实时日志推送。
3. **Excel 导出**：[exceljs](https://github.com/exceljs/exceljs)。多 Sheet 报表构建，高度定制单元格格式、背景色及自适应列宽。
4. **数据库**：原生 SQLite，使用单文件 `history.db` 进行数据持久化，通过 WAL (Write-Ahead Logging) 提升多路读写吞吐，引入单事务 Batch 写入以防止高频写入锁死。

---

## 📂 代码目录与核心模块职责

项目核心源代码位于 [src/](file:///wsl.localhost/Ubuntu-24.04/home/skloxo/aho/openclaw/project/nim_tester/src/)，各文件定义如下：

```
src/
├── main.ts                   # CLI 命令行入口，顺序跑通 Step 1 ~ 5 并在控制台打印打分 Summary
├── server.ts                 # Hono Web 服务器，维护全局运行状态并暴露 SSE、配置及 Excel 导出 API
└── tester/
    ├── types.ts              # 核心 TypeScript 数据接口声明
    ├── cases.ts              # 声明 9 大分类的 TestCase 细节（含 prompt、验证器、测试模式等）
    ├── db.ts                 # SQLite DAL 层，包括 runs, model_results, cache 表的读写和 Batch 事务管理
    ├── network.ts            # 网络路径自动诊断器，测试 Direct/Proxy 平均延迟，决定后续网络客户端参数
    ├── model_fetcher.ts      # 模型列表爬取器，支持基于 API Key 分页轮转拉取 API 列表
    ├── metaFetcher.ts        # 元数据爬取同步。将本地 Catalog 缓存与 HuggingFace API 动态爬取结合，获取参数量等
    ├── categorizer.ts        # 智能分组器，根据包含/排除（exclude）关键词对模型进行归类
    ├── runner.ts             # 评测跑测控制引擎。管理并发信号量，控制多 Key 的滑动窗口频率限制与指数退避重试
    ├── scorer.ts             # 打分与排名算法模块，执行硬性场景约束判定（上下文、TPS 罚分与评级上限截断）
    ├── useCase.ts            # 场景画像决策模块，评估吞吐率、上下文与模型体积以输出推荐徽章
    └── excelReport.ts        # 报表渲染器，生成总览和分类 Sheet 细节的 Excel 报告
```

---

## 💾 数据库表结构 (SQLite)

在首次导入 [db.ts](file:///wsl.localhost/Ubuntu-24.04/home/skloxo/aho/openclaw/project/nim_tester/src/tester/db.ts) 时，系统会自动执行 `initDb()` 创建如下 4 张核心表：

### 1. `runs` (评测总运行表)
记录每一次运行的元数据信息：
* `run_id`: 12位唯一随机字符串。
* `profile`: 使用的配置档案名称。
* `base_url`: 本次运行使用的 API 端点。
* `started_at`, `finished_at`: 时间戳。
* `config_json`: 运行时的完整 config 快照。

### 2. `model_results` (模型评测得分表)
* `run_id`: 对应 `runs.run_id` 的外键。
* `model_id`: 评测模型的 ID（如 `nvidia/llama-3.1-nemotron-70b-instruct`）。
* `score`, `grade`, `rank`: 综合分数、评级（S/A/B/C/D/F）及组内排名。
* `avg_tps`, `passed`, `total`: 实测吞吐率、通过用例数与总用例数。
* `use_cases`: JSON 场景徽章数组。
* `results_json`: 每一个用例的详细输出快照。

### 3. `model_meta_cache` (元数据信息缓存表)
* `model_id`: 主键。
* `param_count` (参数量), `max_context` (最大上下文), `release_date` (发布日期)。
* `fetched_at`: 数据同步时间戳（默认 7 天过期重刷）。

### 4. `use_case_cache` (智能推荐置信度表)
* 记录历史推荐并采用 `confidence` 计数自增模式，仅在模型多次跑测置信度高时予以缓存，加速 UI 的列表页渲染。

---

## 📐 核心算法与硬性约束

### 1. KeyRotator 线程安全限速轮转 (`runner.ts`)
* **痛点**：NVIDIA API 免费账户每个 Key 限速 40次/分钟。
* **实现**：[KeyRotator](file:///wsl.localhost/Ubuntu-24.04/home/skloxo/aho/openclaw/project/nim_tester/src/tester/runner.ts#L15) 维护每个 API Key 独立的时间戳滑动窗口。在 `next()` 阶段对 Key 进行轮训探测，若检测到某 Key 触发频限，**将 Sleep 动作放在并发 Semaphore 外部执行**。这保证了并发槽不被无效占用。

### 2. 打分逻辑与硬性约束限制 (`scorer.ts`)
* **得分机制**：模型基础分由各类别用例通过率加权得出。
* **上下文罚分**：当 `max_context < 32768`（小于32k），执行硬性约束——**总分扣减 15 分，Grade 评级上限强制截断为 B 级**（说明该模型不支持长上下文和高级 RAG/Agent 开发）。
* **极慢响应罚分**：当 `avg_tps < 3.0`（平均 TPS 小于3），执行硬性约束——**总分扣减 20 分，Grade 评级上限强制截断为 C 级**。
* **速度加分（Speed Bonus）**：
  * 若模型所在分类属于 TPS 测试类别（如对话、代码），则以该类别中最高 TPS 模型的表现为基准进行线性加分（最高加10分）。
  * 若非 TPS 类别（如文本嵌入、Rerank），则以其倒数延迟与最优延迟的比例进行加分。

### 3. 多维场景智能推荐模型 (`useCase.ts`)
* 当 `max_context < 32768` 时，自动在推荐列表中移除 RAG/Agent/长文本摘要，并打上 `⚠️ 短上下文 (<32k)` 警告标签。
* 当 `avg_tps < 3.0` 时，强制覆盖所有推荐场景为 `⚠️ 极慢响应` 预警标签。
* 对于小参数规模（`< 10B`）且运行速度飞快（`avg_tps > 35`）的模型，自动追加 `高频实时交互`、`单意图路由` 等场景推荐。

---

## 🛠️ 常见开发迭代操作指南

如果您作为 AI Agent 需要对评测逻辑进行拓展，请参考以下指南：

### 1. 如何新增测试用例？
在 [cases.ts](file:///wsl.localhost/Ubuntu-24.04/home/skloxo/aho/openclaw/project/nim_tester/src/tester/cases.ts) 内，针对对应分类（如 `general_chat`），向数组中追加一个新实例：
```typescript
new TestCase({
  name: "T-07 自定义逻辑用例",
  test: "custom_logic",           // 必须填写 test 属性，以便 Scorer 匹配权重
  required: false,                // true 代表快速扫描模式下强制运行
  tags: ["chat"],                 // 加上 "streaming" 标签可自动以 SSE 流式拉取
  buildPayload: (model) => ({
    model: model,
    messages: [{ role: "user", content: "请回答 1+1=" }],
    temperature: 0.1,
  }),
  parseResult: (raw, elapsedMs) => {
    // 编写您的校验代码，返回 { success: boolean, content_preview?: string, reason?: string }
    const text = raw.choices?.[0]?.message?.content || "";
    return {
      success: text.includes("2"),
      content_preview: text.substring(0, 50),
    };
  }
})
```

### 2. 如何修改测试用例的分数权重？
在 [scorer.ts](file:///wsl.localhost/Ubuntu-24.04/home/skloxo/aho/openclaw/project/nim_tester/src/tester/scorer.ts) 的开头，找到 `TEST_WEIGHTS` 哈希映射。直接在此处调整或新增您的权重映射（满分为 100 分）：
```typescript
const TEST_WEIGHTS: Record<string, number> = {
  "basic_availability": 10,
  "chinese_support": 15,
  "tool_calling": 25,
  "custom_logic": 10,     // 在此添加您的测试项占的分值
  ...
};
```

### 3. 如何增加或修改模型的智能分类？
编辑根目录下的 [config.yaml](file:///wsl.localhost/Ubuntu-24.04/home/skloxo/aho/openclaw/project/nim_tester/config.yaml)，在 `model_categories` 对应分类下，修改/增加 `keywords` 或 `exclude_keywords` 过滤策略即可，框架会自动在拉取模型列表后进行重整分类。

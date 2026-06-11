# API 模型测试平台 - 完整项目文档

> 版本: v1.1.0 | 最后更新: 2026-06-12

---

## 1. 项目背景

### 1.1 为什么开发这个项目

随着 NVIDIA NIM 及各类 OpenAI 兼容接口的大模型（LLM、VLM、Embedding、Reranker、TTS 等）快速涌现，企业和开发者面临一个共同痛点：**如何系统性地评估和比较不同模型的性能、质量和适用场景？**

手动逐个测试模型效率低下、标准不统一、结果难以横向比较。本项目旨在提供一个**自动化、标准化、多维度**的模型评测框架，让模型选型决策有据可依。

### 1.2 解决什么问题

- **模型选型困难**: 大量模型缺乏统一的评测基准和横向对比
- **测试效率低**: 手动逐个测试 API 模型耗时耗力
- **评估维度单一**: 仅关注准确率，忽略吞吐量、延迟、场景适配等维度
- **报告不直观**: 缺乏可视化、可导出的评测报告
- **限速管理复杂**: NVIDIA API 免费层每 Key 每分钟 40 次限制，多 Key 轮换管理繁琐

### 1.3 目标用户

| 用户群体 | 典型场景 |
|---------|---------|
| AI 产品经理 | 模型选型决策，对比不同供应商的模型能力 |
| ML 工程师 | 评估模型在实际业务场景中的表现 |
| 技术团队负责人 | 制定团队的模型使用策略 |
| AI Agent 开发者 | 选择最适合 Agent 构建的基础模型 |
| 模型供应商 | 自家模型的基准测试和竞品对比 |

---

## 2. 产品架构

### 2.1 系统架构图（文字描述）

```
┌─────────────────────────────────────────────────────────────────┐
│                        Web UI (static/index.html)               │
│   ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────┐  │
│   │ API 档案  │  │ 测试控制  │  │ 实时日志  │  │  结果展示/导出│  │
│   └──────────┘  └──────────┘  └──────────┘  └──────────────┘  │
└────────────────────────────┬────────────────────────────────────┘
                             │ HTTP / SSE
┌────────────────────────────▼────────────────────────────────────┐
│                     Hono Web Server (server.ts)                 │
│   ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────┐  │
│   │ REST API │  │ SSE 推送  │  │ Profile  │  │ Excel 导出   │  │
│   └──────────┘  └──────────┘  └──────────┘  └──────────────┘  │
└────────────────────────────┬────────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────────┐
│                     评测引擎 (src/tester/)                       │
│                                                                 │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐│
│  │ Network      │  │ Model       │  │ Meta Fetcher            ││
│  │ Selector     │  │ Fetcher     │  │ (HuggingFace + Catalog) ││
│  └──────┬──────┘  └──────┬──────┘  └───────────┬─────────────┘│
│         │                │                      │               │
│  ┌──────▼──────┐  ┌──────▼──────┐  ┌───────────▼─────────────┐│
│  │ Categorizer │  │ Test Runner │  │ Circuit Breaker          ││
│  │ (智能分组)   │  │ (并发测试)   │  │ (熔断降级)               ││
│  └─────────────┘  └──────┬──────┘  └─────────────────────────┘│
│                          │                                      │
│  ┌───────────────────────▼──────────────────────────────────┐  │
│  │               Scorer + UseCase (评分 + 推荐)              │  │
│  └───────────────────────┬──────────────────────────────────┘  │
│                          │                                      │
│  ┌───────────────────────▼──────────────────────────────────┐  │
│  │          Excel Report + SQLite History (持久化)           │  │
│  └──────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│              NVIDIA NIM / OpenAI 兼容 API 端点                   │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 模块职责

| 模块 | 文件 | 职责 |
|------|------|------|
| CLI 入口 | `src/main.ts` | 命令行模式运行，顺序执行 Step 1~5 |
| Web 服务器 | `src/server.ts` | Hono HTTP 服务，提供 REST API、SSE 实时日志、Excel 导出 |
| 网络选择器 | `src/tester/network.ts` | 自动测速，选择直连或代理的最优网络路径 |
| 模型拉取器 | `src/tester/model_fetcher.ts` | 分页拉取 API 提供的全量模型列表，支持多 Key 轮换 |
| 元数据爬取器 | `src/tester/metaFetcher.ts` | 从本地 Catalog、HuggingFace API、内置 KB 获取模型元数据 |
| 智能分组器 | `src/tester/categorizer.ts` | 根据关键词/排除词规则将模型自动归类到 9 大类别 |
| 测试用例 | `src/tester/cases.ts` | 定义 9 大类别的测试用例（含 prompt、验证器、测试模式） |
| 评测引擎 | `src/tester/runner.ts` | 并发信号量控制、多 Key 滑动窗口限速、指数退避重试 |
| 熔断器 | `src/tester/circuitBreaker.ts` | 连续失败时自动降级，防止雪崩 |
| 评分算法 | `src/tester/scorer.ts` | 加权评分、硬性约束扣分、速度加分、评级截断 |
| 场景推荐 | `src/tester/useCase.ts` | 基于测试结果和元数据推断推荐使用场景 |
| Excel 报告 | `src/tester/excelReport.ts` | 多 Sheet 报表构建，自定义格式和自适应列宽 |
| 数据库层 | `src/tester/db.ts` | SQLite DAL，WAL 模式，事务批量写入 |
| 类型定义 | `src/tester/types.ts` | 核心 TypeScript 接口声明 |

### 2.3 数据流

```
1. 加载 config.yaml → 获取 API Keys、端点、网络配置
2. NetworkSelector → 测速选择 direct/proxy
3. ModelFetcher → 分页拉取 /v1/models → 获取全量模型列表
4. MetaFetcher → 从 Catalog/HuggingFace/本地 KB 获取元数据
5. Categorizer → 关键词匹配将模型归入 9 大类别
6. TestRunner → 按类别并发执行测试用例（KeyRotator + Semaphore + CircuitBreaker）
7. Scorer → 加权评分 + 硬性约束扣分 + 速度加分 → 排名
8. UseCase → 基于结果推断推荐场景标签
9. 持久化 → SQLite (runs + model_results + meta_cache + use_case_cache)
10. 输出 → results.json + scored.json + report.xlsx
```

---

## 3. 技术架构

### 3.1 技术栈详情

| 层级 | 技术 | 说明 |
|------|------|------|
| 运行时 | [Bun](https://bun.sh) v1.1+ | 原生超快启动、极速 fetch 连接池复用、`bun:sqlite` |
| Web 框架 | [Hono](https://hono.dev) v4.1+ | 轻量级 API 驱动 + SSE 实时日志推送 |
| 语言 | TypeScript 5.9+ | 严格模式，ESNext target |
| 数据库 | SQLite (WAL) | 单文件 `history.db`，事务批量写入 |
| Excel 导出 | [exceljs](https://github.com/exceljs/exceljs) v4.4+ | 多 Sheet 报表，自定义格式 |
| YAML 解析 | [yaml](https://github.com/eemeli/yaml) v2.4+ | 配置文件解析 |
| 前端 | 原生 HTML/CSS/JS | 单文件 `static/index.html`，暗色主题 |
| 容器化 | Docker + Docker Compose | 基于 `oven/bun:1.1-slim` |
| CI/CD | GitHub Actions | TypeScript 编译检查 + 测试覆盖率 |

### 3.2 目录结构

```
nim_tester/
├── src/
│   ├── main.ts                    # CLI 入口（顺序执行 Step 1~5）
│   ├── server.ts                  # Hono Web 服务器入口
│   └── tester/
│       ├── types.ts               # 核心 TypeScript 接口
│       ├── cases.ts               # 9 大分类测试用例定义
│       ├── db.ts                  # SQLite DAL 层
│       ├── network.ts             # 网络路径自动诊断
│       ├── model_fetcher.ts       # 模型列表分页拉取
│       ├── metaFetcher.ts         # 元数据爬取同步
│       ├── categorizer.ts         # 智能分组器
│       ├── runner.ts              # 评测跑测控制引擎
│       ├── circuitBreaker.ts      # 熔断器
│       ├── scorer.ts              # 打分与排名算法
│       ├── useCase.ts             # 场景画像决策
│       ├── excelReport.ts         # Excel 报表渲染
│       ├── *.test.ts              # 单元测试文件
├── static/
│   └── index.html                 # Web UI 前端
├── data/
│   ├── model_catalog.json         # 模型元数据目录（运行时生成）
│   ├── local_kb.json              # 本地知识库（可选）
│   └── hf_raw/                    # HuggingFace 原始数据缓存
├── results/                       # 测试结果输出目录
│   └── YYYYMMDD_HHMMSS/
│       ├── results.json           # 原始测试结果
│       ├── scored.json            # 评分结果
│       └── report.xlsx            # Excel 报告
├── config.yaml                    # 主配置文件
├── profiles.json                  # API 档案配置
├── history.db                     # SQLite 历史数据库
├── Dockerfile                     # Docker 构建文件
├── docker-compose.yml             # Docker Compose 配置
├── package.json                   # 依赖描述
├── tsconfig.json                  # TypeScript 配置
├── 启动Docker.bat                  # Windows Docker 一键启动
├── 启动WebUI.bat                   # Windows 本地一键启动
└── .github/workflows/ci.yml       # GitHub Actions CI
```

### 3.3 核心模块说明

#### 3.3.1 KeyRotator（`runner.ts`）

多 API Key 滑动窗口限速轮换器：

- 维护每个 Key 独立的时间戳队列
- `next()` 方法探测所有 Key，选择等待时间最短的可用 Key
- **关键设计**: Sleep 动作在 Semaphore 外执行，保证并发槽不被无效占用
- 支持 NVIDIA 免费层 40 次/分钟/Key 的限速

#### 3.3.2 CircuitBreaker（`circuitBreaker.ts`）

简易熔断器，三种状态：

- `closed`: 正常状态，连续失败计数
- `open`: 熔断状态，拒绝所有请求
- `half-open`: 半开状态，超时后尝试恢复

#### 3.3.3 Scorer（`scorer.ts`）

评分算法：

1. **基础分 (0-90)**: 加权通过率 = (通过用例权重之和 / 总权重) × 90
2. **硬性约束扣分**:
   - `max_context < 32768` → 扣 15 分，Grade 上限 B
   - `avg_tps < 3.0` → 扣 20 分，Grade 上限 C
3. **速度加分 (0-10)**: 以类别内最高 TPS 为基准线性加分
4. **最终分数**: `clamp(base + speed_bonus - penalties, 0, 100)`

#### 3.3.4 UseCase（`useCase.ts`）

智能场景推荐逻辑：

- 根据测试通过项推断能力标签（最多 4 个）
- `avg_tps < 3.0` → 强制覆盖为 "极慢响应"
- `max_context < 32768` → 移除 RAG/Agent/长文档标签，追加警告
- `param_count < 10B && avg_tps > 35` → 追加 "高频实时交互"、"单意图路由"

---

## 4. 迭代开发历史

### 4.1 v1.0.0 主要功能

- 核心评测引擎：并发测试 + Key 轮换 + 限速
- 9 大模型分类支持：通用对话、VLM、推理、代码、嵌入、重排序、图像生成、音频
- 多维评分系统：加权评分 + 硬性约束 + 速度加分
- 智能场景推荐：基于测试结果和元数据推断推荐标签
- SQLite 历史持久化 + 模型元数据缓存
- Excel 报告导出（多 Sheet + 自定义格式）
- Web UI 控制台 + SSE 实时日志
- Docker 容器化部署
- Windows 双击启动脚本

### 4.2 优化历程

| 优先级 | 优化内容 | 状态 |
|--------|---------|------|
| **高** | 多 Key 滑动窗口限速轮换 | ✅ 已完成 |
| **高** | 熔断器（连续失败自动降级） | ✅ 已完成 |
| **高** | 网络自动测速（直连 vs 代理） | ✅ 已完成 |
| **高** | 模型元数据增量同步（Catalog + HuggingFace） | ✅ 已完成 |
| **中** | 元数据本地 KB + 模型 ID 正则解析兜底 | ✅ 已完成 |
| **中** | SQLite WAL 模式 + 事务批量写入 | ✅ 已完成 |
| **中** | SSE 实时日志推送（拦截 console.log/error/warn） | ✅ 已完成 |
| **中** | Profile 多档案管理（保存/切换/删除） | ✅ 已完成 |
| **中** | 历史 Run 对比功能 | ✅ 已完成 |
| **低** | Excel 报告 Grade 颜色编码 | ✅ 已完成 |
| **低** | 使用置信度缓存加速 UI 渲染 | ✅ 已完成 |
| **低** | config.yaml 热重载（文件监听） | ✅ 已完成 |

### 4.3 关键决策

1. **选择 Bun 而非 Node.js**: 利用 Bun 原生 SQLite、极速 fetch、更快的启动时间
2. **选择 Hono 而非 Express**: 更轻量、性能更好、原生支持 SSE
3. **SQLite 而非 PostgreSQL**: 单文件部署，零配置，适合本地/小团队场景
4. **单文件前端**: `static/index.html` 一个文件包含全部 UI，无需构建工具
5. **90+10 评分体系**: 基础分 90（通过率加权）+ 10（速度加分）= 满分 100

---

## 5. 开发指南

### 5.1 环境搭建

**前置要求:**
- [Bun](https://bun.sh) v1.1.0+
- (可选) Docker + Docker Compose

**步骤:**

```bash
# 1. 克隆项目
git clone <repo-url>
cd nim_tester

# 2. 安装依赖
bun install

# 3. 配置 API 密钥
# 编辑 config.yaml，替换 api_keys 中的占位符
vim config.yaml

# 4. 启动 Web UI
bun run server

# 或启动 CLI 模式
bun run start
```

**开发模式（文件监听）:**
```bash
bun run dev
```

**运行测试:**
```bash
bun test              # 运行所有测试
bun test --coverage   # 运行测试 + 覆盖率报告
bun run compile-check # TypeScript 编译检查
```

### 5.2 如何添加测试用例

在 `src/tester/cases.ts` 中，找到对应分类的用例数组，追加新 `TestCase`：

```typescript
// 在 GENERAL_CHAT_CASES 数组末尾追加
{
  name: "T-08 自定义测试用例",
  description: "描述该用例测试什么",
  test: "custom_test",           // 必须唯一，Scorer 根据此匹配权重
  required: false,               // true = 快速扫描模式也运行
  tags: ["chat"],                // 加 "streaming" 标签自动以 SSE 流式拉取
  timeout: 30000,                // 可选，超时毫秒数
  buildPayload: (modelId: string) => ({
    model: modelId,
    messages: [{ role: "user", content: "你的测试 prompt" }],
    max_tokens: 256,
  }),
  parseResult: (resp: any, elapsedMs: number) => {
    // 返回 { success: boolean, content_preview?: string, ... }
    const text = resp.choices?.[0]?.message?.content || "";
    return {
      success: text.includes("期望的关键词"),
      content_preview: text.substring(0, 200),
      test: "custom_test",
    };
  }
}
```

然后在 `scorer.ts` 的 `TEST_WEIGHTS` 中添加权重（总权重 + 速度分 = 100）：

```typescript
const TEST_WEIGHTS: Record<string, number> = {
  // ... 现有权重
  custom_test: 10,  // 新增
};
```

### 5.3 如何修改评分规则

编辑 `src/tester/scorer.ts`：

**修改权重分布:**
```typescript
const TEST_WEIGHTS: Record<string, number> = {
  basic_availability: 30,   // 基础可用性
  chinese_support: 10,      // 中文支持
  tool_calling: 20,         // 工具调用
  // 调整数值，确保总权重 + 10（速度分）= 100
};
```

**修改等级阈值:**
```typescript
const GRADE_MAP: [number, string][] = [
  [85, "S"],  // ≥85 分 → S 级
  [70, "A"],  // ≥70 分 → A 级
  [55, "B"],  // ≥55 分 → B 级
  [40, "C"],  // ≥40 分 → C 级
  [20, "D"],  // ≥20 分 → D 级
  [0, "F"],   // <20 分 → F 级
];
```

**修改硬性约束:**
```typescript
// 上下文限制阈值
if (finalMaxContext !== undefined && finalMaxContext < 32768) {
  score -= 15;           // 扣分值
  grade = "B";           // Grade 上限
}

// 速度限制阈值
if (avg_tps > 0 && avg_tps < 3.0) {
  score -= 20;           // 扣分值
  grade = "C";           // Grade 上限
}
```

### 5.4 如何扩展模型分类

编辑 `config.yaml` 的 `model_categories`：

```yaml
model_categories:
  # 现有分类...
  
  # 新增分类（放在 general_chat 之前）
  custom_category:
    keywords: ["keyword1", "keyword2"]    # 匹配的关键词（不区分大小写）
    exclude_keywords: ["exclude1"]        # 排除的关键词
    description: "自定义分类描述"
```

**分类匹配规则:**
1. 按 `model_categories` 中的顺序从上到下匹配
2. 模型 ID 包含任一 `keywords` 且不包含 `exclude_keywords` 时命中
3. `keywords` 为空数组的分类作为兜底（如 `general_chat`）
4. 新分类需要在 `cases.ts` 中添加对应的测试用例数组，并在 `CATEGORY_CASES` 映射中注册

---

## 6. API 文档

### 6.1 REST API 列表

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/` | 返回 Web UI 静态页面 |
| `GET` | `/api/config` | 获取当前配置 |
| `GET` | `/api/profiles` | 获取所有 API 档案 |
| `POST` | `/api/profiles` | 创建/更新 API 档案 |
| `DELETE` | `/api/profiles/:name` | 删除指定档案 |
| `GET` | `/api/results` | 获取当前运行结果 |
| `GET` | `/api/history` | 获取历史运行列表（最近 20 条） |
| `GET` | `/api/history/:runId` | 获取指定运行的详细结果 |
| `GET` | `/api/compare/:runId1/:runId2` | 对比两次运行的差异 |
| `GET` | `/api/catalog/stats` | 获取模型目录统计信息 |
| `GET` | `/api/export/excel` | 导出最新 Excel 报告 |
| `GET` | `/api/export/excel/:runId` | 导出指定运行的 Excel 报告 |
| `GET` | `/api/events` | SSE 实时日志/事件流 |
| `POST` | `/api/run` | 启动新一轮测试 |

### 6.2 请求/响应格式

#### POST /api/run - 启动测试

**请求体（可选字段）:**
```json
{
  "api_keys": ["key1", "key2"],
  "base_url": "https://integrate.api.nvidia.com/v1",
  "proxy": "http://127.0.0.1:7897",
  "concurrency": 10,
  "required_only": false,
  "rate_limit_per_key": 40
}
```

**响应:**
```json
{ "ok": true }
```

#### GET /api/history - 历史列表

**响应:**
```json
{
  "ok": true,
  "runs": [
    {
      "run_id": "abc123def456",
      "profile": "NVIDIA",
      "base_url": "https://integrate.api.nvidia.com/v1",
      "started_at": "2026-05-19T09:51:27",
      "finished_at": "2026-05-19T10:15:42",
      "model_count": 85,
      "config_json": "..."
    }
  ]
}
```

#### GET /api/compare/:runId1/:runId2 - 对比运行

**响应:**
```json
{
  "ok": true,
  "comparison": {
    "run1": "abc123",
    "run2": "def456",
    "diffs": [
      {
        "model_id": "nvidia/llama-3.1-nemotron-70b-instruct",
        "category": "general_chat",
        "score_before": 82.5,
        "score_after": 85.2,
        "score_diff": 2.7,
        "tps_before": 45.2,
        "tps_after": 48.1,
        "tps_diff": 2.9
      }
    ]
  }
}
```

#### GET /api/events - SSE 事件流

**事件类型:**
```json
{ "type": "step", "step": 1, "label": "自动测速..." }
{ "type": "step_done", "step": 1, "label": "最优路径: direct（285ms）" }
{ "type": "groups", "groups": { "general_chat": { "count": 30, "desc": "通用对话模型" } } }
{ "type": "model_done", "model_id": "...", "category": "general_chat", "passed": 5, "total": 7, "done": 1, "total_models": 85 }
{ "type": "log", "level": "info", "msg": "..." }
{ "type": "complete", "scored": {...}, "out_dir": "results/20260519_095127", "run_id": "abc123" }
{ "type": "error", "msg": "..." }
```

### 6.3 错误码

| HTTP 状态码 | 含义 |
|------------|------|
| 200 | 成功 |
| 400 | 请求参数无效 |
| 404 | 资源不存在（如无历史报告） |
| 500 | 服务器内部错误 |

**JSON 错误响应格式:**
```json
{ "ok": false, "msg": "错误描述信息" }
```

---

## 7. 配置说明

### 7.1 config.yaml 完整字段说明

```yaml
# ─── 接口配置 ──────────────────────────────────────────────────────────────────
api:
  base_url: "https://integrate.api.nvidia.com/v1"    # API 基础 URL
  models_endpoint: "/models"                          # 模型列表端点
  chat_endpoint: "/chat/completions"                  # 对话补全端点
  embeddings_endpoint: "/embeddings"                  # 嵌入端点

# ─── API 密钥列表 ──────────────────────────────────────────────────────────────
api_keys:
  - "YOUR_NVIDIA_API_KEY_HERE"    # 支持多个 Key，自动滑动窗口轮换

# ─── 网络配置 ──────────────────────────────────────────────────────────────────
network:
  proxy: "http://127.0.0.1:7897"      # 代理地址，留空不使用代理
  timeout: 30                          # 请求超时（秒）
  latency_test_count: 3                # 延迟测试次数（取平均值）
  auto_select: true                    # true=自动测速选最优；false=强制使用 force_mode
  force_mode: "direct"                 # direct | proxy（仅 auto_select=false 时生效）

# ─── 测试行为配置 ─────────────────────────────────────────────────────────────
testing:
  concurrency: 10                      # 并发测试数量
  retry_count: 2                       # 失败重试次数（共 N+1 次机会）
  request_interval: 0.2                # 请求间隔（秒）
  output_dir: "./results"              # 测试结果输出目录
  save_json: true                      # 保存 JSON 原始结果
  save_excel: true                     # 保存 Excel 报告
  required_only: false                 # true=只跑必选用例（快速扫描）；false=全量测试
  rate_limit_per_key: 40               # 每个 API Key 每分钟最大请求数（0=不限速）
  rate_limit_window: 60                # 限速窗口（秒）
  circuit_breaker_threshold: 5         # 熔断器触发阈值（连续失败次数）
  circuit_breaker_reset_timeout: 30000 # 熔断器重置超时（毫秒）

# ─── 模型分组规则 ──────────────────────────────────────────────────────────────
model_categories:
  text_embedding:
    keywords: ["embed", "embedding", "e5-", "bge-", "gte-", "minilm", "nv-embed"]
    description: "文本嵌入模型"
  multimodal_embedding:
    keywords: ["clip", "visual-embed", "image-embed", "vlm-embed", "nv-clip"]
    description: "图文嵌入模型"
  reranker:
    keywords: ["rerank", "cross-encoder", "nv-rerank"]
    description: "重排序模型"
  vision_language:
    keywords: ["vision", "vlm", "llava", "visual", "-vl-", "multimodal", ...]
    description: "视觉语言模型（VLM）"
  image_generation:
    keywords: ["stable-diffusion", "sdxl", "flux", "dall-e", "imagen", ...]
    description: "图像生成模型"
  audio:
    keywords: ["whisper", "tts", "speech", "audio", "asr", "voice"]
    description: "语音/音频模型"
  code:
    keywords: ["code", "codex", "starcoder", "deepseek-coder", ...]
    description: "代码专用模型"
  reasoning:
    keywords: ["o1", "o3", "r1", "qwq", "deepseek-r", "think", "reason"]
    description: "推理/思维链模型"
  general_chat:
    keywords: []                       # 兜底分类
    description: "通用对话模型"
```

### 7.2 环境变量

本项目**不使用环境变量**，所有配置通过 `config.yaml` 和 `profiles.json` 管理。

---

## 8. 部署指南

### 8.1 Docker 部署（推荐）

**一键启动:**
```bash
# Windows 用户：双击 启动Docker.bat
# Linux/Mac 用户：
docker compose up -d --build
```

**手动操作:**
```bash
# 构建镜像
docker compose build

# 启动服务
docker compose up -d

# 查看日志
docker compose logs -f

# 停止服务
docker compose down
```

**Docker Compose 挂载说明:**
- `./config.yaml` → `/app/config.yaml` (配置文件)
- `./profiles.json` → `/app/profiles.json` (API 档案)
- `./history.db` → `/app/history.db` (历史数据库)
- `./results` → `/app/results` (测试结果)

服务运行在 `http://localhost:28080`。

### 8.2 本地部署

```bash
# 安装依赖
bun install

# 启动 Web UI（推荐）
bun run server

# 或启动 CLI 模式
bun run start
```

**Windows 一键启动:**
- 双击 `启动WebUI.bat` → 自动检测依赖、安装、启动、打开浏览器
- 双击 `启动Docker.bat` → 自动构建并启动 Docker 容器

### 8.3 生产环境建议

1. **API Keys 安全**: 不要将真实的 API Keys 提交到 Git，使用 `profiles.json` 在 Web UI 中管理
2. **反向代理**: 生产环境建议在前面加 Nginx/Caddy 做反向代理和 HTTPS 终结
3. **数据库备份**: 定期备份 `history.db` 文件
4. **并发控制**: 根据 API 额度调整 `testing.concurrency` 和 `rate_limit_per_key`
5. **监控**: 关注熔断器状态和 429 限速日志
6. **资源限制**: Docker 部署时建议设置内存限制（`deploy.resources.limits.memory`）

---

## 9. 故障排查

### 9.1 常见问题

| 问题 | 可能原因 | 解决方案 |
|------|---------|---------|
| `网络不可达` | 直连和代理均无法访问 API | 检查网络连接、代理配置、API Key 有效性 |
| `429 Too Many Requests` | 超出 API 限速 | 增加 `rate_limit_window`、减少 `concurrency`、增加 API Key 数量 |
| `404/422` | 模型不支持该 API 端点 | 该用例自动标记为 skip，不影响其他用例 |
| `Timeout` | 模型响应过慢 | 增加 `testing.timeout` 或 `network.timeout` |
| `熔断器已开启` | 连续失败次数超阈值 | 等待 `circuit_breaker_reset_timeout` 后自动恢复 |
| Excel 生成失败 | exceljs 写入异常 | 检查磁盘空间，结果仍会保存为 JSON |
| DB 持久化失败 | SQLite 锁或磁盘问题 | 不影响主流程，检查 `history.db` 文件权限 |
| 配置未加载 | `config.yaml` 格式错误 | 检查 YAML 语法，重启服务 |
| 模型分类为空 | 关键词匹配不到 | 检查 `config.yaml` 中 `model_categories` 的关键词 |

### 9.2 日志说明

**控制台日志级别:**
- `[INFO]` → 一般信息（测试进度、模型完成状态）
- `[WARN]` → 譜告（Excel 生成失败等非致命问题）
- `[ERROR]` → 错误（网络异常、API 错误、DB 失败）

**SSE 日志事件:**
- `type: "log"` → 包含 `level` (info/error/warning) 和 `msg`
- `type: "step"` → 测试步骤开始
- `type: "step_done"` → 测试步骤完成
- `type: "model_done"` → 单个模型测试完成
- `type: "error"` → 流程异常

**常见日志模式:**
```
[限速] Key xxxxxxxx 等待 1.5s          ← KeyRotator 限速等待
[熔断] 连续失败 5 次，熔断器已开启      ← CircuitBreaker 触发
[HF] model-id fetch failed: timeout    ← HuggingFace 元数据获取失败
[META] catalog 增量更新：新增 3 个模型  ← 元数据目录更新
```

---

## 10. 贡献指南

### 10.1 代码规范

- **语言**: TypeScript 严格模式 (`strict: true`)
- **运行时**: Bun，使用 `bun:sqlite` 而非第三方 SQLite 库
- **模块系统**: ES Modules，使用 `.ts` 扩展名导入
- **命名**: 文件名 `camelCase.ts`，类名 `PascalCase`，常量 `UPPER_SNAKE_CASE`
- **注释**: 不添加不必要的注释，代码即文档
- **错误处理**: 内部代码信任框架保证，仅在系统边界做验证
- **依赖**: 优先使用 Bun 内置 API（如 `bun:sqlite`、`Bun.file()`）

### 10.2 提交规范

本项目使用 **Conventional Commits** 规范：

```
<type>(<scope>): <description>

[optional body]

[optional footer]
```

**Type 类型:**
| 类型 | 说明 |
|------|------|
| `feat` | 新功能 |
| `fix` | Bug 修复 |
| `refactor` | 重构（不改变外部行为） |
| `perf` | 性能优化 |
| `test` | 测试相关 |
| `docs` | 文档更新 |
| `chore` | 构建/工具链变更 |

**Scope 范围:**
`server`, `runner`, `scorer`, `cases`, `db`, `network`, `meta`, `ui`, `docker`

**示例:**
```
feat(scorer): 添加速度加分机制
fix(runner): 修复 KeyRotator 在锁外 sleep 的竞态条件
refactor(db): 使用事务批量写入替代逐条插入
test(cases): 添加 VLM 多图输入测试用例
```

**CI 要求:**
- `bun run compile-check` 必须通过
- `bun test --coverage` 覆盖率 ≥ 65%
- 所有现有测试必须通过

---

## 附录

### A. 数据库表结构

#### `runs` 表
| 字段 | 类型 | 说明 |
|------|------|------|
| id | INTEGER | 自增主键 |
| run_id | TEXT | 12 位唯一随机字符串 |
| profile | TEXT | 使用的配置档案名称 |
| base_url | TEXT | API 端点 |
| started_at | TEXT | 开始时间 |
| finished_at | TEXT | 结束时间 |
| model_count | INTEGER | 测试模型数量 |
| config_json | TEXT | 运行时 config 快照 |

#### `model_results` 表
| 字段 | 类型 | 说明 |
|------|------|------|
| id | INTEGER | 自增主键 |
| run_id | TEXT | 外键 → runs.run_id |
| model_id | TEXT | 模型 ID |
| category | TEXT | 模型分类 |
| score | REAL | 综合评分 |
| grade | TEXT | 评级 (S/A/B/C/D/F) |
| rank | INTEGER | 组内排名 |
| avg_tps | REAL | 平均吞吐率 |
| passed | INTEGER | 通过用例数 |
| total | INTEGER | 总用例数 |
| use_cases | TEXT | 推荐场景 JSON |
| meta_json | TEXT | 元数据 JSON |
| results_json | TEXT | 详细测试结果 JSON |

#### `model_meta_cache` 表
| 字段 | 类型 | 说明 |
|------|------|------|
| model_id | TEXT | 主键 |
| hf_pipeline_tag | TEXT | HuggingFace pipeline 标签 |
| release_date | TEXT | 发布日期 |
| param_count | REAL | 参数量（B） |
| active_params | REAL | 激活参数量（MoE） |
| max_context | INTEGER | 最大上下文长度 |
| embed_dim | INTEGER | 嵌入维度 |
| description | TEXT | 模型描述 |
| fetched_at | TEXT | 数据同步时间戳 |
| raw_json | TEXT | 原始 JSON |

#### `use_case_cache` 表
| 字段 | 类型 | 说明 |
|------|------|------|
| model_id | TEXT | 联合主键 |
| category | TEXT | 联合主键 |
| use_cases | TEXT | 推荐场景 JSON |
| confidence | INTEGER | 置信度计数 |
| updated_at | TEXT | 更新时间 |

### B. 评分权重总表

| 测试用例 | 权重 | 分类 |
|---------|------|------|
| basic_availability | 30 | general_chat |
| chinese_support | 10 | general_chat |
| tool_calling | 20 | general_chat / reasoning / code |
| streaming | 10 | general_chat |
| think_on | 8 | general_chat |
| think_off | 4 | general_chat |
| long_context | 8 | general_chat |
| code_generation | 30 | code |
| code_completion | 15 | code |
| code_debugging | 30 | code |
| code_explanation | 15 | code |
| basic_embedding | 40 | text_embedding |
| batch_embedding | 30 | text_embedding |
| query_embedding | 30 | text_embedding |
| vlm_image_understanding | 30 | vision_language |
| multi_image | 15 | vision_language |
| basic_rerank | 100 | reranker |
| text2image | 100 | image_generation |
| basic | 20 | reasoning |
| math_reasoning | 30 | reasoning |
| cot_output | 30 | reasoning |
| logic_puzzle | 20 | reasoning |
| text_via_clip | 50 | multimodal_embedding |
| image_via_clip | 50 | multimodal_embedding |
| tts | 100 | audio |

> **注**: 每个分类的基础分为 90 分（加权通过率），另外 10 分来自速度加分，总分上限 100 分。

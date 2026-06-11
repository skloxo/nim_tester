# API 模型测试平台 (NIM Tester)

基于 **Bun + Hono + SQLite** 构建的高性能 API 模型评测框架，专为评估 NVIDIA NIM 及 OpenAI 兼容接口的大模型（LLM、VLM、Embedding、Reranker、TTS 等）设计。支持并发测速、多维自动评分、场景智能推荐以及 Excel 报告一键导出。

---

## 核心功能

| 功能 | 说明 |
|------|------|
| **9 大模型分类测试** | 自动识别并测试：通用对话、视觉语言、推理/思维链、代码、文本嵌入、图文嵌入、重排序、图像生成、语音音频 |
| **智能评分系统** | 加权通过率 + 速度加分，输出 S/A/B/C/D/F 六级评级，含硬性约束扣分 |
| **场景推荐引擎** | 根据参数量、TPS、上下文等自动推荐适用场景（AI Agent、RAG、高频交互等） |
| **网络自动诊断** | 自动测速选择 Direct/Proxy 最优路径，多 Key 滑动窗口限速轮换 |
| **Excel 报告导出** | 多 Sheet 报表，含总览排序、分类详情、测试用例耗时 |
| **历史对比** | SQLite 持久化存储，支持多次运行结果对比 |
| **Web 控制台** | SSE 实时日志推送，一键启动测试、导出报告 |
| **Docker 部署** | 一键容器化部署，数据持久化到宿主机 |

---

## 快速开始

### 方式一：Docker 模式（推荐）

```bash
# 启动服务（自动构建镜像）
docker compose up -d

# 访问控制台
# http://localhost:28080

# 停止服务
docker compose down
```

Docker 模式下，配置文件、数据库和测试结果自动挂载到宿主机，容器重启不丢失数据。

### 方式二：本地模式

```bash
# 安装依赖
bun install

# 启动 Web 服务
bun run server

# 或使用开发模式（自动重载）
bun run dev

# 访问控制台
# http://localhost:28080
```

### 方式三：CLI 模式

```bash
# 直接在命令行运行完整评测流程
bun run start
```

---

## 配置说明

配置文件为项目根目录下的 `config.yaml`：

### API 密钥

```yaml
api_keys:
  - "nvapi-YOUR_KEY_1"
  - "nvapi-YOUR_KEY_2"
```

支持多个密钥，程序自动轮换。NVIDIA 免费层每个 Key 限速 40次/分钟，系统会自动限速避让。

### API 端点

```yaml
api:
  base_url: "https://integrate.api.nvidia.com/v1"
  models_endpoint: "/models"
  chat_endpoint: "/chat/completions"
  embeddings_endpoint: "/embeddings"
```

### 网络代理

```yaml
network:
  proxy: "http://127.0.0.1:7897"
  timeout: 30
  auto_select: true          # true = 自动测速选最优路径
  force_mode: "direct"       # direct | proxy（auto_select=false 时生效）
```

### 并发与限速

```yaml
testing:
  concurrency: 10            # 并发测试数量
  retry_count: 2             # 失败重试次数（共 3 次机会）
  request_interval: 0.2      # 请求间隔（秒）
  rate_limit_per_key: 40     # 每个 Key 每分钟最大请求数
  required_only: false       # true = 只跑必选用例（快速扫描）
```

### 网页端配置

打开 `http://localhost:28080`，在顶部「API 档案」板块可直接粘贴密钥并保存，支持多个档案切换。

---

## 评测维度

### 评分规则

总分 = **90 分基础分（加权通过率）** + **10 分速度加分**，满分 100。

| 评级 | 分数范围 |
|------|----------|
| S | 85 - 100 |
| A | 70 - 84 |
| B | 55 - 69 |
| C | 40 - 54 |
| D | 20 - 39 |
| F | 0 - 19 |

### 硬性约束

| 约束条件 | 扣分 | 评级上限 |
|----------|------|----------|
| 最大上下文 < 32K | -15 分 | B 级 |
| 平均 TPS < 3.0 | -20 分 | C 级 |

### 各分类测试用例权重

**通用对话 / 视觉语言 / 推理**

| 测试项 | 权重 | 说明 |
|--------|------|------|
| basic_availability | 30 | 基础可用性 |
| tool_calling | 20 | Function Calling 支持 |
| chinese_support | 10 | 中文能力 |
| streaming | 10 | 流式输出 |
| think_on / think_off | 8 / 4 | 思维链开关 |
| long_context | 8 | 长上下文 |

**代码模型**

| 测试项 | 权重 |
|--------|------|
| code_generation | 30 |
| code_debugging | 30 |
| code_completion | 15 |
| code_explanation | 15 |

**嵌入 / 重排 / 图像生成 / 语音**

| 测试项 | 权重 |
|--------|------|
| basic_embedding / batch_embedding / query_embedding | 40 / 30 / 30 |
| basic_rerank | 100 |
| text2image | 100 |
| tts | 100 |

---

## API 文档

服务启动后暴露以下 HTTP 接口（端口 `28080`）：

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/config` | 获取当前配置 |
| `POST` | `/api/run` | 启动一轮评测（异步） |
| `GET` | `/api/results` | 获取最近一次运行的评分结果 |
| `GET` | `/api/events` | SSE 实时日志流（`?since=N` 增量拉取） |
| `GET` | `/api/history` | 获取历史运行记录（最近 20 条） |
| `GET` | `/api/history/:runId` | 获取指定运行的详细结果 |
| `GET` | `/api/compare/:runId1/:runId2` | 对比两次运行结果 |
| `GET` | `/api/export/excel` | 下载最近一次 Excel 报告 |
| `GET` | `/api/export/excel/:runId` | 下载指定运行的 Excel 报告 |
| `GET/POST/DELETE` | `/api/profiles` | 管理 API 档案 |

### 示例：启动测试

```bash
# 使用默认配置启动
curl -X POST http://localhost:28080/api/run

# 覆盖配置启动
curl -X POST http://localhost:28080/api/run \
  -H "Content-Type: application/json" \
  -d '{
    "api_keys": ["nvapi-xxx"],
    "concurrency": 5,
    "required_only": true
  }'
```

### 示例：获取结果

```bash
curl http://localhost:28080/api/results
```

---

## 开发指南

### 添加测试用例

在 `src/tester/cases.ts` 中按分类添加 `TestCase` 对象：

```typescript
const myTestCase: TestCase = {
  name: "T-XX 我的测试",
  description: "测试模型某项能力",
  test: "my_test",           // 唯一标识符，用于 scorer 权重映射
  required: true,            // true = 必选，false = 可选
  tags: ["tag1", "tag2"],
  buildPayload: (modelId: string) => ({
    model: modelId,
    messages: [{ role: "user", content: "测试提示词" }],
    max_tokens: 256,
  }),
  parseResult: (resp: any, elapsedMs: number) => ({
    test: "my_test",
    success: !!resp?.choices?.[0]?.message?.content,
    // ... 解析逻辑
  }),
};
```

然后在对应分类的 `getCasesForCategory()` 返回值中添加该用例。

### 修改评分权重

在 `src/tester/scorer.ts` 的 `TEST_WEIGHTS` 中添加或修改权重：

```typescript
export const TEST_WEIGHTS: Record<string, number> = {
  basic_availability: 30,
  my_test: 25,           // 新增权重
  // ...
};
```

### 添加场景推荐

在 `src/tester/useCase.ts` 的 `inferUseCases()` 中为对应分类添加推荐逻辑。

### 项目结构

```
src/
├── main.ts                 # CLI 入口
├── server.ts               # Hono Web 服务器
└── tester/
    ├── types.ts            # 类型定义
    ├── cases.ts            # 测试用例定义
    ├── db.ts               # SQLite 数据层
    ├── network.ts          # 网络路径诊断
    ├── model_fetcher.ts    # 模型列表拉取
    ├── metaFetcher.ts      # 元数据同步
    ├── categorizer.ts      # 模型智能分组
    ├── runner.ts           # 评测执行引擎
    ├── scorer.ts           # 评分与排名
    ├── useCase.ts          # 场景推荐
    └── excelReport.ts      # Excel 报表生成
```

---

## 技术栈

| 组件 | 技术 | 说明 |
|------|------|------|
| 运行时 | [Bun](https://bun.sh) | 极速启动、原生 fetch、内置 SQLite |
| Web 框架 | [Hono](https://hono.dev) | 轻量级、SSE 流式支持 |
| 数据库 | SQLite (WAL 模式) | 单文件持久化，高并发读写 |
| 报表 | [exceljs](https://github.com/exceljs/exceljs) | 多 Sheet Excel 生成 |
| 前端 | 原生 HTML/JS | 单文件 Web 控制台 |
| 部署 | Docker Compose | 一键容器化，数据挂载 |

---

## 许可证

[MIT License](LICENSE) - Copyright (c) 2026 skloxo

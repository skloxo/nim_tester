# nim_tester 项目经验总结

## 1. 项目开发经验

### TypeScript + Bun 的优势
- **极速启动**：Bun 的冷启动时间远优于 Node.js，开发体验流畅
- **原生 TypeScript**：无需编译步骤，直接运行 .ts 文件
- **内置工具链**：测试、打包、包管理一体化
- **兼容性**：大多数 Node.js API 兼容，迁移成本低

### SQLite WAL 模式的重要性
```typescript
// 必须在连接时启用 WAL 模式
db.exec('PRAGMA journal_mode=WAL');
```
- 支持并发读写，避免锁竞争
- 显著提升并发场景性能
- 测试环境也应启用以保证一致性

### 并发控制的最佳实践
- 使用 `Promise.allSettled` 替代 `Promise.all` 处理部分失败
- 限制并发数量避免资源耗尽
- 使用信号量（Semaphore）控制同时执行的任务数

### API 限速处理策略
- 实现滑动窗口限速器
- 根据 API 文档设置合理阈值
- 实现指数退避重试机制

## 2. 踩坑记录

### SQLite 数据库锁问题（测试环境）
**问题**：测试并行执行时出现 `SQLITE_BUSY` 错误
**解决方案**：
1. 每个测试使用独立的内存数据库 `:memory:`
2. 启用 WAL 模式
3. 设置合理的 busy_timeout

### CI 覆盖率计算差异
**问题**：本地覆盖率与 CI 环境不一致
**原因**：
- 测试文件被计入覆盖率统计
- 不同平台路径处理差异
**解决方案**：
```json
{
  "coverage": {
    "include": ["src/**"],
    "exclude": ["**/*.test.ts", "**/node_modules/**"]
  }
}
```

### AbortController 在 Bun 中的使用
**问题**：某些场景下 AbortController 未按预期工作
**解决方案**：
- 使用 `AbortSignal.timeout()` 替代手动创建
- 确保在异步操作开始前设置信号

### Prepared statements 缓存
**问题**：频繁创建 Prepared Statement 影响性能
**解决方案**：
```typescript
// 缓存 prepared statement
const stmtCache = new Map<string, Statement>();

function getCachedStmt(db: Database, sql: string): Statement {
  if (!stmtCache.has(sql)) {
    stmtCache.set(sql, db.prepare(sql));
  }
  return stmtCache.get(sql)!;
}
```

## 3. 性能优化经验

### 并发竞态的发现和修复
**问题**：多个异步操作同时修改共享状态导致数据不一致
**解决方案**：
1. 使用 Mutex 保护共享资源
2. 实现乐观锁机制
3. 缩小临界区范围

### 滑动窗口限速算法
```typescript
class SlidingWindowRateLimiter {
  private windows: Map<string, number[]> = new Map();
  
  constructor(
    private maxRequests: number,
    private windowMs: number
  ) {}
  
  isAllowed(key: string): boolean {
    const now = Date.now();
    const window = this.windows.get(key) || [];
    const validWindow = window.filter(t => now - t < this.windowMs);
    
    if (validWindow.length >= this.maxRequests) {
      return false;
    }
    
    validWindow.push(now);
    this.windows.set(key, validWindow);
    return true;
  }
}
```

### 熔断器模式应用
- 快速失败避免级联故障
- 自动恢复机制
- 状态转换：Closed → Open → Half-Open

## 4. 代码质量经验

### 类型安全的重要性
```typescript
// 使用严格的类型定义
interface TestResult {
  readonly success: boolean;
  readonly duration: number;
  readonly error?: string;
}

// 使用 branded types 避免类型混淆
type TestId = string & { readonly __brand: unique symbol };
```

### 公共函数抽取
- 识别重复代码模式
- 提取到共享工具模块
- 保持函数职责单一

### 配置外置
```typescript
// 使用环境变量 + 默认值
const config = {
  dbPath: process.env.DB_PATH || ':memory:',
  maxConcurrency: parseInt(process.env.MAX_CONCURRENCY || '5'),
  rateLimit: parseInt(process.env.RATE_LIMIT || '100'),
};
```

## 5. CI/CD 经验

### GitHub Actions 配置
```yaml
name: CI
on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v1
      - run: bun install
      - run: bun test
      - run: bun run coverage
```

### 覆盖率阈值设置
- 设置合理的最低覆盖率（如 80%）
- 对关键模块设置更高阈值
- 使用 coverage thresholds 阻止低质量代码合并

### 测试隔离（内存数据库）
```typescript
// 每个测试使用独立数据库
let db: Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec('PRAGMA journal_mode=WAL');
});

afterEach(() => {
  db.close();
});
```

## 6. 总结

本项目的核心经验：
1. **类型安全**是长期可维护性的基础
2. **测试隔离**是并行测试的关键
3. **限速和熔断**是调用外部API的必备机制
4. **WAL模式**是SQLite并发的正确选择
5. **配置外置**使部署更灵活

---

*最后更新：2026-06-12*
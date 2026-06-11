import type { TestCase, ModelResult } from "./types.ts";
import { getCases } from "./cases.ts";
import { NetworkSelector } from "./network.ts";
import { CircuitBreaker } from "./circuitBreaker.ts";

export class HTTPStatusError extends Error {
  constructor(public status: number, message: string, public headers?: Headers) {
    super(message);
    this.name = "HTTPStatusError";
  }
}

/**
 * 线程安全的 API 密钥轮换器（带滑动窗口限速）
 */
export class KeyRotator {
  private keys: string[];
  private idx = 0;
  private rateLimit: number; // 每 key 每 window 秒最多请求次数，0 表示不限
  private window: number; // 限速窗口（秒）
  private timestamps = new Map<string, number[]>();

  constructor(keys: string[], rateLimit = 0, window = 60) {
    this.keys = keys.map((k) => k.trim()).filter((k) => k !== "");
    this.rateLimit = rateLimit;
    this.window = window;
    for (const key of this.keys) {
      this.timestamps.set(key, []);
    }
  }

  private availableWait(key: string, now: number): number {
    if (!this.rateLimit) {
      return 0.0;
    }
    const q = this.timestamps.get(key);
    if (!q) {
      return 0.0;
    }
    // 清理窗口外的时间戳
    while (q.length > 0 && now - q[0]! >= this.window) {
      q.shift();
    }
    if (q.length < this.rateLimit) {
      return 0.0;
    }
    // 返回需要等待的秒数
    return this.window - (now - q[0]!) + 0.01;
  }

  private selectKey(): [string, number] {
    const n = this.keys.length;
    if (n === 0) {
      throw new Error("No API keys configured");
    }
    let minWait = Infinity;
    let bestKey = "";
    let bestOffset = 0;
    const now = performance.now() / 1000;

    for (let i = 0; i < n; i++) {
      const key = this.keys[(this.idx + i) % n]!;
      const wait = this.availableWait(key, now);
      if (wait === 0.0) {
        bestKey = key;
        bestOffset = i;
        minWait = 0.0;
        break;
      }
      if (wait < minWait) {
        minWait = wait;
        bestKey = key;
        bestOffset = i;
      }
    }

    // 推进轮询索引（无论是否需要等待都要推进）
    this.idx = (this.idx + bestOffset + 1) % n;

    // 记录时间戳
    if (this.rateLimit && bestKey) {
      const q = this.timestamps.get(bestKey);
      if (q) {
        q.push(now);
      }
    }

    return [bestKey, minWait];
  }

  /**
   * 返回下一个可用的 API Key（在锁外 sleep，避免阻塞其他协程）
   */
  async next(): Promise<string> {
    const [key, wait] = this.selectKey();
    if (wait > 0) {
      console.log(`  [限速] Key ${key.slice(-8)} 等待 ${wait.toFixed(1)}s`);
      await new Promise((resolve) => setTimeout(resolve, wait * 1000));
    }
    return key;
  }
}

/**
 * 简易并发控制信号量
 */
export class Semaphore {
  private activeCount = 0;
  private queue: (() => void)[] = [];

  constructor(private maxConcurrency: number) {}

  async acquire(): Promise<void> {
    if (this.activeCount < this.maxConcurrency) {
      this.activeCount++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    if (this.queue.length > 0) {
      const next = this.queue.shift();
      if (next) {
        next();
      }
    } else {
      this.activeCount--;
    }
  }
}

export class TestRunner {
  private config: any;
  private mode: string;
  private baseUrl: string;
  private chatEp: string;
  private embedEp: string;
  private concurrency: number;
  private retry: number;
  private interval: number;
  private requiredOnly: boolean;
  private progressCallback?: (results: ModelResult[]) => Promise<void> | void;
  private rotator: KeyRotator;
  private selector: NetworkSelector;
  private sem: Semaphore;
  private breaker: CircuitBreaker;

  constructor(config: any, mode: string, progressCallback?: (results: ModelResult[]) => Promise<void> | void) {
    this.config = config;
    this.mode = mode;
    this.baseUrl = (config.api?.base_url || "").replace(/\/+$/, "");
    this.chatEp = config.api?.chat_endpoint || "";
    this.embedEp = config.api?.embeddings_endpoint || "";
    this.concurrency = config.testing?.concurrency || 5;
    this.retry = config.testing?.retry_count || 2;
    this.interval = config.testing?.request_interval || 1;
    this.requiredOnly = !!config.testing?.required_only;
    this.progressCallback = progressCallback;

    const rateLimit = config.testing?.rate_limit_per_key || 0;
    const rateWindow = config.testing?.rate_limit_window || 60;
    this.rotator = new KeyRotator(config.api_keys || [], rateLimit, rateWindow);
    this.selector = new NetworkSelector(config);
    this.sem = new Semaphore(this.concurrency);
    this.breaker = new CircuitBreaker(
      config.testing?.circuit_breaker_threshold || 5,
      config.testing?.circuit_breaker_reset_timeout || 30000,
    );
  }

  private resolveEndpoint(category: string): string {
    const epMap: Record<string, string> = {
      text_embedding: this.embedEp,
      multimodal_embedding: this.embedEp,
      reranker: "/reranking",
      image_generation: "/images/generations",
      audio: "/audio/speech",
    };
    return epMap[category] || this.chatEp;
  }

  private async doRequest(
    url: string,
    payload: any,
    headers: Record<string, string>,
    streaming: boolean,
    clientKwargs: any
  ): Promise<[any, number]> {
    const t0 = performance.now();

    const options: any = {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      ...clientKwargs,
    };

    const resp = await fetch(url, options);
    if (resp.status >= 400) {
      throw new HTTPStatusError(resp.status, `HTTP error! status: ${resp.status}`, resp.headers);
    }

    if (streaming) {
      if (!resp.body) {
        throw new Error("No response body for streaming");
      }
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const chunks: string[] = [];
      let ttftMs: number | null = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith("data: ") && trimmed !== "data: [DONE]") {
            if (ttftMs === null) {
              ttftMs = performance.now() - t0;
            }
            chunks.push(trimmed.slice(6));
          }
        }
      }
      if (buffer) {
        const trimmed = buffer.trim();
        if (trimmed.startsWith("data: ") && trimmed !== "data: [DONE]") {
          if (ttftMs === null) {
            ttftMs = performance.now() - t0;
          }
          chunks.push(trimmed.slice(6));
        }
      }

      const elapsed = performance.now() - t0;
      return [
        {
          success: chunks.length > 0,
          elapsed_ms: Math.round(elapsed),
          ttft_ms: ttftMs ? Math.round(ttftMs) : null,
          chunk_count: chunks.length,
        },
        elapsed,
      ];
    } else {
      const contentType = resp.headers.get("content-type") || "";
      let data: any;
      if (contentType.includes("json")) {
        data = await resp.json();
      } else {
        const arrayBuffer = await resp.arrayBuffer();
        data = new Uint8Array(arrayBuffer);
      }
      const elapsed = performance.now() - t0;
      return [data, elapsed];
    }
  }

  private async runSingleCase(
    model: any,
    category: string,
    caseItem: TestCase,
    clientKwargs: any
  ): Promise<ModelResult> {
    const modelId = model.id || model.model_id || "";
    const ep = this.resolveEndpoint(category);
    const url = `${this.baseUrl}${ep}`;
    const streaming = caseItem.tags.includes("streaming");

    for (let attempt = 0; attempt <= this.retry; attempt++) {
      try {
        if (attempt > 0) {
          await new Promise((resolve) => setTimeout(resolve, this.interval * attempt * 1000));
        }

        // Key 轮换选择（锁外/Semaphore 外）
        const apiKey = await this.rotator.next();

        // 仅在 HTTP 请求执行段申请并发 Semaphore，保持 sleep 独立
        await this.sem.acquire();
        let raw: any;
        let elapsed = 0.0;
        try {
          const [resData, elapsedMs] = await this.breaker.execute(async () => {
            const headers: Record<string, string> = {
              "Authorization": `Bearer ${apiKey}`,
              "Content-Type": "application/json",
              "Accept": streaming ? "text/event-stream" : "application/json",
            };
            const payload = caseItem.buildPayload(modelId);
            return this.doRequest(url, payload, headers, streaming, clientKwargs);
          });
          raw = resData;
          elapsed = elapsedMs;
        } finally {
          this.sem.release();
        }

        const parsed = caseItem.parseResult(raw, elapsed);
        const result: ModelResult = {
          model_id: modelId,
          category,
          case_name: caseItem.name,
          test: caseItem.test,
          status: parsed.success ? "pass" : "fail",
          success: !!parsed.success,
          elapsed_ms: Math.round(elapsed),
          ...parsed,
        };
        return result;
      } catch (e: any) {
        if (e instanceof HTTPStatusError) {
          const status = e.status;
          if (status === 404 || status === 422) {
            return {
              model_id: modelId,
              category,
              case_name: caseItem.name,
              test: caseItem.test,
              status: "skip",
              reason: `HTTP ${status}`,
              success: false,
              elapsed_ms: 0,
            };
          }
          if (status === 429) {
            const retryAfter = e.headers?.get('retry-after');
            const waitMs = retryAfter ? parseInt(retryAfter) * 1000 : (1 + attempt) * 2000;
            console.log(`  [限速] ${modelId} 等待 ${waitMs / 1000}s (attempt ${attempt + 1}/${1 + this.retry})`);
            await new Promise((resolve) => setTimeout(resolve, waitMs));
          } else {
            console.log(`  [${modelId}] ${caseItem.name} HTTP ${status} (attempt ${attempt + 1}/${1 + this.retry})`);
            await new Promise((resolve) => setTimeout(resolve, (1 + attempt) * 1000));
          }
        } else {
          console.log(`  [${modelId}] ${caseItem.name} error: ${e.message || e} (attempt ${attempt + 1}/${1 + this.retry})`);
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
    }

    return {
      model_id: modelId,
      category,
      case_name: caseItem.name,
      test: caseItem.test,
      status: "error",
      success: false,
      elapsed_ms: 0,
    };
  }

  private async runModel(model: any, category: string, clientKwargs: any): Promise<ModelResult[]> {
    let cases = getCases(category);
    if (this.requiredOnly) {
      cases = cases.filter((c) => c.required);
    }
    const tasks = cases.map((c) => this.runSingleCase(model, category, c, clientKwargs));
    return Promise.all(tasks);
  }

  async runAll(groups: Record<string, any[]>): Promise<Record<string, ModelResult[]>> {
    const clientKwargs = this.selector.buildClientKwargs(this.mode);
    const allResults: Record<string, ModelResult[]> = {};
    const totalModels = Object.values(groups).reduce((sum, list) => sum + list.length, 0);
    let done = 0;

    for (const [category, models] of Object.entries(groups)) {
      console.log(`  🔬 [${category}] 开始测试 ${models.length} 个模型...`);
      const catResults: ModelResult[] = [];
      const modelPromises = models.map(async (m, idx) => {
        const modelResults = await this.runModel(m, category, clientKwargs);
        catResults[idx] = modelResults;
        done++;
        const modelId = m.id || m.model_id || "?";
        const passed = modelResults.filter((r) => r.status === "pass").length;
        const totalC = modelResults.length;
        console.log(`    [${done}/${totalModels}] ${modelId}: ${passed}/${totalC} 用例通过`);
        if (this.progressCallback) {
          await this.progressCallback(modelResults);
        }
      });
      await Promise.all(modelPromises);
      allResults[category] = catResults.flat();
    }

    return allResults;
  }
}

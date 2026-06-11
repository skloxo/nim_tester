export class NetworkSelector {
  private config: any;
  public proxyUrl: string;
  public timeout: number;
  public testCount: number;
  public autoSelect: boolean;
  public forceMode: "direct" | "proxy";
  private apiKey: string;

  constructor(config: any) {
    this.config = config;
    this.proxyUrl = config.network?.proxy || "";
    this.timeout = config.network?.timeout || 10;
    this.testCount = config.network?.latency_test_count || 3;
    this.autoSelect = config.network?.auto_select !== false;
    this.forceMode = config.network?.force_mode || "direct";
    // Get the first valid API key
    this.apiKey = (config.api_keys || []).find((k: string) => k.trim())?.trim() || "";
  }

  private async measureLatency(proxy: string | null): Promise<number> {
    const latencies: number[] = [];
    const url = "https://integrate.api.nvidia.com/v1/models";

    for (let i = 0; i < this.testCount; i++) {
      try {
        const t0 = performance.now();
        const headers: Record<string, string> = {
          "Authorization": `Bearer ${this.apiKey}`,
        };

        const controller = new AbortController();
        const id = setTimeout(() => controller.abort(), this.timeout * 1000);

        const options: any = {
          method: "GET",
          headers,
          signal: controller.signal,
        };

        if (proxy) {
          options.proxy = proxy;
        }

        const resp = await fetch(url, options);
        clearTimeout(id);

        const elapsed = performance.now() - t0;
        if (resp.status < 500) {
          latencies.push(elapsed);
        }
      } catch (e: any) {
        // Quietly log to debug console if needed
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }

    if (latencies.length === 0) {
      return Infinity;
    }
    return latencies.reduce((a, b) => a + b, 0) / latencies.length;
  }

  async selectBest(): Promise<[ "direct" | "proxy", number ]> {
    if (!this.autoSelect) {
      const mode = this.forceMode;
      console.log(`  ⚙️  强制模式：${mode}（已关闭自动选速）`);
      return [mode, 0.0];
    }

    console.log("  📡 测试直连延迟...");
    const directLatency = await this.measureLatency(null);
    console.log(
      directLatency !== Infinity
        ? `  直连平均延迟: ${directLatency.toFixed(0)}ms`
        : "  直连: ❌ 不可达"
    );

    let proxyLatency = Infinity;
    if (this.proxyUrl) {
      console.log(`  📡 测试代理延迟（${this.proxyUrl}）...`);
      proxyLatency = await this.measureLatency(this.proxyUrl);
      console.log(
        proxyLatency !== Infinity
          ? `  代理平均延迟: ${proxyLatency.toFixed(0)}ms`
          : "  代理: ❌ 不可达"
      );
    }

    if (directLatency === Infinity && proxyLatency === Infinity) {
      console.error("❌ 直连和代理均不可达，请检查网络或 API 密钥");
      throw new Error("网络不可达");
    }

    if (directLatency <= proxyLatency) {
      return ["direct", directLatency];
    } else {
      return ["proxy", proxyLatency];
    }
  }

  buildClientKwargs(mode: string): any {
    const kwargs: any = {};
    if (mode === "proxy" && this.proxyUrl) {
      kwargs.proxy = this.proxyUrl;
    }
    return kwargs;
  }
}

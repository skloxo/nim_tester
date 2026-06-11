import { NetworkSelector } from "./network";

export class ModelFetcher {
  private config: any;
  private mode: string;
  private baseUrl: string;
  private modelsEndpoint: string;
  private apiKeys: string[];
  private keyIndex: number;
  private selector: NetworkSelector;

  constructor(config: any, mode: string) {
    this.config = config;
    this.mode = mode;
    this.baseUrl = (config.api?.base_url || "").replace(/\/+$/, "");
    this.modelsEndpoint = config.api?.models_endpoint || "/v1/models";
    this.apiKeys = (config.api_keys || [])
      .map((k: string) => k.trim())
      .filter((k: string) => k);
    this.keyIndex = 0;
    this.selector = new NetworkSelector(config);
  }

  private nextKey(): string {
    if (this.apiKeys.length === 0) {
      return "";
    }
    const key = this.apiKeys[this.keyIndex % this.apiKeys.length];
    this.keyIndex++;
    return key || "";
  }

  private headers(): Record<string, string> {
    return {
      "Authorization": `Bearer ${this.nextKey()}`,
      "Content-Type": "application/json",
    };
  }

  async fetchAll(): Promise<any[]> {
    const url = `${this.baseUrl}${this.modelsEndpoint}`;
    const clientKwargs = this.selector.buildClientKwargs(this.mode);
    const models: any[] = [];

    let afterToken: string | undefined = undefined;
    let page = 1;

    while (true) {
      try {
        const urlObj = new URL(url);
        if (afterToken) {
          urlObj.searchParams.set("after", afterToken);
        }

        const options: any = {
          method: "GET",
          headers: this.headers(),
        };

        if (clientKwargs.proxy) {
          options.proxy = clientKwargs.proxy;
        }

        const resp = await fetch(urlObj.toString(), options);
        if (!resp.ok) {
          console.error(`❌ 拉取模型失败（${resp.status}）: ${resp.statusText}`);
          break;
        }

        const data = await resp.json() as any;
        const items = data.data || data.models || [];
        models.push(...items);
        console.log(`  第${page}页获取 ${items.length} 个模型`);

        const nextToken = data.next_page_token || data.after;
        if (nextToken) {
          afterToken = nextToken;
          page++;
          await new Promise((resolve) => setTimeout(resolve, 300));
        } else {
          break;
        }
      } catch (e: any) {
        console.error(`❌ 拉取模型异常:`, e.message || e);
        break;
      }
    }

    return models;
  }
}

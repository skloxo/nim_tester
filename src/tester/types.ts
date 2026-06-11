export interface TestCase {
  name: string;
  description: string;
  test: string;
  required: boolean;
  tags: string[];
  timeout?: number;
  buildPayload: (modelId: string) => Record<string, any>;
  parseResult: (responseJson: any, elapsedMs: number) => Record<string, any>;
}

export interface ModelResult {
  model_id: string;
  category: string;
  case_name: string;
  test: string;
  status: "pass" | "fail" | "skip" | "error";
  success: boolean;
  elapsed_ms: number;
  tps?: number;
  ttft_ms?: number;
  reason?: string;
  [key: string]: any;
}

export interface ScoredModel {
  score: number;
  grade: string;
  rank?: number;
  avg_tps: number;
  avg_elapsed: number;
  passed: number;
  skipped: number;
  total: number;
  use_cases: string[];
  use_cases_str: string;
  max_context?: number;
  param_count?: number;
}

export interface RunRecord {
  run_id: string;
  profile: string;
  base_url: string;
  started_at: string;
  finished_at?: string;
  model_count: number;
  config_json: string;
}

export interface AppConfig {
  api?: {
    base_url?: string;
    chat_endpoint?: string;
    embeddings_endpoint?: string;
    models_endpoint?: string;
  };
  api_keys?: string[];
  network?: {
    proxy?: string;
    timeout?: number;
    latency_test_count?: number;
    auto_select?: boolean;
    force_mode?: "direct" | "proxy";
  };
  testing?: {
    concurrency?: number;
    retry_count?: number;
    request_interval?: number;
    required_only?: boolean;
    rate_limit_per_key?: number;
    rate_limit_window?: number;
    circuit_breaker_threshold?: number;
    circuit_breaker_reset_timeout?: number;
  };
  model_categories?: Record<
    string,
    {
      keywords?: string[];
      exclude_keywords?: string[];
      description?: string;
    }
  >;
}

export function extractMetaFromResults(results: ModelResult[]): {
  maxContext?: number;
  paramCount?: number;
} {
  let maxContext: number | undefined;
  let paramCount: number | undefined;

  for (const r of results) {
    if (maxContext === undefined) {
      if (typeof r.max_context === "number") maxContext = r.max_context;
      else if (r.meta_json && typeof r.meta_json.max_context === "number")
        maxContext = r.meta_json.max_context;
      else if (r.meta && typeof r.meta.max_context === "number")
        maxContext = r.meta.max_context;
    }
    if (paramCount === undefined) {
      if (typeof r.param_count === "number") paramCount = r.param_count;
      else if (r.meta_json && typeof r.meta_json.param_count === "number")
        paramCount = r.meta_json.param_count;
      else if (r.meta && typeof r.meta.param_count === "number")
        paramCount = r.meta.param_count;
    }
    if (maxContext !== undefined && paramCount !== undefined) break;
  }

  return { maxContext, paramCount };
}

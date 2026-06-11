export interface TestCase {
  name: string;
  description: string;
  test: string;
  required: boolean;
  tags: string[];
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

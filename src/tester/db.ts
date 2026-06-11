import { Database } from "bun:sqlite";
import { join } from "path";
import type { RunRecord, ModelResult, ScoredModel } from "./types";

const DB_PATH = join(import.meta.dir, "../../history.db");

let dbInstance: Database | null = null;

export function getDb(): Database {
  if (!dbInstance) {
    dbInstance = new Database(DB_PATH, { create: true });
    dbInstance.exec("PRAGMA journal_mode = WAL;");
    dbInstance.exec("PRAGMA busy_timeout = 5000;");
  }
  return dbInstance;
}

export function initDb(): void {
  const db = getDb();
  db.run(`
    CREATE TABLE IF NOT EXISTS runs (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id      TEXT UNIQUE NOT NULL,
        profile     TEXT,
        base_url    TEXT,
        started_at  TEXT NOT NULL,
        finished_at TEXT,
        model_count INTEGER DEFAULT 0,
        config_json TEXT
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS model_results (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id       TEXT NOT NULL,
        model_id     TEXT NOT NULL,
        category     TEXT,
        score        REAL,
        grade        TEXT,
        rank         INTEGER,
        avg_tps      REAL,
        passed       INTEGER,
        total        INTEGER,
        use_cases    TEXT,
        meta_json    TEXT,
        results_json TEXT,
        FOREIGN KEY (run_id) REFERENCES runs(run_id)
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS model_meta_cache (
        model_id        TEXT PRIMARY KEY,
        hf_pipeline_tag TEXT,
        release_date    TEXT,
        param_count     REAL,
        active_params   REAL,
        max_context     INTEGER,
        embed_dim       INTEGER,
        description     TEXT,
        fetched_at      TEXT,
        raw_json        TEXT
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS use_case_cache (
        model_id    TEXT NOT NULL,
        category    TEXT NOT NULL,
        use_cases   TEXT NOT NULL,
        confidence  INTEGER DEFAULT 1,
        updated_at  TEXT NOT NULL,
        PRIMARY KEY (model_id, category)
    );
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_model_results_run ON model_results(run_id);`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_model_results_model ON model_results(model_id);`);
}

export function saveRun(
  runId: string,
  profile: string,
  baseUrl: string,
  config: any,
  startedAt: string
): void {
  const db = getDb();
  db.prepare(`
    INSERT OR IGNORE INTO runs (run_id, profile, base_url, started_at, config_json)
    VALUES (?, ?, ?, ?, ?)
  `).run(runId, profile, baseUrl, startedAt, JSON.stringify(config));
}

export function finishRun(runId: string, finishedAt: string, modelCount: number): void {
  const db = getDb();
  db.prepare(`
    UPDATE runs SET finished_at = ?, model_count = ? WHERE run_id = ?
  `).run(finishedAt, modelCount, runId);
}

export interface ModelResultBatchItem {
  model_id: string;
  category: string;
  scored_model: ScoredModel;
  raw_results: ModelResult[];
}

let stmts: {
  insertResults: any;
  selectUseCase: any;
  insertUseCase: any;
  updateUseCaseConfidence: any;
  updateUseCaseContent: any;
} | null = null;

function getStmts() {
  if (!stmts) {
    const db = getDb();
    stmts = {
      insertResults: db.prepare(`
        INSERT INTO model_results 
        (run_id, model_id, category, score, grade, rank, avg_tps, passed, total, use_cases, results_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      selectUseCase: db.prepare(`
        SELECT use_cases, confidence FROM use_case_cache WHERE model_id = ? AND category = ?
      `),
      insertUseCase: db.prepare(`
        INSERT INTO use_case_cache (model_id, category, use_cases, confidence, updated_at)
        VALUES (?, ?, ?, 1, ?)
      `),
      updateUseCaseConfidence: db.prepare(`
        UPDATE use_case_cache SET confidence = confidence + 1, updated_at = ?
        WHERE model_id = ? AND category = ?
      `),
      updateUseCaseContent: db.prepare(`
        UPDATE use_case_cache SET use_cases = ?, confidence = 1, updated_at = ?
        WHERE model_id = ? AND category = ?
      `),
    };
  }
  return stmts;
}

export function saveModelResultsBatch(
  runId: string,
  items: ModelResultBatchItem[]
): void {
  const db = getDb();
  const s = getStmts();

  const tx = db.transaction(() => {
    for (const item of items) {
      const { model_id, category, scored_model, raw_results } = item;
      const useCasesStr = JSON.stringify(scored_model.use_cases || []);
      
      s.insertResults.run(
        runId,
        model_id,
        category,
        scored_model.score,
        scored_model.grade,
        scored_model.rank ?? null,
        scored_model.avg_tps,
        scored_model.passed,
        scored_model.total,
        useCasesStr,
        JSON.stringify(raw_results)
      );

      const row = s.selectUseCase.get(model_id, category) as { use_cases: string; confidence: number } | undefined;
      const now = new Date().toISOString().slice(0, 19); // YYYY-MM-DDTHH:MM:SS
      if (!row) {
        s.insertUseCase.run(model_id, category, useCasesStr, now);
      } else if (row.use_cases === useCasesStr) {
        s.updateUseCaseConfidence.run(now, model_id, category);
      } else {
        s.updateUseCaseContent.run(useCasesStr, now, model_id, category);
      }
    }
  });

  tx();
}

export function getCachedUseCases(
  modelId: string,
  category: string,
  minConfidence: number = 2
): string[] | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT use_cases FROM use_case_cache
    WHERE model_id = ? AND category = ? AND confidence >= ?
  `).get(modelId, category, minConfidence) as { use_cases: string } | undefined;

  if (row) {
    try {
      return JSON.parse(row.use_cases);
    } catch {
      return null;
    }
  }
  return null;
}

export function saveMetaCache(modelId: string, meta: any): void {
  const db = getDb();
  const now = new Date().toISOString().slice(0, 19); // YYYY-MM-DDTHH:MM:SS
  db.prepare(`
    INSERT OR REPLACE INTO model_meta_cache
    (model_id, hf_pipeline_tag, release_date, param_count, active_params, max_context, embed_dim, description, fetched_at, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    modelId,
    meta.hf_pipeline_tag || null,
    meta.release_date || null,
    meta.param_count || null,
    meta.active_params || null,
    meta.max_context || null,
    meta.embed_dim || null,
    meta.description || null,
    now,
    JSON.stringify(meta)
  );
}

export function getMetaCache(modelId: string, maxAgeDays: number = 7): any | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT raw_json, fetched_at FROM model_meta_cache WHERE model_id = ?
  `).get(modelId) as { raw_json: string; fetched_at: string } | undefined;

  if (!row) {
    return null;
  }

  const fetchedAt = row.fetched_at;
  if (fetchedAt) {
    try {
      const fetchedTime = new Date(fetchedAt + "Z").getTime();
      const now = Date.now();
      const ageInDays = (now - fetchedTime) / (1000 * 60 * 60 * 24);
      if (ageInDays > maxAgeDays) {
        return null;
      }
    } catch {
      // ignore date parse error
    }
  }

  if (row.raw_json) {
    try {
      return JSON.parse(row.raw_json);
    } catch {
      return null;
    }
  }
  return null;
}

export function listRuns(limit: number = 20): RunRecord[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT run_id, profile, base_url, started_at, finished_at, model_count, config_json
    FROM runs ORDER BY id DESC LIMIT ?
  `).all(limit) as RunRecord[];
  return rows;
}

export function compareRuns(runId1: string, runId2: string): any {
  const results1 = getRunResults(runId1);
  const results2 = getRunResults(runId2);

  const map1 = new Map(results1.map((r: any) => [`${r.model_id}:${r.category}`, r]));
  const map2 = new Map(results2.map((r: any) => [`${r.model_id}:${r.category}`, r]));

  const allKeys = new Set([...map1.keys(), ...map2.keys()]);
  const diffs: any[] = [];

  for (const key of allKeys) {
    const r1 = map1.get(key);
    const r2 = map2.get(key);
    if (r1 && r2) {
      const scoreDiff = (r2.score || 0) - (r1.score || 0);
      const tpsDiff = (r2.avg_tps || 0) - (r1.avg_tps || 0);
      if (Math.abs(scoreDiff) > 0.1 || Math.abs(tpsDiff) > 0.1) {
        diffs.push({
          model_id: r1.model_id,
          category: r1.category,
          score_before: r1.score,
          score_after: r2.score,
          score_diff: scoreDiff,
          tps_before: r1.avg_tps,
          tps_after: r2.avg_tps,
          tps_diff: tpsDiff,
        });
      }
    } else if (r1) {
      diffs.push({ model_id: r1.model_id, category: r1.category, status: 'removed' });
    } else if (r2) {
      diffs.push({ model_id: r2.model_id, category: r2.category, status: 'added' });
    }
  }

  return { run1: runId1, run2: runId2, diffs };
}

export function getRunResults(runId: string): any[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM model_results WHERE run_id = ? ORDER BY category, rank
  `).all(runId) as any[];

  return rows.map((row) => {
    const d = { ...row };
    if (d.use_cases) {
      try {
        d.use_cases = JSON.parse(d.use_cases);
      } catch {
        d.use_cases = [];
      }
    } else {
      d.use_cases = [];
    }

    if (d.results_json) {
      try {
        d.results_json = JSON.parse(d.results_json);
      } catch {
        d.results_json = [];
      }
    } else {
      d.results_json = [];
    }

    if (d.meta_json) {
      try {
        d.meta_json = JSON.parse(d.meta_json);
      } catch {
        d.meta_json = {};
      }
    }
    return d;
  });
}

# -*- coding: utf-8 -*-
"""
SQLite 持久化层
- 测试历史记录（runs / model_results）
- 模型元数据缓存（model_meta_cache）
- 场景推荐缓存（use_case_cache）
"""

import json
import logging
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Dict, List, Optional

logger = logging.getLogger(__name__)

DB_PATH = Path(__file__).parent.parent / "history.db"

_SCHEMA = """
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

CREATE TABLE IF NOT EXISTS use_case_cache (
    model_id    TEXT NOT NULL,
    category    TEXT NOT NULL,
    use_cases   TEXT NOT NULL,
    confidence  INTEGER DEFAULT 1,
    updated_at  TEXT NOT NULL,
    PRIMARY KEY (model_id, category)
);

CREATE INDEX IF NOT EXISTS idx_model_results_run ON model_results(run_id);
CREATE INDEX IF NOT EXISTS idx_model_results_model ON model_results(model_id);
"""


@contextmanager
def _conn():
    con = sqlite3.connect(DB_PATH, timeout=10)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA busy_timeout=5000")
    try:
        yield con
        con.commit()
    except Exception:
        con.rollback()
        raise
    finally:
        con.close()


def init_db():
    """建表（幂等）"""
    with _conn() as con:
        con.executescript(_SCHEMA)
    logger.debug(f"DB 初始化完成: {DB_PATH}")


# ── 写入接口 ──────────────────────────────────────────────────────────────────

def save_run(run_id: str, profile: str, base_url: str, config: dict, started_at: str):
    """记录一次测试开始"""
    with _conn() as con:
        con.execute(
            "INSERT OR IGNORE INTO runs(run_id, profile, base_url, started_at, config_json) "
            "VALUES (?,?,?,?,?)",
            (run_id, profile, base_url, started_at, json.dumps(config, ensure_ascii=False))
        )


def finish_run(run_id: str, finished_at: str, model_count: int):
    """更新测试结束时间"""
    with _conn() as con:
        con.execute(
            "UPDATE runs SET finished_at=?, model_count=? WHERE run_id=?",
            (finished_at, model_count, run_id)
        )


def save_model_result(run_id: str, model_id: str, category: str, scored_model: dict,
                      raw_results: list):
    """写入单个模型的评分结果"""
    m = scored_model
    with _conn() as con:
        con.execute(
            "INSERT INTO model_results "
            "(run_id, model_id, category, score, grade, rank, avg_tps, passed, total, use_cases, results_json) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (
                run_id, model_id, category,
                m.get("score"), m.get("grade"), m.get("rank"),
                m.get("avg_tps"), m.get("passed"), m.get("total"),
                json.dumps(m.get("use_cases", []), ensure_ascii=False),
                json.dumps(raw_results, ensure_ascii=False, default=str),
            )
        )
    # 更新 use_case_cache
    use_cases_str = json.dumps(m.get("use_cases", []), ensure_ascii=False)
    _upsert_use_case_cache(model_id, category, use_cases_str)


def save_model_results_batch(run_id: str, items: list):
    """
    O-5: 批量写入多个模型结果，全程单一事务，性能比逐条写入快 N 倍。
    items: [(model_id, category, scored_model, raw_results), ...]
    """
    rows, cache_items = [], []
    for model_id, category, m, raw_results in items:
        rows.append((
            run_id, model_id, category,
            m.get("score"), m.get("grade"), m.get("rank"),
            m.get("avg_tps"), m.get("passed"), m.get("total"),
            json.dumps(m.get("use_cases", []), ensure_ascii=False),
            json.dumps(raw_results, ensure_ascii=False, default=str),
        ))
        cache_items.append((model_id, category,
                            json.dumps(m.get("use_cases", []), ensure_ascii=False)))

    with _conn() as con:
        con.executemany(
            "INSERT INTO model_results "
            "(run_id, model_id, category, score, grade, rank, avg_tps, passed, total, use_cases, results_json) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            rows
        )

    # use_case_cache 更新（每条独立，因为需要读-写逻辑）
    for model_id, category, use_cases_str in cache_items:
        _upsert_use_case_cache(model_id, category, use_cases_str)



def _upsert_use_case_cache(model_id: str, category: str, use_cases: str):
    """若场景推荐与上次相同则增加置信度，否则重置"""
    with _conn() as con:
        row = con.execute(
            "SELECT use_cases, confidence FROM use_case_cache WHERE model_id=? AND category=?",
            (model_id, category)
        ).fetchone()
        now = time.strftime("%Y-%m-%dT%H:%M:%S")
        if row is None:
            con.execute(
                "INSERT INTO use_case_cache(model_id, category, use_cases, confidence, updated_at) "
                "VALUES (?,?,?,1,?)",
                (model_id, category, use_cases, now)
            )
        elif row["use_cases"] == use_cases:
            # 结果一致，置信度+1
            con.execute(
                "UPDATE use_case_cache SET confidence=confidence+1, updated_at=? "
                "WHERE model_id=? AND category=?",
                (now, model_id, category)
            )
        else:
            # 结果不同，重置置信度
            con.execute(
                "UPDATE use_case_cache SET use_cases=?, confidence=1, updated_at=? "
                "WHERE model_id=? AND category=?",
                (use_cases, now, model_id, category)
            )


def get_cached_use_cases(model_id: str, category: str, min_confidence: int = 2) -> Optional[list]:
    """若缓存置信度达标，返回已缓存的场景推荐，避免重复生成"""
    with _conn() as con:
        row = con.execute(
            "SELECT use_cases, confidence FROM use_case_cache "
            "WHERE model_id=? AND category=? AND confidence>=?",
            (model_id, category, min_confidence)
        ).fetchone()
    if row:
        return json.loads(row["use_cases"])
    return None


def save_meta_cache(model_id: str, meta: dict):
    """缓存模型元数据"""
    with _conn() as con:
        con.execute(
            "INSERT OR REPLACE INTO model_meta_cache "
            "(model_id, hf_pipeline_tag, release_date, param_count, active_params, "
            "max_context, embed_dim, description, fetched_at, raw_json) "
            "VALUES (?,?,?,?,?,?,?,?,?,?)",
            (
                model_id,
                meta.get("hf_pipeline_tag"),
                meta.get("release_date"),
                meta.get("param_count"),
                meta.get("active_params"),
                meta.get("max_context"),
                meta.get("embed_dim"),
                meta.get("description"),
                time.strftime("%Y-%m-%dT%H:%M:%S"),
                json.dumps(meta, ensure_ascii=False),
            )
        )


def get_meta_cache(model_id: str, max_age_days: int = 7) -> Optional[dict]:
    """读取元数据缓存（默认 7 天有效）"""
    with _conn() as con:
        row = con.execute(
            "SELECT raw_json, fetched_at FROM model_meta_cache WHERE model_id=?", (model_id,)
        ).fetchone()
    if not row:
        return None
    fetched = row["fetched_at"] or ""
    if fetched:
        import datetime
        try:
            age = (datetime.datetime.now() -
                   datetime.datetime.fromisoformat(fetched)).days
            if age > max_age_days:
                return None
        except Exception:
            pass
    # 返回原始 JSON（避免 sqlite3.Row 字段类型丢失）
    raw = row["raw_json"]
    return json.loads(raw) if raw else None


# ── 查询接口 ──────────────────────────────────────────────────────────────────

def list_runs(limit: int = 20) -> List[dict]:
    """返回最近 N 次测试摘要"""
    with _conn() as con:
        rows = con.execute(
            "SELECT run_id, profile, base_url, started_at, finished_at, model_count "
            "FROM runs ORDER BY id DESC LIMIT ?",
            (limit,)
        ).fetchall()
    return [dict(r) for r in rows]


def get_run_results(run_id: str) -> List[dict]:
    """返回某次测试的所有模型结果"""
    with _conn() as con:
        rows = con.execute(
            "SELECT * FROM model_results WHERE run_id=? ORDER BY category, rank",
            (run_id,)
        ).fetchall()
    results = []
    for r in rows:
        d = dict(r)
        d["use_cases"] = json.loads(d.get("use_cases") or "[]")
        results.append(d)
    return results

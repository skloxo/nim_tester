# -*- coding: utf-8 -*-
"""
模型元数据富化模块
数据源优先级（运行时，无在线查询）：
  1. data/model_catalog.json — 由 tools/build_catalog.py 离线生成
  2. 本地知识库（_LOCAL_KB，硬编码常用模型参数）
  3. 模型 ID 正则解析（参数量/上下文窗口估算）

在线查询仅在 tools/build_catalog.py 中执行，不在测试流程中调用。
"""

import asyncio
import json
import logging
import re
import time
from pathlib import Path
from typing import Dict, Optional

from tester.db import get_meta_cache, save_meta_cache

logger = logging.getLogger(__name__)

# ── NVIDIA NIM 文档 API ────────────────────────────────────────────────────────
_NIM_CATALOG_URL = "https://integrate.api.nvidia.com/v1/models"

# ── 本地知识库（高置信度，手动维护）─────────────────────────────────────────────
# 格式：model_id_fragment → {param_count, active_params, max_context, release_date, embed_dim}
_LOCAL_KB: Dict[str, dict] = {
    # Meta Llama 3.x
    "llama-3.1-8b":   {"param_count": 8,   "max_context": 128000, "release_date": "2024-07"},
    "llama-3.1-70b":  {"param_count": 70,  "max_context": 128000, "release_date": "2024-07"},
    "llama-3.1-405b": {"param_count": 405, "max_context": 128000, "release_date": "2024-07"},
    "llama-3.2-1b":   {"param_count": 1,   "max_context": 128000, "release_date": "2024-09"},
    "llama-3.2-3b":   {"param_count": 3,   "max_context": 128000, "release_date": "2024-09"},
    "llama-3.2-11b":  {"param_count": 11,  "max_context": 128000, "release_date": "2024-09"},
    "llama-3.2-90b":  {"param_count": 90,  "max_context": 128000, "release_date": "2024-09"},
    "llama-3.3-70b":  {"param_count": 70,  "max_context": 128000, "release_date": "2024-12"},
    "llama-4-maverick-17b": {"param_count": 17, "active_params": 17, "max_context": 1000000, "release_date": "2025-04"},
    "llama2-70b":     {"param_count": 70,  "max_context": 4096,   "release_date": "2023-07"},
    # Mistral
    "mistral-7b":     {"param_count": 7,   "max_context": 32768,  "release_date": "2023-09"},
    "mistral-large":  {"param_count": 123, "max_context": 128000, "release_date": "2024-02"},
    "mixtral-8x7b":   {"param_count": 56,  "active_params": 14,   "max_context": 32768, "release_date": "2023-12"},
    "mixtral-8x22b":  {"param_count": 176, "active_params": 44,   "max_context": 65536, "release_date": "2024-04"},
    "mistral-large-3-675b": {"param_count": 675, "max_context": 128000, "release_date": "2025-05"},
    "mistral-medium-3.5-128b": {"param_count": 128, "max_context": 128000, "release_date": "2025-04"},
    # Google Gemma
    "gemma-2-2b":     {"param_count": 2,   "max_context": 8192,   "release_date": "2024-06"},
    "gemma-2b":       {"param_count": 2,   "max_context": 8192,   "release_date": "2024-02"},
    "gemma-3-4b":     {"param_count": 4,   "max_context": 128000, "release_date": "2025-03"},
    "gemma-3-12b":    {"param_count": 12,  "max_context": 128000, "release_date": "2025-03"},
    "gemma-4-31b":    {"param_count": 31,  "max_context": 1000000,"release_date": "2025-04"},
    # Microsoft Phi
    "phi-3-vision-128k": {"param_count": 4.2, "max_context": 128000, "release_date": "2024-05"},
    "phi-4-mini":     {"param_count": 3.8, "max_context": 128000, "release_date": "2025-02"},
    "phi-4-multimodal": {"param_count": 5.6, "max_context": 128000, "release_date": "2025-02"},
    "phi-3.5-moe":    {"param_count": 42,  "active_params": 7,   "max_context": 128000, "release_date": "2024-08"},
    # NVIDIA Nemotron
    "nemotron-4-340b":     {"param_count": 340, "max_context": 4096,   "release_date": "2024-06"},
    "nemotron-70b":        {"param_count": 70,  "max_context": 128000, "release_date": "2024-10"},
    "nemotron-51b":        {"param_count": 51,  "max_context": 128000, "release_date": "2024-10"},
    "nemotron-mini-4b":    {"param_count": 4,   "max_context": 4096,   "release_date": "2024-09"},
    "nemotron-nano-8b":    {"param_count": 8,   "max_context": 128000, "release_date": "2025-01"},
    "nemotron-super-49b":  {"param_count": 49,  "max_context": 128000, "release_date": "2025-01"},
    "nemotron-ultra-253b": {"param_count": 253, "max_context": 128000, "release_date": "2025-03"},
    "nemotron-nano-12b-v2-vl": {"param_count": 12, "max_context": 32768, "release_date": "2025-03"},
    "nemotron-3-nano-30b": {"param_count": 30, "active_params": 3, "max_context": 128000, "release_date": "2025-04"},
    # DeepSeek
    "deepseek-coder-6.7b": {"param_count": 6.7, "max_context": 16384, "release_date": "2023-11"},
    "deepseek-r1":         {"param_count": 671, "active_params": 37,  "max_context": 128000, "release_date": "2025-01"},
    "deepseek-v4-flash":   {"param_count": 671, "active_params": 37,  "max_context": 128000, "release_date": "2025-05"},
    "deepseek-v4-pro":     {"param_count": 671, "active_params": 37,  "max_context": 128000, "release_date": "2025-05"},
    # Embedding 模型
    "bge-m3":              {"param_count": 0.57, "embed_dim": 1024, "max_context": 8192,  "release_date": "2024-01"},
    "arctic-embed-l":      {"param_count": 0.33, "embed_dim": 1024, "max_context": 512,   "release_date": "2024-04"},
    "nv-embed-v1":         {"param_count": 7.8,  "embed_dim": 4096, "max_context": 32768, "release_date": "2024-05"},
    "nv-embedqa-e5-v5":    {"param_count": 0.7,  "embed_dim": 1024, "max_context": 512,   "release_date": "2024-06"},
    "llama-3.2-nv-embedqa-1b": {"param_count": 1, "embed_dim": 2048, "max_context": 8192, "release_date": "2024-10"},
    # Qwen
    "qwen3-coder-480b":    {"param_count": 480, "active_params": 35, "max_context": 32768, "release_date": "2025-05"},
    "qwen3-next-80b":      {"param_count": 80,  "active_params": 3,  "max_context": 128000, "release_date": "2025-05"},
    "qwen3.5-122b":        {"param_count": 122, "active_params": 10, "max_context": 128000, "release_date": "2025-05"},
    "qwen3.5-397b":        {"param_count": 397, "active_params": 17, "max_context": 128000, "release_date": "2025-05"},
    # Starcoder / code
    "starcoder2-15b":      {"param_count": 15, "max_context": 16384, "release_date": "2024-02"},
    # VLM
    "llava":               {"param_count": 13, "max_context": 4096,  "release_date": "2023-10"},
    "neva-22b":            {"param_count": 22, "max_context": 4096,  "release_date": "2023-12"},
    "fuyu-8b":             {"param_count": 8,  "max_context": 16384, "release_date": "2023-10"},
    "kosmos-2":            {"param_count": 1.6,"max_context": 4096,  "release_date": "2023-06"},
    # 其他
    "ibm/granite-34b":     {"param_count": 34, "max_context": 8192,  "release_date": "2024-09"},
}


def _match_kb(model_id: str) -> dict:
    """在本地知识库中模糊匹配模型 ID"""
    mid = model_id.lower()
    best_match = {}
    best_len = 0
    for fragment, data in _LOCAL_KB.items():
        if fragment.lower() in mid and len(fragment) > best_len:
            best_match = data.copy()
            best_len = len(fragment)
    return best_match


def _parse_from_id(model_id: str) -> dict:
    """从模型 ID 正则解析参数量估算"""
    mid = model_id.lower()
    result = {}

    # 参数量：匹配 70b, 8x7b, 3b, 1.3b, 480b-a35b 等格式
    moe_match = re.search(r"(\d+(?:\.\d+)?)b[_-]?a(\d+(?:\.\d+)?)b", mid)
    if moe_match:
        result["param_count"] = float(moe_match.group(1))
        result["active_params"] = float(moe_match.group(2))
    else:
        moe2 = re.search(r"(\d+)x(\d+(?:\.\d+)?)b", mid)
        if moe2:
            result["param_count"] = int(moe2.group(1)) * float(moe2.group(2))
            result["active_params"] = float(moe2.group(2))  # 粗略估算激活参数
        else:
            param_match = re.search(r"(\d+(?:\.\d+)?)b(?:[_\-]|$|\d)", mid)
            if not param_match:
                param_match = re.search(r"(\d+(?:\.\d+)?)b", mid)
            if param_match:
                result["param_count"] = float(param_match.group(1))

    # 上下文窗口：128k, 32k, 8k 等
    ctx_match = re.search(r"(\d+)k(?:[_\-]|$)", mid)
    if ctx_match:
        result["max_context"] = int(ctx_match.group(1)) * 1024

    return result


# ── Catalog 加载器（运行时唯一在线操作 = 读本地文件）────────────────────────────
_CATALOG_PATH = Path(__file__).parent.parent / "data" / "model_catalog.json"
_catalog_cache: Dict[str, dict] = {}
_catalog_loaded = False


def _load_catalog() -> Dict[str, dict]:
    """懒加载 model_catalog.json，首次加载后缓存到内存"""
    global _catalog_cache, _catalog_loaded
    if _catalog_loaded:
        return _catalog_cache
    if _CATALOG_PATH.exists():
        try:
            _catalog_cache = json.loads(_CATALOG_PATH.read_text(encoding="utf-8"))
            logger.info(f"  [META] 已加载本地目录：{len(_catalog_cache)} 个模型 ({_CATALOG_PATH})")
        except Exception as e:
            logger.warning(f"  [META] catalog 加载失败: {e}，将使用 KB + 正则")
    else:
        logger.info("  [META] data/model_catalog.json 未找到，使用本地 KB + 正则（建议运行 tools/build_catalog.py）")
    _catalog_loaded = True
    return _catalog_cache


async def fetch_model_meta(model_id: str, **_) -> dict:
    """
    获取模型元数据（纯本地，无在线请求）
    优先级：SQLite 缓存 > catalog 文件 > 本地 KB > 正则解析
    """
    # 1. SQLite 短期缓存（避免重复计算年龄等）
    cached = get_meta_cache(model_id)
    if cached:
        return cached

    meta = {}

    # 2. 本地 catalog 文件（由 build_catalog.py 生成）
    catalog = _load_catalog()
    if model_id in catalog:
        entry = catalog[model_id]
        for k in ["param_count", "active_params", "max_context", "embed_dim",
                  "release_date", "hf_pipeline_tag", "hf_category", "description",
                  "languages", "display_name"]:
            if k in entry:
                meta[k] = entry[k]

    # 3. 本地知识库补漏（catalog 里可能没有的字段）
    kb_data = _match_kb(model_id)
    for k, v in kb_data.items():
        if k not in meta:
            meta[k] = v

    # 4. 正则解析兜底（catalog + KB 都没有的字段）
    parsed = _parse_from_id(model_id)
    for k, v in parsed.items():
        if k not in meta:
            meta[k] = v

    # 5. 计算模型年龄（月数）
    release_date = meta.get("release_date", "")
    if release_date:
        try:
            import datetime
            parts = release_date[:7].split("-")
            ry, rm = int(parts[0]), int(parts[1])
            now = datetime.datetime.now()
            meta["age_months"] = (now.year - ry) * 12 + (now.month - rm)
        except Exception:
            pass

    # 6. 存入 SQLite（避免下次重复计算）
    if meta:
        save_meta_cache(model_id, meta)

    return meta


async def _fetch_hf_online(model_id: str, client) -> dict:
    """从 HuggingFace API 在线获取单个模型元数据（仅用于增量更新）"""
    try:
        url = f"https://huggingface.co/api/models/{model_id}"
        resp = await client.get(url, timeout=12)
        if resp.status_code == 200:
            data = resp.json()
            meta = {}
            if data.get("pipeline_tag"):
                meta["hf_pipeline_tag"] = data["pipeline_tag"]
            if data.get("createdAt"):
                meta["release_date"] = data["createdAt"][:7]
            tags = data.get("tags", [])
            langs = [t for t in tags if len(t) == 2 and t.isalpha()]
            if langs:
                meta["languages"] = langs[:5]
            return meta
    except Exception as e:
        logger.debug(f"  [HF] {model_id}: {e}")
    return {}


async def _incremental_update_catalog(new_model_ids: list, proxy: str = "") -> Dict[str, dict]:
    """
    对 catalog 中不存在的新模型，在线查询 HuggingFace 并更新 catalog 文件。
    D-7: 所有模型共享同一个 httpx.AsyncClient，避免每模型独立打开连接池。
    """
    import datetime
    import httpx as _httpx

    proxy_url = proxy if proxy else None
    sem = asyncio.Semaphore(5)           # 最多 5 路并发查 HF
    new_entries: Dict[str, dict] = {}

    async def _fetch_one(mid: str, client) -> tuple:
        async with sem:
            entry = {"id": mid, "updated_at": datetime.datetime.now().strftime("%Y-%m-%dT%H:%M:%S")}
            kb = _match_kb(mid)
            entry.update(kb)
            parsed = _parse_from_id(mid)
            for k, v in parsed.items():
                if k not in entry:
                    entry[k] = v
            # HF 在线补充（共享 client，连接池复用）
            try:
                hf = await _fetch_hf_online(mid, client)
                for k, v in hf.items():
                    if k not in entry or (k == "release_date" and not kb.get("release_date")):
                        entry[k] = v
            except Exception:
                pass
            return mid, entry

    async with _httpx.AsyncClient(proxy=proxy_url, follow_redirects=True, timeout=12) as shared_client:
        tasks = [_fetch_one(mid, shared_client) for mid in new_model_ids]
        gathered = await asyncio.gather(*tasks, return_exceptions=True)

    for item in gathered:
        if isinstance(item, Exception):
            continue
        mid, entry = item
        new_entries[mid] = entry

    # 写回 catalog 文件（追加新条目，保留已有数据）
    if new_entries:
        try:
            if _CATALOG_PATH.exists():
                catalog = json.loads(_CATALOG_PATH.read_text(encoding="utf-8"))
            else:
                _CATALOG_PATH.parent.mkdir(parents=True, exist_ok=True)
                catalog = {}
            catalog.update(new_entries)
            _CATALOG_PATH.write_text(
                json.dumps(catalog, ensure_ascii=False, indent=2), encoding="utf-8"
            )
            _catalog_cache.update(new_entries)
            logger.info(f"  [META] catalog 增量更新：新增 {len(new_entries)} 个模型 → {_CATALOG_PATH}")
        except Exception as e:
            logger.warning(f"  [META] catalog 回写失败: {e}")

    return new_entries


    return new_entries


async def bulk_init_meta(model_ids: list, proxy: str = "", **_) -> Dict[str, dict]:
    """
    批量获取全部模型的元数据。
    - catalog 中已有的模型：直接读本地，零网络开销
    - catalog 中不存在的新模型：自动增量查询 HuggingFace，并写回 catalog
    """
    catalog = _load_catalog()

    # 找出 catalog 中没有的新模型
    new_models = [mid for mid in model_ids if mid not in catalog]
    if new_models:
        logger.info(f"  [META] 发现 {len(new_models)} 个新模型，增量获取元数据...")
        await _incremental_update_catalog(new_models, proxy=proxy)
    else:
        logger.info(f"  [META] 全部 {len(model_ids)} 个模型已在 catalog 中")

    # 现在统一走本地路径（新模型已写入 catalog）
    tasks = [fetch_model_meta(mid) for mid in model_ids]
    results = await asyncio.gather(*tasks, return_exceptions=True)
    out = {}
    for mid, res in zip(model_ids, results):
        if isinstance(res, Exception):
            logger.warning(f"  [META] {mid}: {res}")
            out[mid] = {}
        else:
            out[mid] = res

    has_params = sum(1 for m in out.values() if m.get("param_count"))
    has_date   = sum(1 for m in out.values() if m.get("release_date"))
    logger.info(f"  [META] 汇总: {len(out)} 个模型 | 参数量 {has_params} | 发布日期 {has_date}")
    return out


async def fetch_all_meta(model_ids: list, **_) -> Dict[str, dict]:
    """bulk_init_meta 的别名（兼容旧调用）"""
    return await bulk_init_meta(model_ids)


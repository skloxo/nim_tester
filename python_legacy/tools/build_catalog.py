# -*- coding: utf-8 -*-
"""
tools/build_catalog.py — 一次性模型目录构建脚本
=====================================
用途：离线抓取 NVIDIA API 模型列表 + HuggingFace 元数据，
      合并本地知识库，输出 data/model_catalog.json。

运行：
    cd d:\model\api_tester
    python -X utf8 tools/build_catalog.py

更新频率：每次 NVIDIA 更新模型列表后手动运行一次即可。
测试流程从不调用此脚本，只读 data/model_catalog.json。
"""

import asyncio
import json
import re
import sys
import time
from pathlib import Path

import httpx
import yaml

# ── 路径 ───────────────────────────────────────────────────────────────────────
ROOT = Path(__file__).parent.parent
DATA_DIR = ROOT / "data"
DATA_DIR.mkdir(exist_ok=True)
CATALOG_PATH = DATA_DIR / "model_catalog.json"
RAW_HF_DIR = DATA_DIR / "hf_raw"
RAW_HF_DIR.mkdir(exist_ok=True)

# ── 加载配置 ───────────────────────────────────────────────────────────────────
config = yaml.safe_load((ROOT / "config.yaml").read_text(encoding="utf-8"))
BASE_URL = config["api"]["base_url"].rstrip("/")
API_KEYS = config["api_keys"]
PROXY = config.get("network", {}).get("proxy", "") or ""

# ── 本地知识库（与 meta_fetcher.py 保持同步）──────────────────────────────────
_LOCAL_KB = {
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
    "mistral-7b":     {"param_count": 7,   "max_context": 32768,  "release_date": "2023-09"},
    "mistral-large-2": {"param_count": 123, "max_context": 128000, "release_date": "2024-07"},
    "mixtral-8x7b":   {"param_count": 56,  "active_params": 14,  "max_context": 32768,  "release_date": "2023-12"},
    "mixtral-8x22b":  {"param_count": 176, "active_params": 44,  "max_context": 65536,  "release_date": "2024-04"},
    "mistral-large-3-675b": {"param_count": 675, "max_context": 128000, "release_date": "2025-05"},
    "mistral-medium-3.5-128b": {"param_count": 128, "max_context": 128000, "release_date": "2025-04"},
    "gemma-2-2b":     {"param_count": 2,   "max_context": 8192,   "release_date": "2024-06"},
    "gemma-2b":       {"param_count": 2,   "max_context": 8192,   "release_date": "2024-02"},
    "gemma-3-4b":     {"param_count": 4,   "max_context": 128000, "release_date": "2025-03"},
    "gemma-3-12b":    {"param_count": 12,  "max_context": 128000, "release_date": "2025-03"},
    "gemma-4-31b":    {"param_count": 31,  "max_context": 1000000,"release_date": "2025-04"},
    "phi-3-vision-128k": {"param_count": 4.2, "max_context": 128000, "release_date": "2024-05"},
    "phi-4-mini":     {"param_count": 3.8, "max_context": 128000, "release_date": "2025-02"},
    "phi-4-multimodal": {"param_count": 5.6, "max_context": 128000, "release_date": "2025-02"},
    "phi-3.5-moe":    {"param_count": 42,  "active_params": 7,   "max_context": 128000, "release_date": "2024-08"},
    "nemotron-4-340b":     {"param_count": 340, "max_context": 4096,   "release_date": "2024-06"},
    "nemotron-70b":        {"param_count": 70,  "max_context": 128000, "release_date": "2024-10"},
    "nemotron-51b":        {"param_count": 51,  "max_context": 128000, "release_date": "2024-10"},
    "nemotron-mini-4b":    {"param_count": 4,   "max_context": 4096,   "release_date": "2024-09"},
    "nemotron-nano-8b":    {"param_count": 8,   "max_context": 128000, "release_date": "2025-01"},
    "nemotron-super-49b":  {"param_count": 49,  "max_context": 128000, "release_date": "2025-01"},
    "nemotron-ultra-253b": {"param_count": 253, "max_context": 128000, "release_date": "2025-03"},
    "nemotron-nano-12b-v2-vl": {"param_count": 12, "max_context": 32768, "release_date": "2025-03"},
    "nemotron-3-nano-30b": {"param_count": 30, "active_params": 3, "max_context": 128000, "release_date": "2025-04"},
    "deepseek-coder-6.7b": {"param_count": 6.7, "max_context": 16384, "release_date": "2023-11"},
    "deepseek-r1":         {"param_count": 671, "active_params": 37, "max_context": 128000, "release_date": "2025-01"},
    "deepseek-v4-flash":   {"param_count": 671, "active_params": 37, "max_context": 128000, "release_date": "2025-05"},
    "deepseek-v4-pro":     {"param_count": 671, "active_params": 37, "max_context": 128000, "release_date": "2025-05"},
    "bge-m3":              {"param_count": 0.57, "embed_dim": 1024, "max_context": 8192,  "release_date": "2024-01"},
    "arctic-embed-l":      {"param_count": 0.33, "embed_dim": 1024, "max_context": 512,   "release_date": "2024-04"},
    "nv-embed-v1":         {"param_count": 7.8,  "embed_dim": 4096, "max_context": 32768, "release_date": "2024-05"},
    "nv-embedqa-e5-v5":    {"param_count": 0.7,  "embed_dim": 1024, "max_context": 512,   "release_date": "2024-06"},
    "llama-3.2-nv-embedqa-1b": {"param_count": 1, "embed_dim": 2048, "max_context": 8192, "release_date": "2024-10"},
    "qwen3-coder-480b":    {"param_count": 480, "active_params": 35, "max_context": 32768, "release_date": "2025-05"},
    "qwen3-next-80b":      {"param_count": 80,  "active_params": 3,  "max_context": 128000,"release_date": "2025-05"},
    "qwen3.5-122b":        {"param_count": 122, "active_params": 10, "max_context": 128000,"release_date": "2025-05"},
    "qwen3.5-397b":        {"param_count": 397, "active_params": 17, "max_context": 128000,"release_date": "2025-05"},
    "starcoder2-15b":      {"param_count": 15, "max_context": 16384, "release_date": "2024-02"},
    "llava":               {"param_count": 13, "max_context": 4096,  "release_date": "2023-10"},
    "neva-22b":            {"param_count": 22, "max_context": 4096,  "release_date": "2023-12"},
    "fuyu-8b":             {"param_count": 8,  "max_context": 16384, "release_date": "2023-10"},
    "kosmos-2":            {"param_count": 1.6,"max_context": 4096,  "release_date": "2023-06"},
    "granite-34b":         {"param_count": 34, "max_context": 8192,  "release_date": "2024-09"},
    "granite-3.0-8b":      {"param_count": 8,  "max_context": 4096,  "release_date": "2024-09"},
    "granite-3.0-3b":      {"param_count": 3,  "max_context": 4096,  "release_date": "2024-09"},
}

# ── HuggingFace pipeline_tag → 模型类型映射 ────────────────────────────────────
HF_TAG_TO_CATEGORY = {
    "text-generation": "general_chat",
    "text2text-generation": "general_chat",
    "conversational": "general_chat",
    "image-text-to-text": "vision_language",
    "visual-question-answering": "vision_language",
    "image-to-text": "vision_language",
    "text-to-image": "image_generation",
    "image-to-image": "image_generation",
    "feature-extraction": "text_embedding",
    "sentence-similarity": "text_embedding",
    "text-classification": "text_embedding",
    "fill-mask": "text_embedding",
    "token-classification": "general_chat",
    "automatic-speech-recognition": "audio",
    "text-to-speech": "audio",
    "text-to-audio": "audio",
}


def _match_kb(model_id: str) -> dict:
    mid = model_id.lower()
    best, best_len = {}, 0
    for fragment, data in _LOCAL_KB.items():
        if fragment.lower() in mid and len(fragment) > best_len:
            best = data.copy()
            best_len = len(fragment)
    return best


def _parse_id(model_id: str) -> dict:
    """从 ID 正则解析参数量、上下文"""
    mid = model_id.lower()
    result = {}
    # MoE 格式：480b-a35b 或 8x7b
    moe1 = re.search(r"(\d+(?:\.\d+)?)b[_-]?a(\d+(?:\.\d+)?)b", mid)
    if moe1:
        result["param_count"] = float(moe1.group(1))
        result["active_params"] = float(moe1.group(2))
    else:
        moe2 = re.search(r"(\d+)x(\d+(?:\.\d+)?)b", mid)
        if moe2:
            result["param_count"] = int(moe2.group(1)) * float(moe2.group(2))
            result["active_params"] = float(moe2.group(2))
        else:
            pm = re.search(r"(\d+(?:\.\d+)?)b(?:[_\-\d]|$)", mid)
            if pm:
                result["param_count"] = float(pm.group(1))
    # 上下文窗口
    ctx = re.search(r"(\d+)k(?:[_\-]|$)", mid)
    if ctx:
        result["max_context"] = int(ctx.group(1)) * 1024
    return result


def _calc_age(release_date: str) -> int | None:
    """计算距今月数"""
    if not release_date:
        return None
    try:
        import datetime
        parts = release_date[:7].split("-")
        ry, rm = int(parts[0]), int(parts[1])
        now = datetime.datetime.now()
        return (now.year - ry) * 12 + (now.month - rm)
    except Exception:
        return None


async def fetch_hf_meta(model_id: str, client: httpx.AsyncClient) -> dict:
    """从 HuggingFace API 获取元数据，原始响应保存为 .md 文件"""
    raw_path = RAW_HF_DIR / f"{model_id.replace('/', '__')}.json"

    # 先读本地缓存
    if raw_path.exists():
        try:
            return json.loads(raw_path.read_text(encoding="utf-8"))
        except Exception:
            pass

    url = f"https://huggingface.co/api/models/{model_id}"
    try:
        r = await client.get(url, timeout=12)
        if r.status_code == 200:
            data = r.json()
            # 写原始 JSON（保留完整信息）
            raw_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
            return data
        elif r.status_code == 404:
            # 模型不在 HF 上，写空文件防止重试
            raw_path.write_text("{}", encoding="utf-8")
    except Exception as e:
        print(f"  [HF] {model_id}: {e}")
    return {}


def extract_hf(raw: dict) -> dict:
    """从 HF 原始 JSON 提炼关键字段"""
    out = {}
    if raw.get("pipeline_tag"):
        out["hf_pipeline_tag"] = raw["pipeline_tag"]
        cat = HF_TAG_TO_CATEGORY.get(raw["pipeline_tag"])
        if cat:
            out["hf_category"] = cat
    if raw.get("createdAt"):
        out["release_date"] = raw["createdAt"][:7]   # "2024-09"
    if raw.get("cardData", {}).get("model_name"):
        out["display_name"] = raw["cardData"]["model_name"]
    # 从 tags 中提取语言
    tags = raw.get("tags", [])
    langs = [t for t in tags if len(t) == 2 and t.isalpha()]
    if langs:
        out["languages"] = langs[:5]
    return out


async def fetch_nvidia_model_detail(model_id: str, client: httpx.AsyncClient,
                                    api_key: str) -> dict:
    """GET /v1/models/{model_id} —— NVIDIA 目前返回信息极少，保留备用"""
    try:
        url = f"{BASE_URL}/models/{model_id}"
        r = await client.get(url, headers={"Authorization": f"Bearer {api_key}"}, timeout=8)
        if r.status_code == 200:
            return r.json()
    except Exception:
        pass
    return {}


async def build_catalog():
    print("=" * 60)
    print("  NVIDIA 模型目录构建器")
    print("=" * 60)

    api_key = API_KEYS[0]
    headers = {"Authorization": f"Bearer {api_key}"}
    proxy_url = PROXY if PROXY else None
    async with httpx.AsyncClient(proxy=proxy_url, follow_redirects=True,
                                  headers=headers, timeout=20) as client:
        # Step 1: 拉取模型列表
        print("\n[1/3] 拉取 NVIDIA 模型列表...")
        r = await client.get(f"{BASE_URL}/models")
        r.raise_for_status()
        models_raw = r.json().get("data", [])
        # 去重（NVIDIA 列表中有重复条目）
        seen = set()
        models = []
        for m in models_raw:
            if m["id"] not in seen:
                seen.add(m["id"])
                models.append(m)
        print(f"  → 共 {len(models)} 个唯一模型")

        # Step 2: 批量查 HuggingFace（并发 5，避免限流）
        print(f"\n[2/3] 查询 HuggingFace 元数据（并发5）...")
        sem = asyncio.Semaphore(5)
        hf_results = {}
        done = [0]

        async def _hf_one(mid):
            async with sem:
                raw = await fetch_hf_meta(mid, client)
                hf_results[mid] = extract_hf(raw)
                done[0] += 1
                if done[0] % 10 == 0 or done[0] == len(models):
                    print(f"  → {done[0]}/{len(models)} 完成", end="\r")
                await asyncio.sleep(0.1)  # 轻微降速

        await asyncio.gather(*[_hf_one(m["id"]) for m in models])
        print(f"\n  → HF 查询完成")

        # Step 3: 合并构建 catalog
        print("\n[3/3] 合并元数据...")
        catalog = {}
        import datetime
        now = datetime.datetime.now()

        for m in models:
            mid = m["id"]
            entry = {
                "id": mid,
                "owned_by": m.get("owned_by", ""),
                "updated_at": now.strftime("%Y-%m-%dT%H:%M:%S"),
            }

            # 优先级：本地 KB > HF > 正则解析
            kb = _match_kb(mid)
            hf = hf_results.get(mid, {})
            parsed = _parse_id(mid)

            # 合并（KB 最高优先）
            for k in ["param_count", "active_params", "max_context", "embed_dim"]:
                if k in kb:
                    entry[k] = kb[k]
                elif k in parsed:
                    entry[k] = parsed[k]

            for k in ["release_date"]:
                if k in kb:
                    entry[k] = kb[k]
                elif k in hf:
                    entry[k] = hf[k]  # HF 有真实发布日期

            for k in ["hf_pipeline_tag", "hf_category", "languages", "display_name"]:
                if k in hf:
                    entry[k] = hf[k]

            # 计算年龄
            age = _calc_age(entry.get("release_date", ""))
            if age is not None:
                entry["age_months"] = age

            catalog[mid] = entry

        # 写入
        CATALOG_PATH.write_text(
            json.dumps(catalog, ensure_ascii=False, indent=2),
            encoding="utf-8"
        )

        # 顺便生成一份 markdown 摘要（方便人工核查）
        md_lines = ["# NVIDIA 模型目录\n",
                    f"> 生成时间：{now.strftime('%Y-%m-%d %H:%M:%S')}，共 {len(catalog)} 个模型\n",
                    "\n| 模型 ID | 参数(B) | 激活(B) | 上下文 | 发布日期 | 年龄(月) | HF 类型 |",
                    "|---|---|---|---|---|---|---|"]
        for mid, e in sorted(catalog.items()):
            md_lines.append(
                f"| `{mid}` | {e.get('param_count', '-')} | {e.get('active_params', '-')} | "
                f"{e.get('max_context', '-')} | {e.get('release_date', '-')} | "
                f"{e.get('age_months', '-')} | {e.get('hf_pipeline_tag', '-')} |"
            )
        (DATA_DIR / "model_catalog.md").write_text("\n".join(md_lines), encoding="utf-8")

        print(f"\n✅ 完成！")
        print(f"   catalog:  {CATALOG_PATH}")
        print(f"   markdown: {DATA_DIR / 'model_catalog.md'}")
        print(f"   HF 原始:  {RAW_HF_DIR}/ ({len(list(RAW_HF_DIR.glob('*.json')))} 文件)")

        # 打印简要统计
        has_params = sum(1 for e in catalog.values() if e.get("param_count"))
        has_date = sum(1 for e in catalog.values() if e.get("release_date"))
        has_hf = sum(1 for e in catalog.values() if e.get("hf_pipeline_tag"))
        print(f"\n   有参数量: {has_params}/{len(catalog)}")
        print(f"   有发布日期: {has_date}/{len(catalog)}")
        print(f"   HF 匹配: {has_hf}/{len(catalog)}")


if __name__ == "__main__":
    asyncio.run(build_catalog())

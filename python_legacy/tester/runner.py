# -*- coding: utf-8 -*-
"""
测试执行引擎
- 并发控制（semaphore）
- 多密钥轮换
- 流式响应特殊处理
- 失败重试
"""

import asyncio
import logging
import time
from typing import Any, Dict, List

import httpx

from tester.cases import TestCase, get_cases
from tester.network import NetworkSelector

logger = logging.getLogger(__name__)


import collections


class KeyRotator:
    """线程安全的 API 密钥轮换器（带滑动窗口限速）"""

    def __init__(self, keys: List[str], rate_limit: int = 0, window: int = 60):
        self._keys = [k.strip() for k in keys if k.strip()]
        self._idx = 0
        self._lock = asyncio.Lock()
        self._rate_limit = rate_limit        # 每 key 每 window 秒最多请求次数，0 表示不限
        self._window = window                # 限速窗口（秒）
        self._timestamps: Dict[str, collections.deque] = {
            k: collections.deque() for k in self._keys
        }

    def _available_wait(self, key: str) -> float:
        """返回 key 当前需要等待的秒数（0 表示可立即使用）"""
        if not self._rate_limit:
            return 0.0
        q = self._timestamps[key]
        now = time.monotonic()
        while q and now - q[0] >= self._window:
            q.popleft()
        if len(q) < self._rate_limit:
            return 0.0
        return self._window - (now - q[0]) + 0.01

    async def _select_key(self) -> tuple:
        """
        在锁内选择最优 key，返回 (key, wait_secs)。
        不在锁内执行 sleep，避免阻塞其他协程。
        """
        async with self._lock:
            n = len(self._keys)
            min_wait = float("inf")
            best_key = None
            best_offset = 0

            for i in range(n):
                key = self._keys[(self._idx + i) % n]
                wait = self._available_wait(key)
                if wait == 0.0:
                    best_key = key
                    best_offset = i
                    min_wait = 0.0
                    break
                if wait < min_wait:
                    min_wait = wait
                    best_key = key
                    best_offset = i

            # 推进轮询索引（无论是否需要等待都要推进，修复 BUG-5）
            self._idx = (self._idx + best_offset + 1) % n

            # 记录时间戳（在 sleep 前记录，避免多协程同时获得同一 key）
            if self._rate_limit and best_key:
                self._timestamps[best_key].append(time.monotonic())

            return best_key, min_wait

    async def next(self) -> str:
        """返回下一个可用的 API Key（在锁外 sleep，避免阻塞其他协程）"""
        key, wait = await self._select_key()
        if wait > 0:
            logger.debug(f"  [限速] Key {key[-8:]!r} 等待 {wait:.1f}s")
            await asyncio.sleep(wait)
        return key


class TestRunner:
    """并发执行所有分组的测试用例"""

    def __init__(self, config: dict, mode: str, progress_callback=None):
        self.config = config
        self.mode = mode
        self.base_url = config["api"]["base_url"].rstrip("/")
        self.chat_ep = config["api"]["chat_endpoint"]
        self.embed_ep = config["api"]["embeddings_endpoint"]
        self.concurrency = config["testing"]["concurrency"]
        self.retry = config["testing"]["retry_count"]
        self.interval = config["testing"]["request_interval"]
        self.required_only = config["testing"].get("required_only", False)
        self.progress_callback = progress_callback
        rate_limit = config["testing"].get("rate_limit_per_key", 0)
        rate_window = config["testing"].get("rate_limit_window", 60)
        self.rotator = KeyRotator(config["api_keys"], rate_limit, rate_window)
        self._selector = NetworkSelector(config)
        # D-6: Semaphore 延迟创建，避免 Python 3.12 跨事件循环警告
        self._sem: asyncio.Semaphore | None = None

    def _resolve_endpoint(self, category: str) -> str:
        """根据模型分类选择请求端点"""
        ep_map = {
            "text_embedding": self.embed_ep,
            "multimodal_embedding": self.embed_ep,
            "reranker": "/reranking",
            "image_generation": "/images/generations",
            "audio": "/audio/speech",
        }
        return ep_map.get(category, self.chat_ep)

    async def _do_request(
        self,
        client: httpx.AsyncClient,
        url: str,
        payload: dict,
        headers: dict,
        streaming: bool = False,
    ) -> tuple[dict | bytes, float]:
        """执行单次 HTTP 请求，返回 (response_data, elapsed_ms)"""
        t0 = time.perf_counter()

        if streaming:
            # 流式模式：收集 TTFT 和完整内容
            chunks = []
            ttft_ms = None
            async with client.stream("POST", url, json=payload, headers=headers) as resp:
                if resp.status_code >= 400:
                    # 抛出异常以触发外层重试逻辑
                    resp.raise_for_status()
                async for line in resp.aiter_lines():
                    if line.startswith("data: ") and line != "data: [DONE]":
                        if ttft_ms is None:
                            ttft_ms = (time.perf_counter() - t0) * 1000
                        chunks.append(line[6:])
            elapsed = (time.perf_counter() - t0) * 1000
            return {
                "success": len(chunks) > 0,
                "elapsed_ms": round(elapsed, 0),
                "ttft_ms": round(ttft_ms, 0) if ttft_ms else None,
                "chunk_count": len(chunks),
            }, elapsed

        else:
            resp = await client.post(url, json=payload, headers=headers)
            elapsed = (time.perf_counter() - t0) * 1000
            # 触发 HTTPStatusError，让外层重试逻辑捕获 403/429/500 等错误
            resp.raise_for_status()
            content_type = resp.headers.get("content-type", "")
            if "json" in content_type:
                return resp.json(), elapsed
            elif resp.content:
                return resp.content, elapsed
            return {}, elapsed


    async def _run_single_case(
        self,
        model: Dict[str, Any],
        category: str,
        case: TestCase,
        client: httpx.AsyncClient,
    ) -> Dict[str, Any]:
        """执行单个测试用例，包含重试逻辑"""
        model_id = model.get("id", "")
        ep = self._resolve_endpoint(category)
        url = f"{self.base_url}{ep}"
        streaming = "streaming" in case.tags

        for attempt in range(1 + self.retry):
            try:
                await asyncio.sleep(self.interval * attempt)
                api_key = await self.rotator.next()
                async with self._sem:
                    headers = {
                        "Authorization": f"Bearer {api_key}",
                        "Content-Type": "application/json",
                        "Accept": "text/event-stream" if streaming else "application/json",
                    }
                    payload = case.build_payload(model_id)

                    raw, elapsed = await self._do_request(
                        client, url, payload, headers, streaming
                    )

                result = case.parse_result(raw, elapsed)
                result["model_id"] = model_id
                result["category"] = category
                result["case_name"] = case.name
                result["attempt"] = attempt + 1
                result["status"] = "pass" if result.get("success") else "fail"
                return result

            except httpx.HTTPStatusError as e:
                status = e.response.status_code
                # 404 模型不存在 / 422 请求格式错误 → 无意义重试
                if status in (404, 422):
                    return {
                        "model_id": model_id,
                        "category": category,
                        "case_name": case.name,
                        "test": case.test,
                        "status": "skip",
                        "reason": f"HTTP {status}",
                        "success": False,
                    }
                # 403 表示当前 Key 无权限，换下一个 Key 重试
                # 429 限流 / 500 服务器错误 → 同样重试
                logger.debug(f"  [{model_id}] {case.name} HTTP {status} (attempt {attempt+1}/{1+self.retry})")
                await asyncio.sleep(1 + attempt)   # 退避性等待
            except Exception as e:
                logger.debug(f"  [{model_id}] {case.name} error: {e} (attempt {attempt+1})")
                await asyncio.sleep(1)

        return {
            "model_id": model_id,
            "category": category,
            "case_name": case.name,
            "test": case.test,          # 修复：error 路径同样需要 test 字段参与评分
            "status": "error",
            "success": False,
        }

    async def _run_model(
        self, model: Dict[str, Any], category: str,
        client: httpx.AsyncClient,
    ) -> List[Dict[str, Any]]:
        """对单个模型运行所属分类的全部测试用例"""
        cases = get_cases(category)
        if self.required_only:
            cases = [c for c in cases if c.required]
        tasks = [self._run_single_case(model, category, c, client) for c in cases]
        return await asyncio.gather(*tasks)

    async def run_all(
        self, groups: Dict[str, List[Dict[str, Any]]]
    ) -> Dict[str, Any]:
        """运行所有分组的全部模型测试（复用单一 httpx 客户端）"""
        # 延迟创建 Semaphore，确保在当前事件循环内创建（修复 D-6）
        if self._sem is None:
            self._sem = asyncio.Semaphore(self.concurrency)
        client_kwargs = self._selector.build_client_kwargs(self.mode)
        all_results: Dict[str, Any] = {}
        total_models = sum(len(v) for v in groups.values())
        done = 0

        async with httpx.AsyncClient(**client_kwargs) as client:  # 复用连接池
            for category, models in groups.items():
                logger.info(
                    f"  🔬 [{category}] 开始测试 {len(models)} 个模型..."
                )
                cat_results = []
                tasks = [self._run_model(m, category, client) for m in models]
                for coro in asyncio.as_completed(tasks):
                    model_results = await coro
                    cat_results.extend(model_results)
                    done += 1
                    model_id = model_results[0]["model_id"] if model_results else "?"
                    passed = sum(1 for r in model_results if r["status"] == "pass")
                    total_c = len(model_results)
                    logger.info(
                        f"    [{done}/{total_models}] {model_id}: "
                        f"{passed}/{total_c} 用例通过"
                    )
                    if self.progress_callback:
                        await self.progress_callback(model_results)
                all_results[category] = cat_results

        return all_results

# -*- coding: utf-8 -*-
"""网络测速模块：测试直连 vs 代理延迟，返回最优模式"""

import asyncio
import logging
import time
from typing import Tuple

import httpx

logger = logging.getLogger(__name__)

LATENCY_TEST_URL = "https://integrate.api.nvidia.com/v1/models"


class NetworkSelector:
    """自动测速选择最优网络路径"""

    def __init__(self, config: dict):
        self.config = config
        self.proxy_url = config["network"].get("proxy", "")
        self.timeout = config["network"].get("timeout", 10)
        self.test_count = config["network"].get("latency_test_count", 3)
        self.auto_select = config["network"].get("auto_select", True)
        self.force_mode = config["network"].get("force_mode", "direct")
        # 取第一个有效 API key 用于测速
        self.api_key = next(
            (k for k in config["api_keys"] if k.strip()), ""
        )

    async def _measure_latency(self, proxy: str | None) -> float:
        """测量指定代理配置的平均延迟（ms），失败返回 inf"""
        latencies = []
        headers = {"Authorization": f"Bearer {self.api_key}"}
        client_kwargs = dict(timeout=self.timeout, headers=headers, follow_redirects=True)
        if proxy:
            client_kwargs["proxy"] = proxy

        # 复用单个 client，避免每次循环重建连接池
        async with httpx.AsyncClient(**client_kwargs) as client:
            for _ in range(self.test_count):
                try:
                    t0 = time.perf_counter()
                    resp = await client.get(LATENCY_TEST_URL)
                    elapsed = (time.perf_counter() - t0) * 1000
                    if resp.status_code < 500:
                        latencies.append(elapsed)
                except Exception as e:
                    logger.debug(f"  延迟测试异常 proxy={proxy}: {e}")
                await asyncio.sleep(0.3)

        return sum(latencies) / len(latencies) if latencies else float("inf")


    async def select_best(self) -> Tuple[str, float]:
        """
        返回 (mode, avg_latency_ms)
        mode: "direct" | "proxy"
        """
        if not self.auto_select:
            mode = self.force_mode
            logger.info(f"  ⚙️  强制模式：{mode}（已关闭自动选速）")
            return mode, 0.0

        logger.info("  📡 测试直连延迟...")
        direct_latency = await self._measure_latency(None)
        logger.info(
            f"  直连平均延迟: {direct_latency:.0f}ms"
            if direct_latency != float("inf")
            else "  直连: ❌ 不可达"
        )

        proxy_latency = float("inf")
        if self.proxy_url:
            logger.info(f"  📡 测试代理延迟（{self.proxy_url}）...")
            proxy_latency = await self._measure_latency(self.proxy_url)
            logger.info(
                f"  代理平均延迟: {proxy_latency:.0f}ms"
                if proxy_latency != float("inf")
                else "  代理: ❌ 不可达"
            )

        if direct_latency == float("inf") and proxy_latency == float("inf"):
            logger.error("❌ 直连和代理均不可达，请检查网络或 API 密钥")
            raise RuntimeError("网络不可达")

        if direct_latency <= proxy_latency:
            return "direct", direct_latency
        else:
            return "proxy", proxy_latency

    def build_client_kwargs(self, mode: str) -> dict:
        """根据模式构建 httpx 客户端参数"""
        kwargs: dict = {
            "timeout": self.config["network"]["timeout"],
            "follow_redirects": True,
        }
        if mode == "proxy" and self.proxy_url:
            kwargs["proxy"] = self.proxy_url
        return kwargs

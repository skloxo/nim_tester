# -*- coding: utf-8 -*-
"""模型列表拉取模块：支持多密钥轮换，自动翻页"""

import asyncio
import logging
from typing import Any, Dict, List

import httpx

from tester.network import NetworkSelector

logger = logging.getLogger(__name__)


class ModelFetcher:
    """从 API 拉取全量模型列表"""

    def __init__(self, config: dict, mode: str):
        self.config = config
        self.mode = mode
        self.base_url = config["api"]["base_url"].rstrip("/")
        self.models_endpoint = config["api"]["models_endpoint"]
        self.api_keys = [k.strip() for k in config["api_keys"] if k.strip()]
        self._key_index = 0
        self._selector = NetworkSelector(config)

    def _next_key(self) -> str:
        """轮换 API 密钥"""
        key = self.api_keys[self._key_index % len(self.api_keys)]
        self._key_index += 1
        return key

    def _headers(self) -> dict:
        return {
            "Authorization": f"Bearer {self._next_key()}",
            "Content-Type": "application/json",
        }

    async def fetch_all(self) -> List[Dict[str, Any]]:
        """拉取全量模型，支持分页（有 next_page_token 时自动翻页）"""
        url = f"{self.base_url}{self.models_endpoint}"
        client_kwargs = self._selector.build_client_kwargs(self.mode)
        models = []

        async with httpx.AsyncClient(**client_kwargs) as client:
            params: dict = {}
            page = 1
            while True:
                try:
                    resp = await client.get(
                        url,
                        headers=self._headers(),
                        params=params,
                    )
                    resp.raise_for_status()
                    data = resp.json()
                except httpx.HTTPStatusError as e:
                    logger.error(f"❌ 拉取模型失败（{e.response.status_code}）: {e}")
                    break
                except Exception as e:
                    logger.error(f"❌ 拉取模型异常: {e}")
                    break

                items = data.get("data", data.get("models", []))
                models.extend(items)
                logger.debug(f"  第{page}页获取 {len(items)} 个模型")

                # 翻页（OpenAI list API 风格）
                next_token = data.get("next_page_token") or data.get("after")
                if next_token:
                    params["after"] = next_token
                    page += 1
                    await asyncio.sleep(0.3)
                else:
                    break

        return models

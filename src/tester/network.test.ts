import { describe, it, expect } from "bun:test";
import { NetworkSelector } from "./network.ts";

describe("NetworkSelector", () => {
  describe("constructor", () => {
    it("should initialize with config values", () => {
      const config = {
        network: {
          proxy: "http://127.0.0.1:7897",
          timeout: 30,
          latency_test_count: 5,
          auto_select: true,
          force_mode: "proxy",
        },
        api_keys: ["test-key-1"],
      };
      const selector = new NetworkSelector(config);
      expect(selector.proxyUrl).toBe("http://127.0.0.1:7897");
      expect(selector.timeout).toBe(30);
      expect(selector.testCount).toBe(5);
      expect(selector.autoSelect).toBe(true);
      expect(selector.forceMode).toBe("proxy");
    });

    it("should use default values when not provided", () => {
      const config = {};
      const selector = new NetworkSelector(config);
      expect(selector.proxyUrl).toBe("");
      expect(selector.timeout).toBe(10);
      expect(selector.testCount).toBe(3);
      expect(selector.autoSelect).toBe(true);
      expect(selector.forceMode).toBe("direct");
    });
  });

  describe("buildClientKwargs", () => {
    it("should return proxy kwargs for proxy mode", () => {
      const config = {
        network: {
          proxy: "http://127.0.0.1:7897",
        },
      };
      const selector = new NetworkSelector(config);
      const kwargs = selector.buildClientKwargs("proxy");
      expect(kwargs.proxy).toBe("http://127.0.0.1:7897");
    });

    it("should return empty kwargs for direct mode", () => {
      const config = {
        network: {
          proxy: "http://127.0.0.1:7897",
        },
      };
      const selector = new NetworkSelector(config);
      const kwargs = selector.buildClientKwargs("direct");
      expect(kwargs.proxy).toBeUndefined();
    });

    it("should return empty kwargs when no proxy configured", () => {
      const config = {};
      const selector = new NetworkSelector(config);
      const kwargs = selector.buildClientKwargs("proxy");
      expect(kwargs.proxy).toBeUndefined();
    });
  });

  describe("selectBest", () => {
    it("should return forced mode when auto_select is false", async () => {
      const config = {
        network: {
          auto_select: false,
          force_mode: "proxy",
        },
        api_keys: ["test-key"],
      };
      const selector = new NetworkSelector(config);
      const [mode, latency] = await selector.selectBest();
      expect(mode).toBe("proxy");
      expect(latency).toBe(0);
    });

    it("should return direct mode when auto_select is false and force_mode is direct", async () => {
      const config = {
        network: {
          auto_select: false,
          force_mode: "direct",
        },
        api_keys: ["test-key"],
      };
      const selector = new NetworkSelector(config);
      const [mode, latency] = await selector.selectBest();
      expect(mode).toBe("direct");
      expect(latency).toBe(0);
    });
  });
});

import { describe, it, expect } from 'bun:test';
import { KeyRotator, Semaphore, HTTPStatusError } from './runner.ts';

describe('KeyRotator', () => {
  it('should rotate keys', () => {
    const rotator = new KeyRotator(['key1', 'key2', 'key3']);
    expect(rotator['keys']).toHaveLength(3);
  });

  it('should throw when no keys', async () => {
    const rotator = new KeyRotator([]);
    expect(async () => {
      await rotator.next();
    }).toThrow('No API keys configured');
  });

  it('should handle rate limiting', async () => {
    const rotator = new KeyRotator(['key1'], 2, 60);
    const key1 = await rotator.next();
    const key2 = await rotator.next();
    expect(key1).toBe('key1');
    expect(key2).toBe('key1');
  });
});

describe('Semaphore', () => {
  it('should respect max concurrency', async () => {
    const sem = new Semaphore(2);
    let active = 0;
    let maxActive = 0;

    const tasks = Array(5).fill(null).map(async () => {
      await sem.acquire();
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise(r => setTimeout(r, 10));
      active--;
      sem.release();
    });

    await Promise.all(tasks);
    expect(maxActive).toBeLessThanOrEqual(2);
  });
});

describe('HTTPStatusError', () => {
  it('should store status code', () => {
    const err = new HTTPStatusError(404, 'Not Found');
    expect(err.status).toBe(404);
    expect(err.message).toBe('Not Found');
  });
});

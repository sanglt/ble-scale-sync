import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createNobleHandler, type NobleApi } from '../../src/ble/handler-noble-shared.js';

// Suppress log output during tests
vi.spyOn(console, 'log').mockImplementation(() => {});
vi.spyOn(console, 'warn').mockImplementation(() => {});
vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

/**
 * #181 seam test: the shared handler must read the adapter state ONLY through the
 * injected `getState()` accessor, never by touching `noble.state` directly.
 *
 * This matters because `@abandonware/noble`'s `.state` getter triggers
 * `bindings.init()` as a side effect; the legacy entrypoint deliberately reads
 * the raw `._state` field instead. If the shared code ever reached for `.state`,
 * that side effect would fire on the abandonware driver and change behaviour.
 */
class FakeNoble extends EventEmitter {
  _state = 'poweredOn';
  stateAccessed = 0;
  // A getter that records access (and would, on the real abandonware driver,
  // lazily init the bindings). The shared code must NOT trip this.
  get state(): string {
    this.stateAccessed++;
    return this._state;
  }
  startScanningAsync = vi.fn(async () => {});
  stopScanningAsync = vi.fn(async () => {});
}

describe('createNobleHandler getState injection (#181)', () => {
  it('reads adapter state through getState(), not noble.state', async () => {
    const fake = new FakeNoble();
    const getState = vi.fn(() => fake._state);

    const handler = createNobleHandler({
      noble: fake as unknown as NobleApi,
      getState,
    });

    // scanDevices() calls waitForPoweredOn() which reads the state.
    await handler.scanDevices([], 1);

    expect(getState).toHaveBeenCalled();
    // The legacy-style accessor (raw field) was used; the side-effecting getter
    // was never touched by the shared code.
    expect(fake.stateAccessed).toBe(0);
    expect(fake.startScanningAsync).toHaveBeenCalledTimes(1);
    expect(fake.stopScanningAsync).toHaveBeenCalledTimes(1);
  });

  it('exposes the broadcastScan internal for both driver entrypoints', () => {
    const fake = new FakeNoble();
    const handler = createNobleHandler({
      noble: fake as unknown as NobleApi,
      getState: () => fake._state,
    });
    expect(typeof handler._internals.broadcastScan).toBe('function');
  });
});

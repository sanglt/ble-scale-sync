import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock node:fs before importing the module under test so the vi.fn() instance
// is the one the module captures via writeFileSync.
const writeFileSyncMock = vi.fn();
vi.mock('node:fs', () => ({
  writeFileSync: (...args: unknown[]) => writeFileSyncMock(...args),
}));

import {
  touchHeartbeat,
  startFileHeartbeat,
  stopFileHeartbeat,
  _resetForTesting,
} from '../../src/runtime/file-heartbeat.js';

const HEARTBEAT_PATH = '/tmp/.ble-scale-sync-heartbeat';

describe('file-heartbeat (#277)', () => {
  beforeEach(() => {
    writeFileSyncMock.mockReset();
    _resetForTesting();
    vi.useFakeTimers();
  });

  afterEach(() => {
    _resetForTesting();
    vi.useRealTimers();
  });

  it('touchHeartbeat() writes the heartbeat file', () => {
    touchHeartbeat();
    expect(writeFileSyncMock).toHaveBeenCalledTimes(1);
    expect(writeFileSyncMock.mock.calls[0][0]).toBe(HEARTBEAT_PATH);
  });

  it('touchHeartbeat() swallows a write error (/tmp not writable on Windows)', () => {
    writeFileSyncMock.mockImplementationOnce(() => {
      throw new Error('EACCES');
    });
    expect(() => touchHeartbeat()).not.toThrow();
  });

  it('startFileHeartbeat() touches immediately, before any timer advance', () => {
    startFileHeartbeat();
    expect(writeFileSyncMock).toHaveBeenCalledTimes(1);
  });

  // The bug: the file went stale while the loop blocked in nextReading() waiting
  // for a weigh-in, so an idle container flipped to unhealthy after 5 minutes
  // and the HA Supervisor watchdog restarted it. The tick must be independent of
  // readings.
  it('keeps ticking every 30s with no reading activity at all', () => {
    startFileHeartbeat();
    writeFileSyncMock.mockClear();

    vi.advanceTimersByTime(29_999);
    expect(writeFileSyncMock).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2);
    expect(writeFileSyncMock).toHaveBeenCalledTimes(1);

    // Well past the 5 minute freshness window the HEALTHCHECK enforces.
    vi.advanceTimersByTime(10 * 60_000);
    expect(writeFileSyncMock.mock.calls.length).toBeGreaterThanOrEqual(20);
  });

  // A ref'd interval would keep the process alive forever, which breaks the
  // consecutive-failure watchdog: its recovery is letting the process exit so
  // the supervisor restarts it.
  it('unrefs the interval so it cannot hold the process open', () => {
    const unref = vi.fn();
    const setIntervalSpy = vi
      .spyOn(globalThis, 'setInterval')
      .mockReturnValue({ unref } as unknown as ReturnType<typeof setInterval>);

    startFileHeartbeat();

    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(unref).toHaveBeenCalledTimes(1);
    setIntervalSpy.mockRestore();
  });

  it('is idempotent and does not stack timers', () => {
    startFileHeartbeat();
    startFileHeartbeat();
    writeFileSyncMock.mockClear();

    vi.advanceTimersByTime(30_000);
    expect(writeFileSyncMock).toHaveBeenCalledTimes(1);
  });

  it('a throwing write does not kill the interval', () => {
    startFileHeartbeat();
    writeFileSyncMock.mockClear();
    writeFileSyncMock.mockImplementationOnce(() => {
      throw new Error('EACCES');
    });

    vi.advanceTimersByTime(30_000);
    expect(writeFileSyncMock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(30_000);
    expect(writeFileSyncMock).toHaveBeenCalledTimes(2);
  });

  it('stopFileHeartbeat() cancels the interval, and start works again after', () => {
    startFileHeartbeat();
    stopFileHeartbeat();
    writeFileSyncMock.mockClear();

    vi.advanceTimersByTime(120_000);
    expect(writeFileSyncMock).not.toHaveBeenCalled();

    startFileHeartbeat();
    expect(writeFileSyncMock).toHaveBeenCalledTimes(1);
  });

  it('stopFileHeartbeat() before any start is safe', () => {
    expect(() => stopFileHeartbeat()).not.toThrow();
  });
});

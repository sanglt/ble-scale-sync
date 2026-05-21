import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IntervalsExporter, toLocalDate } from '../../src/exporters/intervals.js';
import type { IntervalsConfig } from '../../src/exporters/config.js';
import type { BodyComposition } from '../../src/interfaces/scale-adapter.js';
import type { ExportContext } from '../../src/interfaces/exporter.js';

const samplePayload: BodyComposition = {
  weight: 80,
  impedance: 500,
  bmi: 23.9,
  bodyFatPercent: 18.5,
  waterPercent: 55.2,
  boneMass: 3.1,
  muscleMass: 62.4,
  visceralFat: 8,
  physiqueRating: 5,
  bmr: 1750,
  metabolicAge: 30,
};

const defaultConfig: IntervalsConfig = {
  athleteId: 'i123456',
  apiKey: 'abcdef123',
};

const expectedAuth = `Basic ${btoa('API_KEY:abcdef123')}`;

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function lastBody(): Record<string, unknown> {
  return JSON.parse(mockFetch.mock.calls[0][1].body as string);
}

describe('toLocalDate()', () => {
  it('formats a date as local YYYY-MM-DD', () => {
    expect(toLocalDate(new Date(2024, 0, 5, 23, 30))).toBe('2024-01-05');
    expect(toLocalDate(new Date(2024, 11, 31, 1, 0))).toBe('2024-12-31');
  });
});

describe('IntervalsExporter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue({ ok: true, status: 200 });
  });

  it('has name "intervals"', () => {
    const exporter = new IntervalsExporter(defaultConfig);
    expect(exporter.name).toBe('intervals');
  });

  it('supports back-dating', () => {
    const exporter = new IntervalsExporter(defaultConfig);
    expect(exporter.supportsBackdate).toBe(true);
  });

  it("PUTs to today's wellness record for a live reading", async () => {
    const exporter = new IntervalsExporter(defaultConfig);
    await exporter.export(samplePayload);

    const today = toLocalDate(new Date());
    expect(mockFetch).toHaveBeenCalledWith(
      `https://intervals.icu/api/v1/athlete/i123456/wellness/${today}`,
      expect.objectContaining({ method: 'PUT' }),
    );
  });

  it('back-dates the URL to context.timestamp for a historical reading', async () => {
    const context: ExportContext = { timestamp: new Date(2024, 2, 14, 9, 0) };
    const exporter = new IntervalsExporter(defaultConfig);
    await exporter.export(samplePayload, context);

    expect(mockFetch.mock.calls[0][0]).toBe(
      'https://intervals.icu/api/v1/athlete/i123456/wellness/2024-03-14',
    );
  });

  it('sends HTTP Basic auth with the literal API_KEY username', async () => {
    const exporter = new IntervalsExporter(defaultConfig);
    await exporter.export(samplePayload);

    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers.Authorization).toBe(expectedAuth);
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('sends weight and body fat in the JSON body', async () => {
    const exporter = new IntervalsExporter(defaultConfig);
    await exporter.export(samplePayload);

    const body = lastBody();
    expect(body.weight).toBe(80);
    expect(body.bodyFat).toBe(18.5);
  });

  it('returns failure on a non-2xx response', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 403 });
    const exporter = new IntervalsExporter(defaultConfig);
    const result = await exporter.export(samplePayload);

    expect(result.success).toBe(false);
    expect(result.error).toBe('HTTP 403');
  });

  it('does not retry a 4xx response', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 403 });
    const exporter = new IntervalsExporter(defaultConfig);
    await exporter.export(samplePayload);

    // Bad API key / athlete ID cannot succeed on retry — fail fast.
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('retries on failure (3 total attempts)', async () => {
    mockFetch.mockRejectedValue(new Error('timeout'));
    const exporter = new IntervalsExporter(defaultConfig);
    const result = await exporter.export(samplePayload);

    expect(result.success).toBe(false);
    expect(result.error).toBe('timeout');
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('succeeds on retry after an initial failure', async () => {
    mockFetch
      .mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValueOnce({ ok: true, status: 200 });
    const exporter = new IntervalsExporter(defaultConfig);
    const result = await exporter.export(samplePayload);

    expect(result.success).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  describe('healthcheck()', () => {
    it("GETs today's wellness record and returns success on 200", async () => {
      mockFetch.mockResolvedValue({ ok: true, status: 200 });
      const exporter = new IntervalsExporter(defaultConfig);
      const result = await exporter.healthcheck();

      expect(result.success).toBe(true);
      const today = toLocalDate(new Date());
      expect(mockFetch).toHaveBeenCalledWith(
        `https://intervals.icu/api/v1/athlete/i123456/wellness/${today}`,
        expect.objectContaining({ headers: { Authorization: expectedAuth } }),
      );
      // healthcheck is a read — no PUT method
      expect(mockFetch.mock.calls[0][1].method).toBeUndefined();
    });

    it('returns failure on a non-2xx response', async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 401 });
      const exporter = new IntervalsExporter(defaultConfig);
      const result = await exporter.healthcheck();

      expect(result.success).toBe(false);
      expect(result.error).toBe('HTTP 401');
    });

    it('returns failure on a network error', async () => {
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
      const exporter = new IntervalsExporter(defaultConfig);
      const result = await exporter.healthcheck();

      expect(result.success).toBe(false);
      expect(result.error).toBe('ECONNREFUSED');
    });
  });
});

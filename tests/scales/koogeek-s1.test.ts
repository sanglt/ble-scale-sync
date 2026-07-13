import { describe, it, expect } from 'vitest';
import { KoogeekS1Adapter } from '../../src/scales/koogeek-s1.js';
import { uuid16, xorChecksum } from '../../src/scales/body-comp-helpers.js';
import {
  mockPeripheral,
  defaultProfile,
  assertPayloadRanges,
} from '../helpers/scale-test-utils.js';

/** Append the trailing XOR checksum to a synthetic frame body. */
function withChecksum(bytes: number[]): Buffer {
  return Buffer.from([...bytes, xorChecksum(bytes, 0, bytes.length)]);
}

const ALL_CHARS = ['fff1', 'fff2', 'fff3', 'fff4', 'fff5', 'fff6'].map((u) =>
  uuid16(parseInt(u, 16)),
);

// Real frames captured by the reporter in issue #270.
const INIT_FRAME = Buffer.from('55aa55aa010d010101162601735500000000001a', 'hex');
const STABLE_FRAME = Buffer.from('55aa55aa0307010000030f01d6de', 'hex'); // 78.3 kg, 470 ohm

describe('KoogeekS1Adapter (#270)', () => {
  describe('matches()', () => {
    it('matches the advertised name regardless of case', () => {
      const adapter = new KoogeekS1Adapter();
      expect(adapter.matches(mockPeripheral('Koogeek-S1', ['fff0']))).toBe(true);
      expect(adapter.matches(mockPeripheral('koogeek-s1'))).toBe(true);
    });

    it('never matches a nameless device, even one carrying every Koogeek characteristic', () => {
      // A structural match would claim a nameless Eufy P2, whose own matcher
      // returns false without a name, so priority could not protect it.
      const adapter = new KoogeekS1Adapter();
      expect(adapter.matches(mockPeripheral('', [], undefined, ALL_CHARS))).toBe(false);
    });

    it('does not steal a 1byone (fff4 without fff2) or an Inlife (fff2 without fff4)', () => {
      const adapter = new KoogeekS1Adapter();
      const oneByone = [uuid16(0xfff1), uuid16(0xfff4)];
      const inlife = [uuid16(0xfff1), uuid16(0xfff2)];
      expect(adapter.matches(mockPeripheral('', [], undefined, oneByone))).toBe(false);
      expect(adapter.matches(mockPeripheral('', [], undefined, inlife))).toBe(false);
    });

    it('does not match unrelated devices', () => {
      const adapter = new KoogeekS1Adapter();
      expect(adapter.matches(mockPeripheral('000fatscale01', ['fff0']))).toBe(false);
      expect(adapter.matches(mockPeripheral('Random Scale'))).toBe(false);
    });
  });

  describe('buildAck()', () => {
    it('answers the real init frame with 55 AA 55 AA 81 01 01 81', () => {
      const adapter = new KoogeekS1Adapter();
      const ack = adapter.buildAck(INIT_FRAME);
      expect(ack).toEqual([0x55, 0xaa, 0x55, 0xaa, 0x81, 0x01, 0x01, 0x81]);
    });

    it('answers a command 0x07 query by echoing data[6]', () => {
      const adapter = new KoogeekS1Adapter();
      const query = withChecksum([0x55, 0xaa, 0x55, 0xaa, 0x07, 0x01, 0x2a]);
      const ack = adapter.buildAck(query) as number[];
      expect(ack.slice(0, 7)).toEqual([0x55, 0xaa, 0x55, 0xaa, 0x87, 0x01, 0x2a]);
      expect(ack[7]).toBe(xorChecksum(ack.slice(0, 7), 0, 7));
    });

    it('does not acknowledge data frames, foreign frames, or bad checksums', () => {
      const adapter = new KoogeekS1Adapter();
      expect(adapter.buildAck(STABLE_FRAME)).toBeNull();
      expect(adapter.buildAck(Buffer.from([0x01, 0x02, 0x03, 0x04]))).toBeNull();
      expect(adapter.buildAck(Buffer.from([0x55, 0xaa, 0x55, 0xaa, 0x01, 0x01, 0x01, 0x00]))).toBe(
        null,
      );
    });

    it('writes the acknowledgement without a response', () => {
      expect(new KoogeekS1Adapter().ackWithResponse).toBe(false);
    });
  });

  describe('parseNotification()', () => {
    it('parses the real stable frame as 78.3 kg and 470 ohm', () => {
      const adapter = new KoogeekS1Adapter();
      const reading = adapter.parseNotification(STABLE_FRAME);
      expect(reading).not.toBeNull();
      expect(reading!.weight).toBeCloseTo(78.3, 2);
      expect(reading!.impedance).toBe(470);
      expect(adapter.isComplete(reading!)).toBe(true);
      expect(adapter.isFinal(reading!)).toBe(true);
    });

    it('parses a live frame but never completes on it', () => {
      const adapter = new KoogeekS1Adapter();
      const live = withChecksum([
        0x55, 0xaa, 0x55, 0xaa, 0x02, 0x01, 0, 0, 0, 0x03, 0x20, 0x01, 0xf4,
      ]);
      const reading = adapter.parseNotification(live);
      expect(reading!.weight).toBeCloseTo(80.0, 2);
      expect(reading!.impedance).toBe(500);
      expect(adapter.isComplete(reading!)).toBe(false);
    });

    it('rejects the init frame, foreign frames, and a corrupted checksum', () => {
      const adapter = new KoogeekS1Adapter();
      expect(adapter.parseNotification(INIT_FRAME)).toBeNull();
      expect(adapter.parseNotification(Buffer.from([0x02, 0xd2, 0x00]))).toBeNull();
      const corrupted = Buffer.from(STABLE_FRAME);
      corrupted[corrupted.length - 1] ^= 0xff;
      expect(adapter.parseNotification(corrupted)).toBeNull();
    });

    it('rejects an out of range weight', () => {
      const adapter = new KoogeekS1Adapter();
      const huge = withChecksum([
        0x55, 0xaa, 0x55, 0xaa, 0x03, 0x01, 0, 0, 0, 0xff, 0xff, 0x01, 0xf4,
      ]);
      expect(adapter.parseNotification(huge)).toBeNull();
    });

    it('clears the stable flag when a live frame follows a stable one', () => {
      const adapter = new KoogeekS1Adapter();
      const stable = adapter.parseNotification(STABLE_FRAME)!;
      expect(adapter.isComplete(stable)).toBe(true);
      const live = withChecksum([
        0x55, 0xaa, 0x55, 0xaa, 0x02, 0x01, 0, 0, 0, 0x03, 0x20, 0x01, 0xf4,
      ]);
      const after = adapter.parseNotification(live)!;
      expect(adapter.isComplete(after)).toBe(false);
    });
  });

  describe('isComplete() / isFinal()', () => {
    it('completes a stable weight even when impedance is zero, but not as final', () => {
      // Standing in socks: the scale reports a stable weight with no impedance.
      // Gating completion on impedance would hang the read until timeout.
      const adapter = new KoogeekS1Adapter();
      const noImp = withChecksum([0x55, 0xaa, 0x55, 0xaa, 0x03, 0x01, 0, 0, 0, 0x03, 0x20, 0, 0]);
      const reading = adapter.parseNotification(noImp)!;
      expect(reading.impedance).toBe(0);
      expect(adapter.isComplete(reading)).toBe(true);
      expect(adapter.isFinal(reading)).toBe(false);
    });
  });

  describe('computeMetrics()', () => {
    it('produces an in-range payload through the BIA path', () => {
      const adapter = new KoogeekS1Adapter();
      const reading = adapter.parseNotification(STABLE_FRAME)!;
      const payload = adapter.computeMetrics(reading, defaultProfile());
      expect(payload.weight).toBeCloseTo(78.3, 2);
      expect(payload.impedance).toBe(470);
      assertPayloadRanges(payload);
    });

    it('falls back to the BMI estimate when impedance is missing', () => {
      const adapter = new KoogeekS1Adapter();
      const payload = adapter.computeMetrics({ weight: 78.3, impedance: 0 }, defaultProfile());
      expect(payload.impedance).toBe(0);
      assertPayloadRanges(payload);
    });
  });
});

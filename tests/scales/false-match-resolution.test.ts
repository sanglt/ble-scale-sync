import { describe, it, expect } from 'vitest';
import { adapters } from '../../src/scales/index.js';
import { resolveAdapter } from '../../src/scales/resolve.js';
import { uuid16 } from '../../src/scales/body-comp-helpers.js';
import type { BleDeviceInfo } from '../../src/interfaces/scale-adapter.js';

/**
 * Post-discovery adapter resolution guards for the FFF0 / 0x181B false-match
 * class (#255, #258, #251). Unlike the array-order collision guard, these use
 * the real `resolveAdapter` precedence authority and populate
 * `characteristicUuids`, reproducing the exact info the fixed proxy /
 * MAC-pinned paths now build after GATT discovery.
 */
describe('false-match resolution (#255 / #258 / #251)', () => {
  it('#255: Beurer BF950 (bare 0x181B, no Mi vendor char) resolves to Standard GATT, not Xiaomi', () => {
    const info: BleDeviceInfo = {
      localName: 'BF950',
      serviceUuids: [uuid16(0x181b), uuid16(0x181d)],
      // Standard BCS/WSS characteristics plus proprietary faa1/faa2, but
      // crucially NOT the Mi vendor history char 00002a2f...af100700.
      characteristicUuids: [uuid16(0x2a9d), uuid16(0x2a2f), uuid16(0xfaa1), uuid16(0xfaa2)],
    };
    const resolved = resolveAdapter(info, adapters);
    expect(resolved?.name).toBe('Standard GATT (BCS/WSS)');
    expect(resolved?.name).not.toBe('Xiaomi Mi Scale 2');
  });

  it('#258: QN-family Elis 1 (ae01/ae02 + generic fff1/fff2) resolves to QN Scale, not Eufy P2', () => {
    // Autonomous mqtt-proxy connect: no advertised name, chars only.
    const info: BleDeviceInfo = {
      localName: '',
      serviceUuids: [],
      characteristicUuids: [uuid16(0xae01), uuid16(0xae02), uuid16(0xfff1), uuid16(0xfff2)],
    };
    const resolved = resolveAdapter(info, adapters);
    expect(resolved?.name).toBe('QN Scale');
    expect(resolved?.name).not.toBe('Eufy Smart Scale P2/P2 Pro');
  });

  it('#251: Eufy P1 "T9147" (fff1 + fff4, no fff2) resolves to 1byone (Eufy), not Inlife', () => {
    const info: BleDeviceInfo = {
      localName: 'eufy T9147',
      serviceUuids: [uuid16(0xfff0)],
      characteristicUuids: [uuid16(0xfff1), uuid16(0xfff4)],
    };
    const resolved = resolveAdapter(info, adapters);
    expect(resolved?.name).toBe('1byone (Eufy)');
    expect(resolved?.name).not.toBe('Inlife');
  });
});

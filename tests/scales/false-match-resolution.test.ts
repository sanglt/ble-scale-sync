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
  // The #255 log shows this scale advertising the exact name "BF950" and
  // exposing the SIG User Data / User Control Point set, so it is a Beurer SIG
  // consent+bond scale and now routes to BeurerBf720Adapter (priority 220).
  // Standard GATT was never able to read it: it sends a code-0 consent on an
  // unbonded link, which is why the reporter saw subscribe-then-timeout. The
  // not-Xiaomi assertion is the actual #255 regression guard and is kept.
  it('#255: Beurer BF950 (bare 0x181B, no Mi vendor char) resolves to Beurer, not Xiaomi', () => {
    const info: BleDeviceInfo = {
      localName: 'BF950',
      serviceUuids: [uuid16(0x181b), uuid16(0x181d)],
      // Standard BCS/WSS characteristics plus proprietary faa1/faa2, but
      // crucially NOT the Mi vendor history char 00002a2f...af100700.
      characteristicUuids: [uuid16(0x2a9d), uuid16(0x2a2f), uuid16(0xfaa1), uuid16(0xfaa2)],
    };
    const resolved = resolveAdapter(info, adapters);
    expect(resolved?.name).toBe('Beurer BF720/BF105');
    expect(resolved?.name).not.toBe('Xiaomi Mi Scale 2');
  });

  // Same scale seen on the MAC-pinned post-connect path, where node-ble supplies
  // no advertised name. It exposes a vendor 0xFFF0 service alongside its SIG
  // stack, which used to hand it to QN Scale at priority 250 (#229: the reporter
  // saw it alternate between QN Scale and Standard GATT). The SIG User Control
  // Point now excludes it from QN's nameless fallback.
  it('#229: nameless SIG consent scale with vendor fff0 does not resolve to QN Scale', () => {
    const info: BleDeviceInfo = {
      localName: '',
      serviceUuids: [uuid16(0x181b), uuid16(0x181d), uuid16(0x181c), uuid16(0xfff0)],
      characteristicUuids: [uuid16(0x2a9d), uuid16(0x2a9c), uuid16(0x2a9f), uuid16(0x2a9b)],
    };
    expect(resolveAdapter(info, adapters)?.name).not.toBe('QN Scale');
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

  const KOOGEEK_CHARS = [0xfff1, 0xfff2, 0xfff3, 0xfff4, 0xfff5, 0xfff6].map(uuid16);

  it('#270: a named Koogeek-S1 resolves to Koogeek-S1, not Inlife', () => {
    const info: BleDeviceInfo = {
      localName: 'Koogeek-S1',
      serviceUuids: [uuid16(0xfff0)],
      characteristicUuids: KOOGEEK_CHARS,
    };
    const resolved = resolveAdapter(info, adapters);
    expect(resolved?.name).toBe('Koogeek-S1');
    expect(resolved?.name).not.toBe('Inlife');
  });

  it('#270: Koogeek never claims a nameless device carrying its characteristics', () => {
    // Koogeek matches on name only. A structural match would claim a nameless
    // Eufy P2 on the ESP32 autonomous path, because Eufy's own matcher returns
    // false without a name and priority therefore cannot protect it.
    const info: BleDeviceInfo = {
      localName: '',
      serviceUuids: [],
      characteristicUuids: KOOGEEK_CHARS,
    };
    expect(resolveAdapter(info, adapters)?.name).not.toBe('Koogeek-S1');
  });

  it('#270: Koogeek does not steal a nameless 1byone or a nameless Inlife', () => {
    const oneByone: BleDeviceInfo = {
      localName: '',
      serviceUuids: [],
      characteristicUuids: [uuid16(0xfff1), uuid16(0xfff4)],
    };
    expect(resolveAdapter(oneByone, adapters)?.name).toBe('1byone (Eufy)');

    const inlife: BleDeviceInfo = {
      localName: '',
      serviceUuids: [],
      characteristicUuids: [uuid16(0xfff1), uuid16(0xfff2)],
    };
    expect(resolveAdapter(inlife, adapters)?.name).toBe('Inlife');
  });

  it('#272: QN Type-1 (ffe1/ffe3, nameless ESP32 payload) resolves to QN Scale, not Yunmai', () => {
    // Renpho ES-CM20 over the ESP32 autonomous connect: no advertised name, no
    // service UUIDs, only the Type-1 char set. Yunmai's notify char 0xFFE4 is
    // present, so the proxy's notify-only fallback used to mis-pick Yunmai and
    // then hang on the missing write char 0xFFE9. The FFE1+FFE3 structural
    // signature must resolve to QN before any fallback runs.
    const info: BleDeviceInfo = {
      localName: '',
      serviceUuids: [],
      characteristicUuids: [0xffe1, 0xffe2, 0xffe3, 0xffe4, 0xffe5].map(uuid16),
    };
    const resolved = resolveAdapter(info, adapters);
    expect(resolved?.name).toBe('QN Scale');
    expect(resolved?.name).not.toBe('Yunmai');
  });
});

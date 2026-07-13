import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
import { _internals } from '../../../src/ble/handler-esphome-proxy/client.js';

const nodeRequire = createRequire(import.meta.url);

/**
 * Regression guard for #252.
 *
 * `@2colors/esphome-native-api` 1.3.6 tears the proxy connection down whenever the
 * ESPHome node sends an API message id it does not know (id 137,
 * InfraredRFReceiveEvent, fires on every IR/RF event). We repair
 * `FrameHelper.prototype.buildMessage` at runtime. This suite deliberately does NOT
 * mock the library: it asserts against the real prototype, so a future upgrade that
 * moves these internals fails here instead of silently reintroducing the bug.
 */
describe('ESPHome unknown-message patch (#252)', () => {
  // Applying the patch mutates the real FrameHelper prototype for this process.
  // That is exactly the production behaviour, and no other suite drives the real
  // frame helper (they mock the package root).
  _internals.patchUnknownMessageHandling();

  const FrameHelper = nodeRequire('@2colors/esphome-native-api/lib/utils/frameHelper.js');
  const { id_to_type, pb } = nodeRequire('@2colors/esphome-native-api/lib/utils/messages.js');

  /** Stand-in for the frame-helper instance `buildMessage` is invoked on. */
  function fakeHelper() {
    return { emit: vi.fn(), end: vi.fn() };
  }

  it('library internals still have the expected shape', () => {
    expect(typeof FrameHelper?.prototype?.buildMessage).toBe('function');
    expect(id_to_type[1]).toBe('HelloRequest');
    // The IR/RF event this library version cannot decode.
    expect(id_to_type[137]).toBeUndefined();
  });

  it('ignores an unknown message id without ending the connection', () => {
    const self = fakeHelper();
    const msg = FrameHelper.prototype.buildMessage.call(self, 137, Buffer.alloc(0)) as {
      constructor: { type: string };
      toObject: () => unknown;
    };

    expect(msg).toBeDefined();
    expect(msg.constructor.type).toBe('UnknownEsphomeMessage');
    expect(msg.toObject()).toEqual({});
    // The whole point: the connection must survive an unknown id.
    expect(self.end).not.toHaveBeenCalled();
    expect(self.emit).not.toHaveBeenCalled();
  });

  it('the placeholder survives the frame helper setting .length on it', () => {
    const self = fakeHelper();
    const msg = FrameHelper.prototype.buildMessage.call(self, 137, Buffer.alloc(0)) as {
      length?: number;
    };
    // noise/plaintext deserialize() both assign message.length before returning.
    msg.length = 42;
    expect(msg.length).toBe(42);
  });

  it('still decodes a known message id', () => {
    const self = fakeHelper();
    const hello = new pb.HelloRequest();
    const bytes = hello.serializeBinary();

    const msg = FrameHelper.prototype.buildMessage.call(self, 1, bytes) as {
      constructor: { type: string };
    };

    expect(msg.constructor.type).toBe('HelloRequest');
    expect(self.end).not.toHaveBeenCalled();
  });

  it('ends the connection for a known id whose payload cannot be parsed', () => {
    const self = fakeHelper();
    const type = id_to_type[1];
    const spy = vi.spyOn(pb[type], 'deserializeBinary').mockImplementation(() => {
      throw new Error('corrupt frame');
    });

    try {
      const msg = FrameHelper.prototype.buildMessage.call(self, 1, Buffer.alloc(4));
      // Original library semantics for a desynced stream: surface + tear down.
      expect(msg).toBeUndefined();
      expect(self.end).toHaveBeenCalledTimes(1);
      expect(self.emit).toHaveBeenCalledWith('error', expect.any(Error));
    } finally {
      spy.mockRestore();
    }
  });
});

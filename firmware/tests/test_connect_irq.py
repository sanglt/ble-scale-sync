"""Host-runnable test: BleBridge.connect() restores aioble's IRQ handler (#231).

The streaming scan installs the firmware's own _ble.irq() handler on the shared
bluetooth.BLE() singleton. aioble registers its dispatcher only once at import
and never restores it, so connect() must hand the IRQ back to aioble before
calling device.connect(), or _IRQ_PERIPHERAL_CONNECT is dropped and the connect
times out.

Run: python -m unittest discover -s firmware/tests
"""

import os
import sys
import types
import unittest

_FIRMWARE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _FIRMWARE_DIR not in sys.path:
    sys.path.insert(0, _FIRMWARE_DIR)


class _MockBLE:
    def __init__(self):
        self.current_irq = None

    def active(self, value=None):
        return True

    def irq(self, handler):
        self.current_irq = handler

    def gap_scan(self, *args):
        pass


_mock_ble = _MockBLE()

_bt = types.ModuleType("bluetooth")
_bt.BLE = lambda: _mock_ble
_bt.FLAG_READ = 0x02
_bt.FLAG_WRITE = 0x08
_bt.FLAG_NOTIFY = 0x10
_bt.FLAG_WRITE_NO_RESPONSE = 0x04
_bt.FLAG_INDICATE = 0x20
sys.modules["bluetooth"] = _bt


# aioble dispatcher sentinel: connect() must install THIS on the BLE singleton.
def _aioble_ble_irq(event, data):  # noqa: ARG001
    return None


_captured = {}


class _AsyncDiscover:
    """Models aioble's ClientDiscover: an async iterator (async for), NOT a
    coroutine. The production bug was wrapping this object in asyncio.wait_for,
    which calls create_task and raises 'TypeError: coroutine expected' (#231)."""

    def __init__(self, items):
        self._items = list(items)
        self._i = 0

    def __aiter__(self):
        return self

    async def __anext__(self):
        if self._i >= len(self._items):
            raise StopAsyncIteration
        item = self._items[self._i]
        self._i += 1
        return item


class _FakeChar:
    def __init__(self, uuid, properties):
        self.uuid = uuid
        self.properties = properties


class _FakeService:
    def __init__(self, chars):
        self._chars = chars

    def characteristics(self):
        # aioble returns an async iterator here, not a coroutine.
        return _AsyncDiscover(self._chars)


class _FakeConn:
    def services(self):
        # aioble returns an async iterator here, not a coroutine. Empty by
        # default so the IRQ/addr-type tests keep asserting {"chars": []}.
        return _AsyncDiscover([])

    async def disconnect(self):
        pass

    def is_connected(self):
        return True


class _FakeConnWithChars:
    """A connection that discovers one service with two characteristics, used to
    prove connect() drives discovery via async for and maps properties (#231)."""

    def __init__(self):
        self.disconnected = False

    def services(self):
        notify_char = _FakeChar("0000fff1-0000-1000-8000-00805f9b34fb", _bt.FLAG_NOTIFY | _bt.FLAG_READ)
        write_char = _FakeChar("0000fff2-0000-1000-8000-00805f9b34fb", _bt.FLAG_WRITE_NO_RESPONSE)
        return _AsyncDiscover([_FakeService([notify_char, write_char])])

    async def disconnect(self):
        self.disconnected = True

    def is_connected(self):
        return True


class _FakeDevice:
    def __init__(self, addr_type, addr_bytes):
        self._addr_type = addr_type

    async def connect(self, timeout_ms=None, scan_duration_ms=None):
        # Snapshot which IRQ handler owns the singleton at connect time.
        _captured["irq_at_connect"] = _mock_ble.current_irq
        _captured["addr_type"] = self._addr_type
        return _FakeConn()


_aioble_core = types.ModuleType("aioble.core")
_aioble_core.ble_irq = _aioble_ble_irq

_aioble = types.ModuleType("aioble")
_aioble.core = _aioble_core
_aioble.ADDR_PUBLIC = 0
_aioble.ADDR_RANDOM = 1
_aioble.Device = _FakeDevice
sys.modules["aioble"] = _aioble
sys.modules["aioble.core"] = _aioble_core

_board = types.ModuleType("board")
_board.MAX_SCAN_ENTRIES = 500
_board.AGGRESSIVE_GC = False
_board.DEACTIVATE_BLE_AFTER_SCAN = False
_board.CONNECT_TIMEOUT_MS = 15000
_board.CONNECT_SCAN_MS = 15000
_board.CONNECT_RETRIES = 1
sys.modules["board"] = _board

# Another test module (test_auto_connect) stubs sys.modules["ble_bridge"] with a
# SimpleNamespace that has no connect(). When the whole suite is discovered in one
# process that stub may already be cached, so drop it to force a real import of the
# firmware module under the stubs installed above.
sys.modules.pop("ble_bridge", None)
import ble_bridge  # noqa: E402


class TestConnectRestoresAiobleIrq(unittest.IsolatedAsyncioTestCase):
    """connect() must reclaim the BLE IRQ for aioble after a streaming scan (#231)."""

    async def test_irq_restored_before_connect(self):
        _captured.clear()
        bridge = ble_bridge.BleBridge()

        # Streaming scan installs the firmware's scan-only handler, clobbering
        # aioble's dispatcher (the production bug's precondition).
        bridge.start_streaming()
        self.assertIsNot(_mock_ble.current_irq, _aioble_core.ble_irq)

        await bridge.connect("FF:03:00:53:D6:4D", 1)

        # By the time aioble's Device.connect() ran, aioble's dispatcher must own
        # the IRQ, otherwise _IRQ_PERIPHERAL_CONNECT is dropped and it times out.
        self.assertIs(_captured["irq_at_connect"], _aioble_core.ble_irq)
        self.assertEqual(_captured["addr_type"], 1)  # reported type (1) probed first

    async def test_public_scale_probes_reported_type_first(self):
        # Regression for #231: the QN-Scale advertises as public (addr_type=0).
        # connect() must probe the reported type (public=0) first, not force
        # random from the FF MAC bits, or it never matches the advertiser.
        _captured.clear()
        bridge = ble_bridge.BleBridge()
        bridge.start_streaming()
        await bridge.connect("FF:03:00:53:D6:4D", 0)
        self.assertEqual(_captured["addr_type"], 0)


class TestConnectFallbackTriesOppositeType(unittest.IsolatedAsyncioTestCase):
    """connect() falls back to the opposite address type on any connect failure,
    not only a TimeoutError. A re-entry after a wrong-type timeout surfaced a
    TypeError, which previously stranded the connect on one type (#231)."""

    async def test_opposite_type_tried_after_non_timeout_error(self):
        attempts = []

        class _FailFirstDevice:
            def __init__(self, addr_type, addr_bytes):
                self._addr_type = addr_type

            async def connect(self, timeout_ms=None, scan_duration_ms=None):
                attempts.append(self._addr_type)
                if len(attempts) == 1:
                    raise TypeError("coroutine expected")
                return _FakeConn()

        orig_device = _aioble.Device
        _aioble.Device = _FailFirstDevice
        try:
            bridge = ble_bridge.BleBridge()
            result = await bridge.connect("84:FC:E6:53:06:1C", 0)
        finally:
            _aioble.Device = orig_device

        # Public reported -> probe order (0, 1). The first attempt (0) raises a
        # non-timeout TypeError; the fallback (1) must still run and succeed.
        self.assertEqual(attempts, [0, 1])
        self.assertEqual(result, {"chars": []})


class TestConnectDiscoversCharsViaAsyncFor(unittest.IsolatedAsyncioTestCase):
    """connect() must drive aioble's async-iterator services()/characteristics()
    with `async for`. Wrapping the iterator in asyncio.wait_for raised
    'TypeError: coroutine expected' and stranded the autonomous connect (#231)."""

    async def test_discovery_yields_mapped_characteristics(self):
        conn = _FakeConnWithChars()

        class _DeviceReturningConn:
            def __init__(self, addr_type, addr_bytes):
                self._addr_type = addr_type

            async def connect(self, timeout_ms=None, scan_duration_ms=None):
                return conn

        orig_device = _aioble.Device
        _aioble.Device = _DeviceReturningConn
        try:
            bridge = ble_bridge.BleBridge()
            result = await bridge.connect("84:FC:E6:53:06:1C", 0)
        finally:
            _aioble.Device = orig_device

        uuids = [c["uuid"] for c in result["chars"]]
        self.assertEqual(
            uuids,
            [
                "0000fff100001000800000805f9b34fb",
                "0000fff200001000800000805f9b34fb",
            ],
        )
        # Property bitmask -> string list mapping is preserved.
        by_uuid = {c["uuid"]: c["properties"] for c in result["chars"]}
        self.assertEqual(
            sorted(by_uuid["0000fff100001000800000805f9b34fb"]),
            ["notify", "read"],
        )
        self.assertEqual(
            by_uuid["0000fff200001000800000805f9b34fb"],
            ["write-without-response"],
        )
        # The discovered chars are cached on the bridge for start_notify().
        self.assertIn("0000fff100001000800000805f9b34fb", bridge._chars)


if __name__ == "__main__":
    unittest.main()

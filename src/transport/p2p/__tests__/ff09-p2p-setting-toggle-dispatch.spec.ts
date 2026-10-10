import { describe, it, expect, vi } from "vitest";
import { P2PCommandRouter, type P2PRouterDeps } from "../command-router.js";
import { decryptFf09Frame, LOCK_API_COMMAND, FF09_SETTING_ID } from "../../ff09.js";
import { connectedSession, type FakeP2PSession } from "./session-fixtures.js";

/**
 * `sendFf09SettingToggle` (the `ff09-setting-toggle` intent handler behind
 * `dev.lock()?.setRainMode`) — much simpler than `ff09-p2p-settings-dispatch.spec.ts`'s GET-then-SET
 * flow: a pure blind fire-and-forget SET, no reply wait. Same fake-session mocking approach as that
 * file, minus the GET reply plumbing (there is none to fake here).
 */
const ADMIN = "0000000000000000000000000000000000000000";
const SN = "T8531K0000000000";
const STATION_SN = "T8030P0000000000";

interface FakeSession extends FakeP2PSession {
  sendControlLevel2: (cmd: number, channel: number, accountId: string, payload: unknown, mValue3?: number) => boolean;
}

interface Call {
  cmd: number;
  channel: number;
  payload: { apiCommand: number; lock_payload: string; seq_num: number; time: number };
}

function makeRouter() {
  const calls: Call[] = [];
  const session = connectedSession() as FakeSession;
  session.sendControlLevel2 = vi.fn((cmd, channel, _accountId, payload) => {
    calls.push({ cmd, channel, payload: payload as Call["payload"] });
    return true;
  });

  const deps: P2PRouterDeps = {
    mega: {} as P2PRouterDeps["mega"],
    listDevices: () => [{ sn: SN, stationSn: STATION_SN, channel: 1, raw: { device_channel: 1 } } as any],
    ensureDevices: async () => {},
    onConnect: () => {},
    onClose: () => {},
    onError: () => {},
    onLevel2Ready: () => {},
    onFrame: () => {},
  };
  const router = new P2PCommandRouter(deps);
  (router as unknown as { manager: { register(sn: string, s: unknown): void } }).manager.register(STATION_SN, session);
  return { router, calls };
}

describe("P2PCommandRouter.sendFf09SettingToggle (ff09-setting-toggle command-router branch)", () => {
  it("sends a single blind SET_SETTINGS frame encoding the setting id + value, no GET first", async () => {
    const { router, calls } = makeRouter();
    await router.dispatchCommand(SN, {
      kind: "ff09-setting-toggle",
      adminUserId: ADMIN,
      deviceSn: SN,
      settingId: FF09_SETTING_ID.RAIN_MODE,
      value: true,
    });

    const setCalls = calls.filter((c) => c.payload.apiCommand === LOCK_API_COMMAND.SET_SETTINGS);
    expect(setCalls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.channel === 1)).toBe(true); // re-resolved from the device record (intent carries none)
    // No GET ever went out — unlike the ff09-autolock RMW, this is a pure blind write.
    expect(calls.some((c) => c.payload.apiCommand === LOCK_API_COMMAND.GET_SETTINGS)).toBe(false);

    const last = setCalls[0]!.payload;
    const plain = decryptFf09Frame({
      lockPayload: last.lock_payload,
      keyTime: last.time,
      adminUserId: ADMIN,
      deviceSn: SN,
    });
    // Compact TLV: a1(time) a2(admin) a3(settingId) a4(value) — no a5-a9 at all.
    // Layout: [0]=0xa1 [1]=len4 [2..5]=time [6]=0xa2 [7]=len [8..8+len)=admin ascii, then a3/a4.
    const a2Len = plain[7]!;
    const a3Off = 8 + a2Len;
    expect(plain[a3Off]).toBe(0xa3);
    expect(plain[a3Off + 2]).toBe(FF09_SETTING_ID.RAIN_MODE);
    expect(plain[a3Off + 3]).toBe(0xa4);
    expect(plain[a3Off + 5]).toBe(1); // value = true
  });

  it("encodes value=false as A4=0x00", async () => {
    const { router, calls } = makeRouter();
    await router.dispatchCommand(SN, {
      kind: "ff09-setting-toggle",
      adminUserId: ADMIN,
      deviceSn: SN,
      settingId: FF09_SETTING_ID.RAIN_MODE,
      value: false,
    });
    const setCalls = calls.filter((c) => c.payload.apiCommand === LOCK_API_COMMAND.SET_SETTINGS);
    const last = setCalls[0]!.payload;
    const plain = decryptFf09Frame({
      lockPayload: last.lock_payload,
      keyTime: last.time,
      adminUserId: ADMIN,
      deviceSn: SN,
    });
    const a2Len = plain[7]!;
    const a3Off = 8 + a2Len;
    expect(plain[a3Off + 5]).toBe(0); // value = false
  });
});

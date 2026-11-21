import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { MqttCommandRouter } from "../command-router.js";
import type { EufyDevice } from "../../../core/types.js";
import { LOCK_COMMAND_CODE, CMD_TRANSFER_PAYLOAD } from "../../ff09.js";
import { buildFf09ResponseFrame } from "../../__tests__/ff09-test-fixtures.js";

/**
 * `MqttCommandRouter.getAutoLockState` (the `Ff09SettingsReader` behind `dev.lock()?.getAutoLockState()`
 * on the MQTT transport) — a pure GET, no SET, same fake-wire harness as
 * `ff09-mqtt-settings-dispatch.spec.ts` minus the SET step.
 */
const ADMIN = "0000000000000000000000000000000000000000";
const SN = "T85D0K0000000000";

function buildResponseFrame(plain: Buffer, keyTime: number): string {
  return buildFf09ResponseFrame(plain, keyTime, ADMIN, SN);
}

/** a1=enabled, a2=delaySeconds(LE u16), a3=isSchedule, a4/a5=[hour,minute] schedule start/end. */
function buildResponsePlain(opts: {
  enabled: boolean;
  delaySeconds: number;
  isSchedule: boolean;
  start: [number, number];
  end: [number, number];
}): Buffer {
  const delay = Buffer.alloc(2);
  delay.writeUInt16LE(opts.delaySeconds);
  return Buffer.concat([
    Buffer.from([0x00]), // status
    Buffer.from([0xa1, 1, opts.enabled ? 1 : 0]),
    Buffer.from([0xa2, 2]),
    delay,
    Buffer.from([0xa3, 1, opts.isSchedule ? 1 : 0]),
    Buffer.from([0xa4, 2, opts.start[0], opts.start[1]]),
    Buffer.from([0xa5, 2, opts.end[0], opts.end[1]]),
  ]);
}

interface DecodedTrans {
  cmd: number;
  payload: { apiCommand: number; lock_payload: string; seq_num: number; time: number };
}

/** The envelope's trans, its frame's opcode (the cmdEnc low bits, in the clear) and its key time. */
function decodeEnvelope(body: string): { op: number; time: number; trans: DecodedTrans } {
  const outer = JSON.parse(body);
  const payload = JSON.parse(outer.payload);
  const trans = JSON.parse(Buffer.from(payload.trans, "base64").toString("utf-8")) as DecodedTrans;
  return { op: parseInt(trans.payload.lock_payload.slice(14, 18), 16) & 0x3fff, time: trans.payload.time, trans };
}

function makeRouter(plain: Buffer, opts: { noReply?: boolean } = {}) {
  const dev = {
    sn: SN,
    category: "eufy_security",
    model: "T85D0",
    raw: { device_new_pn: "T85D0" },
  } as unknown as EufyDevice;
  const router = new MqttCommandRouter({
    mega: {} as any,
    listDevices: () => [dev],
    ensureDevices: async () => {},
    onCommandAck: () => {},
    onError: () => {},
    securityTransport: async () => fakeMqtt as any,
  });

  const fakeMqtt = new EventEmitter() as EventEmitter & {
    id: string;
    publish: (topic: string, body: string, o?: unknown) => Promise<void>;
  };
  fakeMqtt.id = "client-1";
  fakeMqtt.publish = vi.fn().mockImplementation(async (_topic: string, body: string) => {
    if (opts.noReply) return;
    const { op, time } = decodeEnvelope(body);
    if (op === LOCK_COMMAND_CODE.GET_SETTINGS) {
      const lockPayload = buildResponseFrame(plain, time);
      // Mirror SecureMqtt's REAL "message" event shape (a JSON payload STRING wrapping
      // {trans: base64(innerTransObject)}) so parseFf09SettingsResponseTrans's real unwrap runs.
      const innerTrans = {
        cmd: CMD_TRANSFER_PAYLOAD,
        payload: { dev_sn: SN, lock_payload: lockPayload, time: time.toString(16) },
      };
      const transB64 = Buffer.from(JSON.stringify(innerTrans), "utf-8").toString("base64");
      fakeMqtt.emit("message", {
        topic: `cmd/eufy_security/T85D0/${SN}/res`,
        raw: { head: { cmd: 8 }, payload: JSON.stringify({ trans: transB64 }) },
      });
    }
  });
  return { router, fakeMqtt };
}

describe("MqttCommandRouter.getAutoLockState (ff09-mqtt read-only GET)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("decodes a1-a5 into a full AutoLockSnapshot", async () => {
    const plain = buildResponsePlain({
      enabled: true,
      delaySeconds: 300,
      isSchedule: true,
      start: [22, 30],
      end: [6, 15],
    });
    const { router } = makeRouter(plain);
    await expect(router.getAutoLockState(SN, { adminUserId: ADMIN, deviceSn: SN })).resolves.toEqual({
      enabled: true,
      delaySeconds: 300,
      isSchedule: true,
      scheduleStartTime: [22, 30],
      scheduleEndTime: [6, 15],
    });
  });

  it("throws if the GET reply never arrives", async () => {
    const plain = buildResponsePlain({ enabled: true, delaySeconds: 1, isSchedule: false, start: [0, 0], end: [0, 0] });
    const { router } = makeRouter(plain, { noReply: true });
    const p = router.getAutoLockState(SN, { adminUserId: ADMIN, deviceSn: SN });
    const assertion = expect(p).rejects.toThrow(/no settings GET reply/);
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
  });
});

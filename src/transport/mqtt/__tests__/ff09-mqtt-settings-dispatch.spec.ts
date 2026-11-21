import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { createCipheriv } from "node:crypto";
import { MqttCommandRouter } from "../command-router.js";
import type { EufyDevice } from "../../../core/types.js";
import { u16le, u32be } from "../../../core/util.js";
import { LOCK_COMMAND_CODE, CMD_TRANSFER_PAYLOAD } from "../../ff09.js";

/**
 * `MqttCommandRouter.dispatchCommand` on the `ff09-autolock` intent (behind `dev.lock()?.setAutoLock`)
 * — no live broker: the `securityTransport` dep hands back a fake, device resolution comes from the injected
 * `listDevices`, and the "MQTT connection" is a bare EventEmitter standing in for `SecureMqtt`, same style
 * as `ff09-mqtt-dispatch.spec.ts`. The `publish` mock inspects each outbound envelope (GET vs SET, by
 * opcode) and, for the GET, emits a synthetic-but-correctly-encrypted device reply built with the
 * SAME cipher `transport/ff09.ts` documents (own local encryptor here, since the library has no response
 * ENCODER — only a device builds real ones) — so the whole GET→decrypt→SET flow runs for real, just
 * against a fake wire.
 */
const ADMIN = "0000000000000000000000000000000000000000";
const SN = "T85D0K0000000000";

/** Build a minimally-valid ff09 response frame wrapping `plain` (mirrors decryptFf09Frame's own doc). */
function buildResponseFrame(plain: Buffer, keyTime: number): string {
  const key = Buffer.concat([Buffer.from(ADMIN.slice(-12), "ascii"), u32be(keyTime)]);
  const iv = Buffer.alloc(16);
  Buffer.from(SN, "ascii").copy(iv);
  const cipher = createCipheriv("aes-128-cbc", key, iv);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  const body = Buffer.concat([Buffer.from([0x03, 0x00, 0x02]), Buffer.from([0x48, 0x35]), ct]);
  const size = 2 + 2 + body.length + 1;
  const sizeBuf = Buffer.alloc(2);
  sizeBuf.writeUInt16LE(size);
  const preXor = Buffer.concat([Buffer.from([0xff, 0x09]), sizeBuf, body]);
  let xor = 0;
  for (const b of preXor) xor ^= b;
  return Buffer.concat([preXor, Buffer.from([xor])]).toString("hex");
}

/** The settings-response TLV: status + a1..a6 (only a2/a4/a5/a6 matter to the dispatcher). */
function buildResponsePlain(delaySeconds: number, a7: number, a8: number, currentlyEnabled: boolean): Buffer {
  return Buffer.concat([
    Buffer.from([0x00]), // status
    Buffer.from([0xa1, 1, 1]),
    Buffer.from([0xa2, 2]),
    u16le(delaySeconds),
    Buffer.from([0xa3, 1, 0]),
    Buffer.from([0xa4, 2]),
    u16le(a7),
    Buffer.from([0xa5, 2]),
    u16le(a8),
    Buffer.from([0xa6, 1, currentlyEnabled ? 1 : 0]),
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

function makeRouter(opts: { delay: number; a7: number; a8: number; currentlyEnabled: boolean }) {
  const dev = {
    sn: SN,
    category: "eufy_security",
    model: "T85D0",
    raw: { device_new_pn: "T85D0" },
  } as unknown as EufyDevice;
  const acks: any[] = [];
  const router = new MqttCommandRouter({
    mega: {} as any,
    listDevices: () => [dev],
    ensureDevices: async () => {},
    onCommandAck: (info) => acks.push(info),
    onError: () => {},
    securityTransport: async () => fakeMqtt as any,
  });

  const fakeMqtt = new EventEmitter() as EventEmitter & {
    id: string;
    publish: (topic: string, body: string, o?: unknown) => Promise<void>;
  };
  fakeMqtt.id = "client-1";

  const publishedBodies: string[] = [];
  fakeMqtt.publish = vi.fn().mockImplementation(async (_topic: string, body: string) => {
    publishedBodies.push(body);
    const { op, time } = decodeEnvelope(body);
    if (op === LOCK_COMMAND_CODE.GET_SETTINGS) {
      const plain = buildResponsePlain(opts.delay, opts.a7, opts.a8, opts.currentlyEnabled);
      const lockPayload = buildResponseFrame(plain, time);
      // Mirror SecureMqtt's REAL "message" event shape (secure-mqtt.ts JSON-parses the outer MQTT
      // payload bytes into {head, payload}, where `payload` is itself a JSON STRING wrapping
      // {trans: base64(innerTransObject)}) — not the shortcut of handing the inner object directly,
      // which would let this test pass without exercising parseFf09SettingsResponseTrans's real unwrap.
      const innerTrans = {
        cmd: CMD_TRANSFER_PAYLOAD,
        payload: { dev_sn: SN, lock_payload: lockPayload, time: time.toString(16) },
      };
      const transB64 = Buffer.from(JSON.stringify(innerTrans), "utf-8").toString("base64");
      fakeMqtt.emit("message", {
        topic: `cmd/eufy_security/T85D0/${SN}/res`,
        raw: { head: { cmd: 8 }, payload: JSON.stringify({ trans: transB64 }) },
      });
    } else if (op === LOCK_COMMAND_CODE.SET_SETTINGS) {
      fakeMqtt.emit("message", { topic: `cmd/eufy_security/T85D0/${SN}/res`, raw: { head: { cmd: 8 } } });
    }
  });

  return { router, fakeMqtt, publishedBodies, acks };
}

describe("MqttCommandRouter.dispatchCommand (ff09-autolock)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("GETs current settings then SETs, changing only A4/A5 and preserving A7/A8 read from the GET reply", async () => {
    const { router, publishedBodies } = makeRouter({ delay: 59, a7: 11, a8: 22, currentlyEnabled: false });

    const cmd = {
      kind: "ff09-autolock" as const,
      adminUserId: ADMIN,
      deviceSn: SN,
      enabled: true,
      delaySeconds: 200,
    };
    await router.dispatchCommand(SN, cmd);

    expect(publishedBodies).toHaveLength(2);
    const get = decodeEnvelope(publishedBodies[0]!);
    const set = decodeEnvelope(publishedBodies[1]!);
    expect([get.op, set.op]).toEqual([LOCK_COMMAND_CODE.GET_SETTINGS, LOCK_COMMAND_CODE.SET_SETTINGS]);
    expect([get.trans.payload.apiCommand, set.trans.payload.apiCommand]).toEqual([
      CMD_TRANSFER_PAYLOAD,
      CMD_TRANSFER_PAYLOAD,
    ]);
    expect([get.trans.payload.seq_num, set.trans.payload.seq_num], "a per-device counter").toEqual([1, 2]);

    // Decode the SET frame's TLV to check the actual bytes sent — A4=enable(1), A5=delay(200 LE),
    // A7/A8 = the GET reply's a4/a5 values (11, 22), not hardcoded/guessed.
    const { decryptFf09Frame, parseFf09SettingsResponse: parseTlv } = await import("../../ff09.js");
    const plain = decryptFf09Frame({
      lockPayload: set.trans.payload.lock_payload as string,
      keyTime: set.trans.payload.time as number,
      adminUserId: ADMIN,
      deviceSn: SN,
    });
    // The SET plaintext has no leading status byte (that's a response-only field) — parse from offset 0
    // by treating byte 0 as a fake "status" so the shared a1.. walker lines up with A1..A9.
    const parsed = parseTlv(Buffer.concat([Buffer.from([0]), plain]));
    expect(parsed.fields.get(0xa4)?.[0]).toBe(1); // enable = true
    expect(parsed.fields.get(0xa5)?.readUInt16LE(0)).toBe(200); // delay override
    expect(parsed.fields.get(0xa7)?.readUInt16LE(0)).toBe(11); // preserved from GET
    expect(parsed.fields.get(0xa8)?.readUInt16LE(0)).toBe(22); // preserved from GET
    expect(parsed.fields.get(0xa3)?.[0]).toBe(0); // fixed observed constant
    expect(parsed.fields.get(0xa6)?.[0]).toBe(0);
    expect(parsed.fields.get(0xa9)?.[0]).toBe(0);
  });

  it("preserves the current delay when delaySeconds is omitted", async () => {
    const { router, publishedBodies } = makeRouter({ delay: 77, a7: 1, a8: 2, currentlyEnabled: true });
    const cmd = {
      kind: "ff09-autolock" as const,
      adminUserId: ADMIN,
      deviceSn: SN,
      enabled: false,
      // no delaySeconds
    };
    await router.dispatchCommand(SN, cmd);

    const set = decodeEnvelope(publishedBodies[1]!);
    const { decryptFf09Frame, parseFf09SettingsResponse: parseTlv } = await import("../../ff09.js");
    const plain = decryptFf09Frame({
      lockPayload: set.trans.payload.lock_payload as string,
      keyTime: set.trans.payload.time as number,
      adminUserId: ADMIN,
      deviceSn: SN,
    });
    const parsed = parseTlv(Buffer.concat([Buffer.from([0]), plain]));
    expect(parsed.fields.get(0xa5)?.readUInt16LE(0)).toBe(77); // preserved current delay
    expect(parsed.fields.get(0xa4)?.[0]).toBe(0); // enable = false
  });

  it("throws if the GET reply never arrives (refuses to write settings blind)", async () => {
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
      publish: (topic: string, body: string) => Promise<void>;
    };
    fakeMqtt.id = "client-1";
    fakeMqtt.publish = vi.fn().mockResolvedValue(undefined); // never replies

    const cmd = {
      kind: "ff09-autolock" as const,
      adminUserId: ADMIN,
      deviceSn: SN,
      enabled: true,
    };
    const p = router.dispatchCommand(SN, cmd);
    const assertion = expect(p).rejects.toThrow(/no settings GET reply/);
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
  });

  it("does not throw when the SET step gets no ack (fire-and-forget), reports it via commandAck", async () => {
    const dev = {
      sn: SN,
      category: "eufy_security",
      model: "T85D0",
      raw: { device_new_pn: "T85D0" },
    } as unknown as EufyDevice;
    const acks: any[] = [];
    const router = new MqttCommandRouter({
      mega: {} as any,
      listDevices: () => [dev],
      ensureDevices: async () => {},
      onCommandAck: (info) => acks.push(info),
      onError: () => {},
      securityTransport: async () => fakeMqtt as any,
    });
    const fakeMqtt = new EventEmitter() as EventEmitter & {
      id: string;
      publish: (topic: string, body: string) => Promise<void>;
    };
    fakeMqtt.id = "client-1";
    fakeMqtt.publish = vi.fn().mockImplementation(async (_topic: string, body: string) => {
      const { op, time } = decodeEnvelope(body);
      if (op === LOCK_COMMAND_CODE.GET_SETTINGS) {
        const plain = buildResponsePlain(90, 1, 2, true);
        const lockPayload = buildResponseFrame(plain, time);
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
      // SET publish: no reply at all
    });

    const cmd = {
      kind: "ff09-autolock" as const,
      adminUserId: ADMIN,
      deviceSn: SN,
      enabled: true,
    };
    const p = router.dispatchCommand(SN, cmd);
    await vi.advanceTimersByTimeAsync(5000);
    await expect(p).resolves.toBeUndefined();
    expect(acks).toEqual([{ sn: SN, kind: "ff09-autolock", getAcked: true, acked: false }]);
  });
});

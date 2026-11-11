import type { CommandSink } from "../../../core/contracts.js";
import { RTSP, RTSP_PARAM, RtspRecordingMode, type RtspActions } from "../rtsp.js";
import { bind } from "./bind.js";
import { Device } from "../../device.js";
import type { CommandContext, InboundSignal } from "../types.js";

const ctx = {
  channel: 2,
  codec: "camera",
  serial: "T8000P0000000000",
  paramIds: new Set([1145, 6050]),
} as CommandContext;

describe("rtsp capability module", () => {
  it("declares the capability + schema", () => {
    expect(RTSP.capability).toBe("rtsp");
    expect(RTSP.properties.map((p) => p.name)).toEqual(["rtspStream", "rtspUrl", "recordingMode"]);
  });

  it("owns the publish switch and marks it writable, grounded in a live write", () => {
    const [prop] = RTSP.properties;
    expect(prop.paramType).toBe(RTSP_PARAM.STREAM_SWITCH);
    expect(prop.paramType).toBe(1145);
    expect(prop.type).toBe("bool");
    expect(prop.writable).toBe(true);
    // provenance is NAME-trust: the name is the app's own typo'd constant, so it is "apk"; the
    // verified live effect lives in the note (see the resolved review thread on #111).
    expect(prop.provenance).toBe("apk");
  });

  /**
   * `recordingMode` has no `write` of its own — one change is a PAIR of frames, which only a method can
   * send — so deriving `writable` from `write` alone published it as read-only while `setRecordingMode`
   * sat on the bound object. `writtenElsewhere` is what states that, and `action-specs.spec.ts` proves
   * the setter it promises is really reachable.
   */
  it("publishes recordingMode as writable even though its setter is a method, not a member write", () => {
    const prop = RTSP.properties.find((p) => p.name === "recordingMode")!;
    expect(prop.writable).toBe(true);
    expect(bind<RtspActions>("rtsp", ctx).acts.setRecordingMode).toBeTypeOf("function");
  });

  it("detects on the reported param alone, never a model table", () => {
    expect(RTSP.detection?.evidenceParams).toEqual([RTSP_PARAM.STREAM_SWITCH]);
    expect(RTSP.detection?.deviceTypes).toBeUndefined();
    expect(RTSP.detection?.modelHints).toBeUndefined();
    expect(RTSP.detection?.codecs).toBeUndefined();
  });

  it("exposes the published state as a typed read off the backing property", () => {
    const published = RTSP.members!.published as { property?: string };
    expect(published.property).toBe("rtspStream");
    expect(RTSP.properties.some((p) => p.name === published.property)).toBe(true);
  });

  it("publishes and withdraws as a scalar write on the camera's own channel", async () => {
    const { acts: actions, sent } = bind<RtspActions>("rtsp", ctx);

    await actions.publish!();
    await actions.withdraw!();

    expect(sent).toHaveLength(2);
    for (const cmd of sent) {
      expect(cmd.kind).toBe("set-param");
      expect((cmd as { param: number }).param).toBe(RTSP_PARAM.STREAM_SWITCH);
    }
    expect(sent.map((c) => (c as { value: number }).value)).toEqual([1, 0]);
  });

  it("builds the auth setting for a HomeBase-attached camera; enforcement belongs to the RTSP endpoint", async () => {
    const attached = { ...ctx, homeBaseAttached: true } as CommandContext;
    const { acts: actions, sent } = bind<RtspActions>("rtsp", attached);

    await actions.requireAuth("eufy", "hunter2");

    expect(sent).toHaveLength(1);
    expect(sent[0].kind).toBe("set-payload");
    expect((sent[0] as { cmd: number }).cmd).toBe(RTSP_PARAM.SEND_SECURITY_PASSWD);
    expect((sent[0] as { payload: Record<string, unknown> }).payload.mode).toBe(2);
  });

  it("still publishes and withdraws on a HomeBase-attached camera", async () => {
    const attached = { ...ctx, homeBaseAttached: true } as CommandContext;
    const { acts: actions, sent } = bind<RtspActions>("rtsp", attached);

    await actions.publish!();

    expect(sent).toHaveLength(1);
  });

  it("withholds the publish switch and its momentary methods behind a HomeBase S1 Pro, but keeps the read", () => {
    // The S1 Pro's control channel frames set-payload/set-json only, so the publish scalar (set-param)
    // cannot route: its derived setter is withdrawn by the portal-reach gate, and `publish`/`withdraw`
    // — `method` members the portal-reach gate cannot probe — keep their own stationDeviceType gate.
    // The READ stays installed, so the camera's publish state remains visible.
    const behindS1Pro = {
      ...ctx,
      homeBaseAttached: true,
      stationDeviceType: 27,
      portalCommandKinds: new Set(["set-payload", "set-json"]),
    } as CommandContext;
    const { acts: actions } = bind<RtspActions>("rtsp", behindS1Pro);

    expect(actions.publish).toBeUndefined();
    expect(actions.withdraw).toBeUndefined();
    expect((actions as Record<string, unknown>).setPublished).toBeUndefined();
    expect(Object.getOwnPropertyDescriptor(actions, "published")?.get).toBeTypeOf("function");
  });

  it("toggles authentication through the mode field of the credential payload, sent form:auto", async () => {
    const { acts: actions, sent } = bind<RtspActions>("rtsp", ctx);

    await actions.requireAuth("eufy", "hunter2");
    await actions.allowAnonymous("eufy", "hunter2");

    expect(sent).toHaveLength(2);
    const payloads = sent as unknown as {
      kind: string;
      cmd: number;
      payload: Record<string, unknown>;
      form?: string;
    }[];
    for (const cmd of payloads) {
      expect(cmd.kind).toBe("set-payload");
      expect(cmd.cmd).toBe(RTSP_PARAM.SEND_SECURITY_PASSWD);
      expect(cmd.payload.username).toBe("eufy");
      expect(cmd.payload.passwd).toBe("hunter2");
      // "auto" so a standalone camera (no level-2 key) can still receive it — the whole point of creds.
      expect(cmd.form).toBe("auto");
      // mValue3 = 0, byte-exact with the app's captured frame (not the transport's `?? cmd` default).
      expect((cmd as unknown as { mValue3: number }).mValue3).toBe(0);
    }
    expect(payloads.map((c) => c.payload.mode)).toEqual([2, 0]);
  });

  it("maps the requested scheme to the app's mode: digest (default) = 2, basic = 1", async () => {
    const { acts: actions, sent } = bind<RtspActions>("rtsp", ctx);

    await actions.requireAuth("eufy", "hunter2"); // default digest
    await actions.requireAuth("eufy", "hunter2", "basic");
    await actions.requireAuth("eufy", "hunter2", "digest");

    const modes = (sent as unknown as { payload: { mode: number } }[]).map((c) => c.payload.mode);
    expect(modes).toEqual([2, 1, 2]);
  });

  describe("device-reported url (inbound state)", () => {
    const frame = (data: Buffer, commandId: number = RTSP_PARAM.STREAM_SWITCH) =>
      ({ source: "p2p-frame", stationSn: "T8000P0000000000", commandId, channel: 2, data }) as InboundSignal;
    const nulTerminated = (s: string) => Buffer.concat([Buffer.from(s, "latin1"), Buffer.from([0])]);
    const URL = "rtsp://freshuser:freshpass@10.0.0.5/live0";

    it("lifts the pushed rtsp:// string into state under its synthetic id, and proves published from it", () => {
      // The push is the device stating it is publishing, so `published` (1145) reads true from it too —
      // device state, not the consumer's "did I turn it on" (which the consumer tracks itself).
      expect(RTSP.decodeState!(frame(nulTerminated(URL)))).toEqual({
        params: { [RTSP_PARAM.STREAM_SWITCH]: "1", [RTSP_PARAM.STREAM_URL]: URL },
      });
    });

    it("reads back through the typed getter once the push has been applied", () => {
      const dev = Device.fromRecord("T8000P0000000000", {
        deviceType: 0,
        model: "T8410",
        category: "eufy_security",
        params: { [RTSP_PARAM.STREAM_SWITCH]: "0" },
      });
      const noopSink: CommandSink = { dispatch: async () => undefined };
      // Evidence includes the URL's synthetic id, as the inbound push provides it.
      dev.bindActions(
        { channel: 2, codec: "camera", paramIds: new Set([RTSP_PARAM.STREAM_SWITCH, RTSP_PARAM.STREAM_URL]) },
        noopSink,
      );
      dev.applyParams(RTSP.decodeState!(frame(nulTerminated(URL)))!.params);
      expect(dev.rtsp?.()?.url).toBe(URL);
    });

    it("ignores a 1145 frame that carries no rtsp:// string, and any non-1145 or non-p2p frame", () => {
      expect(RTSP.decodeState!(frame(nulTerminated("ok")))).toBeNull();
      expect(RTSP.decodeState!(frame(nulTerminated(URL), 6050))).toBeNull();
      expect(
        RTSP.decodeState!({ source: "poll", deviceSn: "x", paramType: 1145, params: {} } as InboundSignal),
      ).toBeNull();
    });
  });

  describe("recording mode", () => {
    it("sends BOTH frames the app sends, not just the readable one", async () => {
      const { acts: actions, sent } = bind<RtspActions>("rtsp", ctx);

      await actions.setRecordingMode?.(RtspRecordingMode.Continuous);

      expect(sent).toEqual([
        { kind: "set-json", param: RTSP_PARAM.VIDEO_TYPE_EVENT, data: { value: 1 }, channel: 2 },
        expect.objectContaining({
          kind: "set-json",
          param: RTSP_PARAM.VIDEO_TYPE_CONTINUE,
          data: expect.objectContaining({ enable: 1, index: 0, status: 0, type: 0, value: 0 }),
        }),
      ]);
    });

    it("rejects a value outside the enum rather than sending it", async () => {
      const { acts: actions, sent } = bind<RtspActions>("rtsp", ctx);

      await expect(actions.setRecordingMode?.(7)).rejects.toThrow(/events.*continuous/i);
      expect(sent).toHaveLength(0);
    });

    it("installs setRecordingMode only when the device reports 6050", () => {
      const noRecording = { ...ctx, paramIds: new Set([1145]) } as CommandContext;
      const { acts: actions } = bind<RtspActions>("rtsp", noRecording);
      expect(actions.setRecordingMode).toBeUndefined();
      expect("setRecordingMode" in actions).toBe(false);
      // publish/withdraw stay available regardless.
      expect(typeof actions.publish).toBe("function");
    });
  });
});

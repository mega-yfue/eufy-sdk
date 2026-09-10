import {
  PTZ,
  PTZ_MEMBERS,
  rotateCommand,
  zoomCommand,
  gotoPresetCommand,
  previewPresetCommand,
  deletePresetCommand,
  savePresetCommand,
  setDefaultPositionCommand,
  parsePresetPoints,
  parsePresetImage,
  PTZ_ROTATE,
  PTZ_CMD,
  PtzDirection,
  type PtzActions,
} from "../ptz.js";
import { buildCommand } from "../index.js";
import { bind } from "./bind.js";
import type { CapabilityFrame, InboundSignal, CommandContext } from "../types.js";
import type { Command, MediaProvider } from "../../../core/contracts.js";

const ctx = (channel = 0, paramIds: number[] = []): CommandContext => ({
  capabilities: new Set(["ptz"] as const),
  channel,
  codec: "camera",
  paramIds: new Set<number>(paramIds),
});
// A dual-lens cam context — carries the zoom-evidence param so the `zoom` action/command is offered.
const zoomCtx = (channel = 0): CommandContext => ctx(channel, [6204]);

describe("ptz capability module", () => {
  it("declares the capability + schema", () => {
    expect(PTZ.capability).toBe("ptz");
    // rotationSpeed is the only value member: position is an event, not a parameter.
    expect(PTZ.properties.map((p) => p.name)).toEqual(["rotationSpeed"]);
    expect(PTZ.properties[0].paramType).toBe(6015);
  });

  describe("rotationSpeed (6015)", () => {
    // The app's Slow/Mid/Fast control, observed live: 1 / 3 / 5, in the 1700 {commandType,data} wrapper.
    it.each([
      [1, "slow"],
      [3, "mid"],
      [5, "fast"],
    ])("writes %i (%s) as a set-json {value}", (n) => {
      expect(PTZ_MEMBERS.rotationSpeed.write!(n, ctx(2))).toEqual({
        kind: "set-json",
        param: 6015,
        data: { value: n },
        channel: 2,
      });
    });

    it("takes the untapped middle values too — the scale's shape, not a claim about the wire", () => {
      expect(PTZ_MEMBERS.rotationSpeed.write!(2, ctx())).toMatchObject({ data: { value: 2 } });
      expect(PTZ_MEMBERS.rotationSpeed.write!(4, ctx())).toMatchObject({ data: { value: 4 } });
    });

    it.each([0, 6, -1, 1.5, Number.NaN])("refuses %s rather than clamping it", (bad) => {
      expect(PTZ_MEMBERS.rotationSpeed.write!(bad, ctx())).toBeUndefined();
    });

    it("refuses a value that is not a number at all, instead of coercing it to 0", () => {
      // Number(null) and Number("") are both 0 — a real value on many params, so type-check first.
      expect(PTZ_MEMBERS.rotationSpeed.write!(null as never, ctx())).toBeUndefined();
      expect(PTZ_MEMBERS.rotationSpeed.write!("" as never, ctx())).toBeUndefined();
    });

    it("routes through setProperty as well as the fluent setter", () => {
      expect(buildCommand("rotationSpeed", 5, ctx())).toEqual({
        kind: "set-json",
        param: 6015,
        data: { value: 5 },
        channel: 0,
      });
    });
  });

  describe("detection", () => {
    it("SoloCam preset params + Indoor-PT vendor deviceTypes", () => {
      // Preset params prove SoloCam; deviceType 31/35/111 prove Indoor-PT (which reports no PT param).
      expect(PTZ.detection?.evidenceParams).toEqual(expect.arrayContaining([6090, 6091, 6092, 6210]));
      expect(PTZ.detection?.deviceTypes).toEqual(expect.arrayContaining([31, 35, 111]));
    });
    it("model-name regex matches PT families but not a fixed cam", () => {
      const re = PTZ.detection!.modelHints![0];
      expect(re.test("pantilt")).toBe(true);
      expect(re.test("Indoor PT")).toBe(true);
      expect(re.test("S350")).toBe(true);
      expect(re.test("Wired Doorbell")).toBe(false);
      // Known gap: "Pan & Tilt" (3 chars between words) does NOT match the tight regex — Indoor-PT
      // is covered by detection.deviceTypes instead, so this is a bonus hint, not the primary signal.
      expect(re.test("Indoor Cam Pan & Tilt")).toBe(false);
    });
  });

  describe("rotateCommand", () => {
    it("maps each direction to its rotate_type as a set-json intent (level chosen by transport)", () => {
      expect(rotateCommand(PtzDirection.left, ctx(3))).toEqual({
        kind: "set-json",
        param: PTZ_CMD.PTZ_ROTATE,
        data: { cmd_type: 1, rotate_type: PTZ_ROTATE.left, zoom: 1.0 },
        channel: 3,
      });
      const down = rotateCommand(PtzDirection.down, ctx(0)) as Extract<Command, { kind: "set-json" }>;
      expect(down.data).toMatchObject({ rotate_type: 4, zoom: 1.0 });
    });
  });

  describe("zoomCommand", () => {
    it("builds a SET_PAYLOAD (1350) with the centred crop struct by default", () => {
      const cmd = zoomCommand(2, ctx(3)) as Extract<Command, { kind: "set-payload" }>;
      expect(cmd).toMatchObject({ kind: "set-payload", cmd: PTZ_CMD.PTZ_ZOOM, channel: 3 });
      expect(cmd.payload).toEqual({ x: 0, y: 0, w: 0, h: 0, offset: false, orgZoom: 0, dstZoom: 2 });
    });

    it("passes the crop window through only when offset is set", () => {
      const off = zoomCommand(2, ctx(), { x: 10, y: 20, w: 30, h: 40, offset: false }) as Extract<
        Command,
        { kind: "set-payload" }
      >;
      expect(off.payload).toMatchObject({ x: 0, y: 0, w: 0, h: 0, offset: false });
      const on = zoomCommand(2, ctx(), { x: 10, y: 20, w: 30, h: 40, offset: true, orgZoom: 1 }) as Extract<
        Command,
        { kind: "set-payload" }
      >;
      expect(on.payload).toEqual({ x: 10, y: 20, w: 30, h: 40, offset: true, orgZoom: 1, dstZoom: 2 });
    });
  });

  describe("preset command builders", () => {
    it("gotoPresetCommand → 1700 set-json COMMAND_INDOOR_SPAN_CRUISE_POINT", () => {
      expect(gotoPresetCommand(5, ctx(3))).toEqual({
        kind: "set-json",
        param: PTZ_CMD.PTZ_PRESET_GOTO,
        data: { settingstate: 0, value: 5 },
        channel: 3,
      });
    });

    it("deletePresetCommand → 1700 set-json COMMAND_INDOOR_SPAN_CRUISE_DELETE", () => {
      expect(deletePresetCommand(5, ctx(3))).toEqual({
        kind: "set-json",
        param: PTZ_CMD.PTZ_PRESET_DELETE,
        data: { value: 5 },
        channel: 3,
      });
    });

    it("previewPresetCommand → 1700 set-json COMMAND_INDOOR_SPAN_CRUISE_PREVIEW {value}", () => {
      expect(previewPresetCommand(5, ctx(3))).toEqual({
        kind: "set-json",
        param: PTZ_CMD.PTZ_PRESET_PREVIEW,
        data: { value: 5 },
        channel: 3,
      });
    });

    it("savePresetCommand → [PTZ_PIC {value}, save 6032 {settingstate:0,value}] pair", () => {
      // Decoded on a T8170 SoloCam: creating a preset is 6097 (thumbnail) then a 6032 save (byte-identical to goto).
      expect(savePresetCommand(5, ctx(3))).toEqual([
        { kind: "set-json", param: PTZ_CMD.PTZ_PRESET_PIC, data: { value: 5 }, channel: 3 },
        { kind: "set-json", param: PTZ_CMD.PTZ_PRESET_GOTO, data: { settingstate: 0, value: 5 }, channel: 3 },
      ]);
    });
  });

  describe("setDefaultPositionCommand", () => {
    it("→ 1350 set-payload SET_DEFAULT_POSITION {index, settingstate:0} keyed by preset id", () => {
      // Decoded verbatim on a T8170 SoloCam: {"cmd":6242,"payload":{"index":3,"settingstate":0}}. Commits
      // the preset the camera is currently parked on (preview + settle first — see the type doc).
      const cmd = setDefaultPositionCommand(3, ctx(3)) as Extract<Command, { kind: "set-payload" }>;
      expect(cmd).toMatchObject({ kind: "set-payload", cmd: PTZ_CMD.PTZ_SET_DEFAULT_POSITION, channel: 3 });
      expect(cmd.payload).toEqual({ index: 3, settingstate: 0 });
    });
  });

  describe("parsePresetPoints", () => {
    it("maps the live T8171 reply shape ({index,enable,zoom,isdefault}) to id + raw", () => {
      // Captured live from a T8171 SoloCam: `index` is the preset id.
      const presets = parsePresetPoints({
        points: [
          { index: 0, enable: 1, zoom: 1, isdefault: 0 },
          { index: 3, enable: 1, zoom: 1, isdefault: 1 },
        ],
      });
      expect(presets).toEqual([
        { id: 0, raw: { index: 0, enable: 1, zoom: 1, isdefault: 0 } },
        { id: 3, raw: { index: 3, enable: 1, zoom: 1, isdefault: 1 } },
      ]);
    });

    it("falls back to id/value when a model omits index", () => {
      expect(parsePresetPoints({ points: [{ id: 1 }, { value: 2 }] })).toEqual([
        { id: 1, raw: { id: 1 } },
        { id: 2, raw: { value: 2 } },
      ]);
    });

    it("returns [] for a missing/empty/non-array points field and skips id-less entries", () => {
      expect(parsePresetPoints(undefined)).toEqual([]);
      expect(parsePresetPoints({})).toEqual([]);
      expect(parsePresetPoints({ points: [{ name: "no id" }] })).toEqual([]);
    });
  });

  describe("buildCommand + actions", () => {
    it("buildCommand('rotate', dir) resolves a rotate command; unknown → undefined", () => {
      expect(buildCommand("rotate", "up", ctx(1))).toMatchObject({
        kind: "set-json",
        param: PTZ_CMD.PTZ_ROTATE,
        channel: 1,
      });
      expect(buildCommand("rotate", "sideways", ctx())).toBeUndefined();
      expect(buildCommand("nope", 1, ctx())).toBeUndefined();
    });

    it("buildCommand resolves numeric zoom/gotoPreset/deletePreset; non-number → undefined", () => {
      expect(buildCommand("zoom", 2, zoomCtx(1))).toMatchObject({ kind: "set-payload", cmd: PTZ_CMD.PTZ_ZOOM });
      // zoom is gated on the dual-lens evidence param — absent → no command.
      expect(buildCommand("zoom", 2, ctx(1))).toBeUndefined();
      expect(buildCommand("gotoPreset", 3, ctx())).toMatchObject({ param: PTZ_CMD.PTZ_PRESET_GOTO });
      expect(buildCommand("deletePreset", 3, ctx())).toMatchObject({ param: PTZ_CMD.PTZ_PRESET_DELETE });
      expect(buildCommand("gotoPreset", "x", ctx())).toBeUndefined();
      expect(buildCommand("setDefaultPosition", 3, ctx())).toMatchObject({
        kind: "set-payload",
        cmd: PTZ_CMD.PTZ_SET_DEFAULT_POSITION,
        payload: { index: 3, settingstate: 0 },
      });
    });

    it("actions dispatch rotate/zoom/preset through the sink", async () => {
      const { acts, sent } = bind<PtzActions>("ptz", zoomCtx(3));
      await acts.rotate(PtzDirection.right);
      await acts.left();
      await acts.zoom!(2);
      await acts.preset().goto(4);
      await acts.preset().preview(9);
      await acts.preset().save(7);
      await acts.preset().delete(4);
      await acts.preset().setDefault(4);
      expect(sent[0]).toMatchObject({ kind: "set-json", data: { rotate_type: PTZ_ROTATE.right }, channel: 3 });
      expect(sent[1]).toMatchObject({ data: { rotate_type: PTZ_ROTATE.left } });
      expect(sent[2]).toMatchObject({ kind: "set-payload", cmd: PTZ_CMD.PTZ_ZOOM, payload: { dstZoom: 2 } });
      expect(sent[3]).toMatchObject({ param: PTZ_CMD.PTZ_PRESET_GOTO, data: { value: 4 } });
      expect(sent[4]).toMatchObject({ param: PTZ_CMD.PTZ_PRESET_PREVIEW, data: { value: 9 } });
      // save() dispatches the PTZ_PIC thumbnail then the 6032 save, in order.
      expect(sent[5]).toMatchObject({ param: PTZ_CMD.PTZ_PRESET_PIC, data: { value: 7 } });
      expect(sent[6]).toMatchObject({ param: PTZ_CMD.PTZ_PRESET_GOTO, data: { settingstate: 0, value: 7 } });
      expect(sent[7]).toMatchObject({ param: PTZ_CMD.PTZ_PRESET_DELETE, data: { value: 4 } });
      expect(sent[8]).toMatchObject({
        kind: "set-payload",
        cmd: PTZ_CMD.PTZ_SET_DEFAULT_POSITION,
        payload: { index: 4, settingstate: 0 },
      });
    });

    it("zoom action is present only on a dual-lens (zoom-evidence) device", () => {
      expect(bind<PtzActions>("ptz", ctx(3)).acts.zoom).toBeUndefined(); // single-lens PT cam
      expect(typeof bind<PtzActions>("ptz", zoomCtx(3)).acts.zoom).toBe("function"); // dual-lens
    });

    it("preset().list is present only with a media provider and queries id 6034", async () => {
      expect(bind<PtzActions>("ptz", ctx(3)).acts.preset().list).toBeUndefined();

      const calls: Array<{ param: number; data: Record<string, unknown> }> = [];
      const media = {
        p2pControlQuery: async (param: number, data: Record<string, unknown>) => {
          calls.push({ param, data });
          return { points: [{ id: 7, name: "Gate" }] };
        },
      } as unknown as MediaProvider;
      const acts = bind<PtzActions>("ptz", ctx(3), { media: media }).acts;
      const presets = await acts.preset().list!();
      expect(calls).toEqual([{ param: PTZ_CMD.PTZ_PRESET_QUERY, data: { value: 0 } }]);
      expect(presets).toEqual([{ id: 7, raw: { id: 7, name: "Gate" } }]);
    });

    it("preset().image is present only with a media provider and queries id 6097", async () => {
      expect(bind<PtzActions>("ptz", ctx(3)).acts.preset().image).toBeUndefined();

      const calls: Array<{ param: number; data: Record<string, unknown> }> = [];
      const media = {
        p2pControlQuery: async (param: number, data: Record<string, unknown>) => {
          calls.push({ param, data });
          return { data: "/9j/thumb", index: 2 };
        },
      } as unknown as MediaProvider;
      const acts = bind<PtzActions>("ptz", ctx(3), { media: media }).acts;
      const img = await acts.preset().image!(2);
      expect(calls).toEqual([{ param: PTZ_CMD.PTZ_PRESET_PIC, data: { value: 2 } }]);
      expect(img).toEqual({ index: 2, data: "/9j/thumb" });
    });
  });

  describe("parsePresetImage", () => {
    it("maps the get_preset_position_pic reply {data,index}", () => {
      expect(parsePresetImage({ data: "/9j/x", index: 3 })).toEqual({ index: 3, data: "/9j/x" });
    });
    it("defaults index to -1 and returns undefined without image data", () => {
      expect(parsePresetImage({ data: "/9j/x" })).toEqual({ index: -1, data: "/9j/x" });
      expect(parsePresetImage({ index: 3 })).toBeUndefined();
      expect(parsePresetImage({ data: "" })).toBeUndefined();
      expect(parsePresetImage(undefined)).toBeUndefined();
    });
  });

  describe("decodeEvent (p2p-frame source)", () => {
    const frame = (f: Partial<CapabilityFrame>): InboundSignal => ({
      source: "p2p-frame",
      stationSn: "S",
      commandId: 0,
      channel: 0,
      ...f,
    });

    it("decodes a SoloCam 1351 rotate notify", () => {
      const ev = PTZ.decodeEvent!(frame({ commandId: 1351, json: { cmd: 6030, payload: { limit: 1 } } }));
      expect(ev).toEqual({ event: "ptzNotify", payload: { kind: "rotate", payload: { limit: 1 } } });
    });

    it("decodes a SoloCam 1351 zoom notify", () => {
      const ev = PTZ.decodeEvent!(frame({ commandId: 1351, json: { cmd: 6203, payload: { dstZoom: 2 } } }));
      expect(ev?.payload.kind).toBe("zoom");
    });

    it("decodes an Indoor-PT 1700 float position stream when non-zero", () => {
      const buf = Buffer.alloc(28); // 4-byte header + one 24-byte record
      buf.writeFloatLE(0.5, 4 + 12); // pan
      buf.writeFloatLE(-0.25, 4 + 16); // tilt
      const ev = PTZ.decodeEvent!(frame({ commandId: 1700, data: buf }));
      expect(ev?.payload).toEqual({ kind: "position", coords: [[0.5, -0.25]] });
    });

    it("ignores an all-zero 1700 stream (a fixed camera streams zeros)", () => {
      expect(PTZ.decodeEvent!(frame({ commandId: 1700, data: Buffer.alloc(28) }))).toBeNull();
    });

    it("ignores unrelated frames", () => {
      expect(PTZ.decodeEvent!(frame({ commandId: 1035 }))).toBeNull();
    });

    it("ignores non-frame sources (push/poll)", () => {
      expect(PTZ.decodeEvent!({ source: "push", eventType: 3101, payload: {} })).toBeNull();
    });
  });
});

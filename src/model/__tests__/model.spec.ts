/**
 * Device-model skeleton tests — exercise the data-driven resolver + capability composition.
 * Offline/deterministic (synthetic CloudRecords only), matching the repo's test conventions.
 */
import {
  classify,
  codecForType,
  resolveDevice,
  Device,
  mergeProperties,
  detectCapabilities,
  UNKNOWN_PARAM_PREFIX,
  SECURITY_PARAMS,
  CLEAN_PARAMS,
  paramDef,
  inspectParams,
} from "../index.js";
import type { CloudRecord } from "../index.js";
import { DeviceType } from "../device-types.js";
// VACUUM_DP is the capability's own wire vocabulary (internal — not on the barrel), so a spec imports
// it by direct path, the same way the P2P command specs import `CAMERA_CMD`.
import { VACUUM_DP } from "../capabilities/vacuum-clean.js";

describe("classify (device_type → codec)", () => {
  it("maps known DeviceType numbers to their codec family", () => {
    expect(codecForType(18)).toBe("station"); // HB3
    expect(codecForType(54)).toBe("lock"); // Smart Lock R10
    expect(codecForType(10)).toBe("sensor"); // motion sensor
    expect(codecForType(11)).toBe("keypad");
    expect(codecForType(9)).toBe("camera"); // CAMERA2 → residual camera bucket
  });

  it("falls back to model code, then defaults to camera", () => {
    expect(classify({ model: "T8030" })).toBe("station");
    expect(classify({ model: "T85ZZ" })).toBe("lock");
    expect(classify({})).toBe("camera"); // safe read-only default
  });

  it("maps the eufy_life T8L0x light line to light — by prefix, incl. suffixed variants", () => {
    expect(classify({ model: "T8L02" })).toBe("light"); // registry-listed
    expect(classify({ model: "T8L02X" })).toBe("light"); // suffixed variant, no registry row
    expect(classify({ model: "T8L023E1" })).toBe("light");
    // Model wins over a colliding security-range device_type (deviceType is namespaced per line).
    expect(classify({ model: "T8L99", deviceType: 9 })).toBe("light");
    expect(resolveDevice({ model: "T8L77" }).capabilities).toContain("smart_light");
  });

  it("maps the T87Ax Smart Display line to display — model wins over a colliding security device_type", () => {
    // device_type 1 (confirmed live on a T87A0) falls inside the security residual range — the model
    // code must be checked first, or this would silently resolve to "camera" and pick up capabilities
    // (camera, person_detection) the device has no P2P path to ever answer for. Decided from the model,
    // not the cloud `category` ("eufy_mega") — see classify.ts's `T87A` arm for why.
    expect(classify({ model: "T87A0", deviceType: 1 })).toBe("display");
    // Shaped like the real captured record (2026-09-04, redacted): `name` matters here because it's
    // the one field `hintHaystack` feeds into inference — and a security capability whose `modelHints`
    // regex matched this text was exactly the risk while `display` was grouped into the security line.
    // It no longer can be: `display` is its own line with its own param namespace, so the only
    // capabilities are its own and the universal `info`.
    const r = resolveDevice({
      category: "eufy_mega",
      model: "T87A0",
      deviceType: 1,
      name: "Eufy Smart Display",
      params: {
        8001: "100",
        8002: "1",
        8003: "2.9.05",
        8004: "T8000P0000000000",
        8005: "Smart Display E10",
        8006: "T87A0",
      },
    } as never);
    expect(r.codec).toBe("display");
    expect(r.name).toBe("Smart Display E10"); // curated registry row
    // `display` itself, from the codec, plus the universal `info`. No camera-line (or other
    // security-line) capability leaks in — see line-partition.spec.ts for the adversarial case.
    expect(r.capabilities).toEqual(["display", "info"]);
  });
});

describe("resolveDevice — 3-tier composition", () => {
  it("tier 1: a curated model row drives codec, name and extra caps", () => {
    const r = resolveDevice({ model: "T8423", deviceType: 37 }); // Floodlight Cam
    expect(r.codec).toBe("camera");
    expect(r.source).toBe("model");
    expect(r.name).toBe("Floodlight Cam");
    expect(r.capabilities).toEqual(expect.arrayContaining(["light", "battery", "video", "motion"]));
  });

  it("tier 2: an unknown model still classifies by device_type with baseline caps", () => {
    const r = resolveDevice({ deviceType: 9, model: "T8XYZ" }); // some camera, no row
    expect(r.codec).toBe("camera");
    expect(r.source).toBe("category");
    expect(r.capabilities).toEqual(expect.arrayContaining(["video", "snapshot", "motion"]));
  });

  it("tier 3: a totally unknown device infers capabilities from reported params (read-only)", () => {
    // No deviceType, no model — only a reported contact param. Should still light up `contact`.
    const r = resolveDevice({ params: { 1550: "1" } });
    expect(r.source).toBe("inferred");
    expect(r.capabilities).toContain("contact");
    expect(r.properties.some((p) => p.name === "contact")).toBe(true);
  });

  it("tier 3: infers pan_tilt from a SoloCam preset param (registry-independent)", () => {
    // SoloCam (T8170/T8171) report the preset params 6090/6091/6092/6210. A stored pan/tilt
    // preset only exists on a device that pans/tilts, so their presence proves the capability
    // even with no curated row. Verified on live T8170/T8171 hardware.
    const r = detectCapabilities({ params: { 6090: "0" } }, "camera");
    expect(r).toContain("ptz");
    // A fixed cam that never reports a preset param must NOT gain pan_tilt.
    expect(detectCapabilities({ params: { 6040: "1" } }, "camera")).not.toContain("ptz");
  });

  it("vendor table: an Indoor-PT DeviceType gets pan_tilt with no registry row", () => {
    // 31 = INDOOR_PT_CAMERA (vendor enum). Indoor-PT reports no PT param and has no reliable
    // active probe, so this static vendor map is the classifier's answer. See classify.ts.
    const r = resolveDevice({ deviceType: 31, model: "T8410" });
    expect(r.capabilities).toContain("ptz");
    // Fixed-camera DeviceTypes (30 INDOOR, 46 INDOOR_OUTDOOR_1080P) must NOT.
    expect(resolveDevice({ deviceType: 30 }).capabilities).not.toContain("ptz");
    expect(resolveDevice({ deviceType: 46 }).capabilities).not.toContain("ptz");
  });

  it("a normal solar cam (T8124R) is NOT pan-tilt — the mistaken model hint is gone", () => {
    // T8124R (deviceType 62 = SOLO_CAMERA_SPOTLIGHT_SOLAR) is a FIXED solar cam: it reports no PT param
    // and isn't a PT deviceType. An unfounded `\bT8124R\b` model hint used to grant it ptz anyway;
    // confirmed on a real owned unit that it does not pan/tilt, so the hint was removed.
    expect(resolveDevice({ model: "T8124R", deviceType: 62 }).capabilities).not.toContain("ptz");
    // Genuine PT models still resolve via their real signals — a name hint (S340) and a PT deviceType.
    expect(resolveDevice({ model: "SoloCam S340" }).capabilities).toContain("ptz");
    expect(resolveDevice({ deviceType: 48 }).capabilities).toContain("ptz"); // OUTDOOR_PT_CAMERA
  });

  it("guard-mode 'arming' on a camera is standalone-only — a HomeBase owns it, not an attached cam", () => {
    // Standalone: the curated grant applies (SoloCam / Indoor cams own their own guard mode), and an
    // evidence match (a cam reporting the guard-mode param 1224) grants it too.
    expect(resolveDevice({ model: "T8170" }).capabilities).toContain("arming");
    expect(resolveDevice({ model: "T8410", deviceType: 31 }).capabilities).toContain("arming");
    expect(resolveDevice({ deviceType: 9, params: { 1224: "0" } }).capabilities).toContain("arming");
    // Behind a HomeBase (`parentSn` set): the hub owns guard mode and the app shows it there, not per
    // camera — so the camera must NOT advertise a control it can't answer for. Covers the curated grant
    // AND a mirrored guard-mode param that detection would otherwise re-add.
    expect(resolveDevice({ model: "T8170", parentSn: "T8030P0" }).capabilities).not.toContain("arming");
    expect(resolveDevice({ model: "T8410", deviceType: 31, parentSn: "T8030P0" }).capabilities).not.toContain("arming");
    expect(resolveDevice({ deviceType: 9, params: { 1224: "0" }, parentSn: "T8030P0" }).capabilities).not.toContain(
      "arming",
    );
    // The HomeBase itself is a station — it always owns arming, parent-ness is irrelevant.
    expect(resolveDevice({ model: "T8030" }).capabilities).toContain("arming");
    expect(resolveDevice({ model: "T8030", parentSn: "T8030P0" }).capabilities).toContain("arming");
  });

  it("'light' is a capability, not a class — a floodlight cam is just camera + light", () => {
    const plain = resolveDevice({ deviceType: 9 });
    const flood = resolveDevice({ model: "T8423", deviceType: 37 });
    expect(plain.codec).toBe(flood.codec); // same class
    expect(plain.capabilities).not.toContain("light");
    expect(flood.capabilities).toContain("light");
  });
});

describe("vacuum / clean line (separate Tuya-DP namespace)", () => {
  it("classifies RoboVac T2 codes + category as the vacuum codec", () => {
    expect(classify({ model: "T2351" })).toBe("vacuum");
    expect(classify({ category: "eufy_clean" })).toBe("vacuum");
  });

  it("classifies legacy T1xxx RoboVac codes as vacuum (no registry row needed)", () => {
    // T1xxx is the pre-T2 RoboVac prefix (e.g. T1250 RoboVac 35C). The classifier must catch
    // the whole range so dropping or missing a registry row doesn't silently land it as a camera.
    expect(classify({ model: "T1250" })).toBe("vacuum");
    expect(classify({ model: "T1999" })).toBe("vacuum"); // any T1xxx → vacuum
  });

  it("vacuum wins even if device_type lands in the security range (ordering guard)", () => {
    // deviceType 9 is a camera in the security enum; a clean/T2 record must NOT be misread as camera.
    expect(classify({ deviceType: 9, category: "eufy_clean", model: "T2080" })).toBe("vacuum");
    expect(classify({ deviceType: 9, model: "T2351" })).toBe("vacuum");
  });

  it("vacuum battery is DP 163, NOT security param 1101", () => {
    const r = resolveDevice({ model: "T2351" });
    expect(r.codec).toBe("vacuum");
    expect(r.capabilities).toEqual(expect.arrayContaining(["vacuum_clean", "suction", "locate"]));
    const battery = r.properties.find((p) => p.name === "battery");
    expect(battery?.paramType).toBe(163); // vacuum namespace
    expect(battery?.provenance).toBe("mega"); // cloud-authoritative (get_product_data_point)
  });

  it("a vacuum device decodes its own DP params", () => {
    const dev = Device.fromRecord("T2351VAC", { model: "T2351", params: { 151: "1", 163: "88" } });
    expect(dev.getProperty("power")?.value).toBe(true);
    expect(dev.getProperty("battery")?.value).toBe(88);
  });

  it("robot mowers get the mower codec, not vacuum (own family) — incl. the …B hardware variants", () => {
    // The app's TuyaP2PMower set (ProductTypeUtils isMowC15/E15/E18), including the `…B` variants that
    // the earlier anchored regex dropped to the vacuum rule.
    for (const m of ["T280B", "T2801", "T2880"]) expect(classify({ model: m })).toBe("mower");
    // a mower must not pick up vacuum capabilities even if its category reads clean-ish.
    const r = resolveDevice({ model: "T2801", category: "eufy_clean" });
    expect(r.codec).toBe("mower");
    expect(r.capabilities).not.toContain("vacuum_clean");
    expect(r.name).toBe("Mower E18");
    // the …B variant shares its model name (the app groups the pair under one predicate).
    expect(resolveDevice({ model: "T2880" }).name).toBe("Mower E15");
    // T2881 is in the V6 clean catalog but has NO mower predicate — it stays a vacuum, not a mower.
    expect(classify({ model: "T2881" })).toBe("vacuum");
    // a neighbouring T2 code is still a vacuum.
    expect(classify({ model: "T2262" })).toBe("vacuum");
  });
});

describe("encoded params decode to structured values", () => {
  it("base64+json param (privacyparam) decodes to an object", () => {
    expect(SECURITY_PARAMS[1295].encoding).toBe("base64+json");
    const dev = Device.fromRecord("cam", {
      deviceType: 9,
      model: "T8124R",
      params: { 1295: "eyJwb2ludHMiOltdfQ==" }, // {"points":[]}
    });
    const v = dev.getProperty(SECURITY_PARAMS[1295].name)?.value;
    expect(v).toEqual({ points: [] });
  });

  it("plain-json param decodes; a base64-looking plain string does NOT (no false decode)", () => {
    // 1710 is json-encoded
    expect(SECURITY_PARAMS[1710].encoding).toBe("json");
    // 1217 deviceName is plain text "Doorbell" — must NOT be flagged as encoded
    expect(SECURITY_PARAMS[1217].encoding).toBeUndefined();
  });
});

describe("doorbell — confirmed against real T8214", () => {
  it("uses the real 1702-1719 ids (mega), not the stale 2015/2022/1306 guesses", () => {
    const r = resolveDevice({ model: "T8214", deviceType: 5 });
    expect(r.capabilities).toContain("doorbell");
    const chime = r.properties.find((p) => p.name === "chimeSwitch");
    expect(chime?.paramType).toBe(1702);
    expect(chime?.provenance).toBe("verified");
    // the stale ids must NOT be in the doorbell schema anymore
    expect(r.properties.some((p) => [2015, 2022, 1306].includes(p.paramType))).toBe(false);
  });

  it("types the wired T8200 as a doorbell, not a plain camera, and claims no battery", () => {
    // Confirmed against a real owned unit. Without its registry row the model fell through to the
    // camera codec, so `doorbell` never appeared and consumers built no ring event or trigger.
    const r = resolveDevice({ model: "T8200", deviceType: 5 });
    expect(r.capabilities).toContain("doorbell");
    // Mains-powered: the row must not hand it a battery it does not have.
    expect(r.capabilities).not.toContain("battery");
    expect(r.name).toBe("Wired Doorbell 2K");
  });

  it("decodes real doorbell param values (chime on, ringtone vol 80, notification JSON)", () => {
    const dev = Device.fromRecord("T8214DB", {
      model: "T8214",
      deviceType: 5,
      params: { 1702: "1", 1708: "80", 1710: '{"notification_ring_onoff":1}' },
    });
    expect(dev.getProperty("chimeSwitch")?.value).toBe(true);
    expect(dev.getProperty("ringtoneVolume")?.value).toBe(80);
    // notificationMode is json-encoded → decoded to a structured object
    expect(dev.getProperty("notificationMode")?.value).toMatchObject({ notification_ring_onoff: 1 });
  });
});

describe("Device — state + graceful unknown params", () => {
  const rec: CloudRecord = { deviceType: 9, model: "T8423", params: {} };

  it("coerces known params into named, typed properties", () => {
    const dev = Device.fromRecord("T8423CAM001", { ...rec, params: { 1101: "57", 1011: "1" } });
    expect(dev.has("battery")).toBe(true);
    expect(dev.getProperty("battery")?.value).toBe(57); // number coercion
    expect(dev.getProperty("motionDetection")?.value).toBe(true); // bool coercion
  });

  it("retains unrecognised params as unknown_<paramType> passthrough (never dropped)", () => {
    const dev = Device.fromRecord("T8423CAM001", { ...rec, params: { 999999: "raw-value" } });
    const key = `${UNKNOWN_PARAM_PREFIX}999999`;
    expect(dev.getProperty(key)?.value).toBe("raw-value");
  });

  it("applyParams reports only changed properties", () => {
    const dev = Device.fromRecord("sn", { ...rec, params: { 1101: "50" } });
    expect(dev.applyParams({ 1101: "50" })).toEqual([]); // unchanged
    expect(dev.applyParams({ 1101: "60" })).toEqual(["battery"]); // changed
  });

  it("a decoded object whose keys come back reordered is NOT flagged as changed (no flap)", () => {
    // 1295 is base64+json → decodes to an object. Same content, different key order across two
    // pushes must read as unchanged (a JSON.stringify compare would flap; structuralEqual doesn't).
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64");
    const dev = Device.fromRecord("cam", {
      deviceType: 9,
      model: "T8124R",
      params: { 1295: b64({ a: 1, b: 2 }) },
    });
    expect(dev.applyParams({ 1295: b64({ b: 2, a: 1 }) })).toEqual([]); // reordered keys → unchanged
    expect(dev.applyParams({ 1295: b64({ a: 1, b: 3 }) })).toEqual([SECURITY_PARAMS[1295].name]); // real change
  });
});

describe("param dictionary — full real-device coverage", () => {
  it("has the verified anchors with correct names + provenance", () => {
    expect(SECURITY_PARAMS[1101].name).toBe("battery");
    expect(SECURITY_PARAMS[1101].provenance).toBe("verified");
    expect(SECURITY_PARAMS[1550].name).toBe("contact");
    expect(SECURITY_PARAMS[1141].name).toBe("rssi");
  });

  it("covers the real security param space (150+ ids, membership is the observation)", () => {
    const ids = Object.keys(SECURITY_PARAMS);
    expect(ids.length).toBeGreaterThan(150);
  });

  it("namespaces are separate — clean DP 163 = battery, mega-sourced", () => {
    expect(VACUUM_DP.BATTERY).toBe(163);
    expect(CLEAN_PARAMS[VACUUM_DP.BATTERY].name).toBe("battery");
    expect(CLEAN_PARAMS[VACUUM_DP.BATTERY].provenance).toBe("mega");
    expect(paramDef("security", VACUUM_DP.BATTERY)).toBeUndefined(); // 163 is not a security id
    expect(paramDef("clean", 1101)).toBeUndefined(); // 1101 is not a clean id
  });

  it("a curated camera property takes precedence over its generic dictionary name", () => {
    const def = SECURITY_PARAMS[1045];
    expect(def).toBeDefined();
    expect(def.provenance).toBe("apk");
    const dev = Device.fromRecord("cam", { deviceType: 9, model: "T8124R", params: { 1045: "1" } });
    expect(dev.getProperty("statusLed")?.value).toBe(true);
    expect(dev.getProperty(def.name)).toBeUndefined();
    expect(dev.getProperty(`unknown_1045`)).toBeUndefined();
  });
});

describe("inspectParams — enrichment export", () => {
  const rep = inspectParams(
    { model: "T8214", deviceType: 5, params: { 1702: "1", 1101: "77", 987654: "raw" } },
    "T8214SN",
  );

  it("cross-references known params and flags unknown ones", () => {
    const chime = rep.params.find((p) => p.paramType === 1702);
    expect(chime?.known).toBe(true);
    expect(chime?.name).toBe("chimeSwitch");
    const unknown = rep.params.find((p) => p.paramType === 987654);
    expect(unknown?.known).toBe(false);
    expect(rep.counts.unknown).toBe(1);
  });

  it("emits a paste-ready registry.ts row for the model", () => {
    expect(rep.registrySnippet).toContain('"T8214"');
    expect(rep.registrySnippet).toContain('codec: "camera"');
    expect(rep.suggestedRegistry.exists).toBe(true); // we curated T8214
  });

  it("emits dictionary snippets for the unknown params", () => {
    expect(rep.dictionarySnippet).toContain("987654");
    expect(rep.dictionarySnippet).toContain('provenance: "guessed"');
    expect(rep.dictionarySnippet).toContain("reported by T8214");
  });
});

describe("mergeProperties — shared props dedupe across capabilities", () => {
  it("collapses repeated props (rssi/lastSeen) first-wins", () => {
    const props = mergeProperties(["contact", "leak"]); // both contribute lastSeen
    const lastSeen = props.filter((p) => p.name === "lastSeen");
    expect(lastSeen).toHaveLength(1);
  });

  it("detectCapabilities gates camera extras on the camera codec", () => {
    expect(detectCapabilities({ params: { 1550: "1" } }, "sensor")).not.toContain("video");
    expect(detectCapabilities({ model: "cam" }, "camera")).toContain("video");
  });

  it("resolves attached camera alarm output from topology and EAS evidence without a model row", () => {
    expect(resolveDevice({ model: "T8114", deviceType: DeviceType.CAMERA2, params: {} }).capabilities).not.toContain(
      "siren",
    );
    expect(
      resolveDevice({
        model: "T8999",
        deviceType: DeviceType.BATTERY_DOORBELL,
        parentSn: "T8000P0000000000",
        params: { 1015: "0" },
      }).capabilities,
    ).toContain("siren");
  });

  /** Camera audio and HomeBase siren schemas retain their independently evidenced members. */
  it("honours per-member `available` through resolveDevice — a hub omits camera-only audio props", () => {
    const camNames = resolveDevice({ deviceType: 9, model: "T8114", params: { 1240: "1", 1241: "1" } }).properties.map(
      (p) => p.name,
    );
    expect(camNames).toEqual(expect.arrayContaining(["microphone", "speaker", "speakerVolume", "audioRecording"]));
    expect(camNames).not.toContain("hubAlarmTone");

    const hubNames = resolveDevice({
      model: "T8030",
      deviceType: DeviceType.HB3,
      params: { 1281: "1" },
    }).properties.map((p) => p.name);
    expect(hubNames).toContain("hubAlarmTone");
    for (const cameraOnly of ["microphone", "speaker", "speakerVolume", "audioRecording"]) {
      expect(hubNames).not.toContain(cameraOnly);
    }
  });

  const workingModeSpec = (model: string) =>
    resolveDevice({ deviceType: 9, model, params: { 1246: "0", 1101: "50" } }).properties.find(
      (p) => p.name === "workingMode",
    );
  const workingModeRead = (model: string) => {
    const dev = Device.fromRecord(`${model}P0000000000`, { model, params: { 1246: "0", 1101: "50" } });
    // describe()'s read descriptors come from the BOUND capability objects — bind so battery's reads exist.
    dev.bindActions(
      { channel: 0, codec: "camera", model, deviceType: 9, paramIds: new Set([1246, 1101]) },
      {
        dispatch: async () => {},
      },
    );
    return dev
      .describe()
      .details.flatMap((c) => c.reads)
      .find((r) => r.accessor === "workingMode");
  };

  const THREE_MODE = { 0: "Optimal Battery Life", 1: "Optimal Surveillance", 2: "Customize Recording" };

  it("stamps the 3-mode battery-camera domain for a confirmed model (T8114)", () => {
    expect(workingModeSpec("T8114")?.enumValues).toEqual(THREE_MODE);
    expect(workingModeSpec("T8114")?.kind).toBe("enum");
  });

  it("stamps the 4-mode doorbell domain, which numbers its modes differently (T8214)", () => {
    expect(workingModeSpec("T8214")?.enumValues).toEqual({
      0: "Balance Surveillance",
      1: "Optimal Surveillance",
      2: "Customize Recording",
      3: "Optimal Battery Life",
    });
  });

  it("publishes no workingMode domain for a model with no confirmed set (mains T8419)", () => {
    const spec = workingModeSpec("T8419");
    expect(spec).toBeDefined();
    expect(spec?.enumValues).toBeUndefined();
    expect(spec?.kind).not.toBe("enum");
  });

  it("describe() reports the same per-model workingMode domain as the property schema", () => {
    const read = workingModeRead("T8114");
    expect(read?.kind).toBe("enum");
    expect(read?.labels).toEqual({
      "0": "Optimal Battery Life",
      "1": "Optimal Surveillance",
      "2": "Customize Recording",
    });
  });

  it("describe() publishes no workingMode domain for an unverified model (T8419)", () => {
    const read = workingModeRead("T8419");
    expect(read).toBeDefined();
    expect(read?.kind).not.toBe("enum");
    expect(read?.labels).toBeUndefined();
  });

  it("reresolve adopts a changed manifest even when no capability was gained", () => {
    // A Tuya vacuum's rssi read is gated on DP 134 being reported — absent until the device reports
    // it. Switching from no-DP to DP-reported changes the manifest (rssi appears) without changing
    // the capability set (vacuum_clean was already detected via codec).
    const dev = Device.fromRecord("VAC", { model: "T2266", category: "eufy_home_tuya", params: {} });
    expect(dev.properties.map((p) => p.name)).not.toContain("rssi");

    const gained = dev.reresolve({ model: "T2266", category: "eufy_home_tuya", params: { 134: "-52" } });

    expect(gained).toEqual([]); // capability set unchanged…
    expect(dev.properties.map((p) => p.name)).toContain("rssi"); // …but the manifest was still adopted
  });
});

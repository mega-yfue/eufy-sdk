import { secureTopic, subscribeTopics, parseSecureTopic } from "../topics.js";
import { classifyDevice, type EufyDevice } from "../../../core/types.js";

const light: EufyDevice = {
  sn: "T1234X00099",
  model: "T1234",
  category: "eufy_mega",
  deviceClass: "other",
  api: "mega",
  realtime: "smqtt",
};

describe("secure MQTT (Anker mTLS) topics", () => {
  it("builds cmd/{category}/{model}/{sn}/res for subscribe", () => {
    expect(secureTopic(light, "res")).toBe("cmd/eufy_mega/T1234/T1234X00099/res");
    expect(secureTopic(light, "req")).toBe("cmd/eufy_mega/T1234/T1234X00099/req");
  });
});

describe("subscribeTopics — clean-line devices (vacuum/mower)", () => {
  const vacuum: EufyDevice = {
    sn: "T2351X00001",
    model: "T2351",
    category: "robovac",
    deviceClass: "vacuum",
    api: "mega",
    realtime: "smqtt",
  };
  const mower: EufyDevice = { ...vacuum, sn: "T2900X00001", model: "T2900", deviceClass: "mower" };

  it("vacuum subscribes all four eufy_home topics (cmd/res + biz/res + biz/req + dt/param_info)", () => {
    const topics = subscribeTopics(vacuum);
    expect(topics).toEqual([
      "cmd/eufy_home/T2351/T2351X00001/res",
      "biz/eufy_home/T2351/T2351X00001/res",
      "biz/eufy_home/T2351/T2351X00001/req",
      "dt/eufy_home/T2351/T2351X00001/param_info",
    ]);
  });

  it("mower subscribes the same four-topic set", () => {
    const topics = subscribeTopics(mower);
    expect(topics).toEqual([
      "cmd/eufy_home/T2900/T2900X00001/res",
      "biz/eufy_home/T2900/T2900X00001/res",
      "biz/eufy_home/T2900/T2900X00001/req",
      "dt/eufy_home/T2900/T2900X00001/param_info",
    ]);
  });

  it("non-clean-line device still subscribes only cmd/.../res", () => {
    const topics = subscribeTopics(light);
    expect(topics).toEqual(["cmd/eufy_mega/T1234/T1234X00099/res"]);
  });
});

describe("parseSecureTopic — biz/ and dt/ roots", () => {
  it("parses biz/.../res and extracts the correct sn", () => {
    const p = parseSecureTopic("biz/eufy_home/T2351/T2351X00001/res");
    expect(p).toEqual({ root: "biz", category: "eufy_home", model: "T2351", sn: "T2351X00001", tail: "res" });
  });

  it("parses biz/.../req", () => {
    const p = parseSecureTopic("biz/eufy_home/T2351/T2351X00001/req");
    expect(p).toEqual({ root: "biz", category: "eufy_home", model: "T2351", sn: "T2351X00001", tail: "req" });
  });

  it("parses dt/.../param_info", () => {
    const p = parseSecureTopic("dt/eufy_home/T2351/T2351X00001/param_info");
    expect(p).toEqual({ root: "dt", category: "eufy_home", model: "T2351", sn: "T2351X00001", tail: "param_info" });
  });

  it("still parses cmd/ and synq/ roots", () => {
    expect(parseSecureTopic("cmd/eufy_home/T2351/T2351X00001/res")?.root).toBe("cmd");
    expect(parseSecureTopic("synq/eufy_life/T1234/T1234X00001/state_info")?.root).toBe("synq");
  });

  it("rejects unknown roots", () => {
    expect(parseSecureTopic("other/eufy_home/T2351/T2351X00001/res")).toBeUndefined();
  });
});

describe("device classification (API + realtime routing)", () => {
  it("eufy_security → mega API + p2p realtime (v6 uses mega for all devices)", () => {
    const c = classifyDevice({ category: "eufy_security", device_model: "T8214" });
    expect(c).toMatchObject({ api: "mega", realtime: "p2p" });
  });
  it("a populated p2p_did forces p2p regardless of category", () => {
    const c = classifyDevice({ category: "eufy_mega", device_model: "T8030", p2p_did: "ABC123" });
    expect(c.realtime).toBe("p2p");
  });
  it("mega appliance → mega API + smqtt realtime", () => {
    const c = classifyDevice({ category: "eufy_mega", device_model: "T1234" });
    expect(c).toMatchObject({ api: "mega", realtime: "smqtt" });
  });
});

import { buildFf09Trans, buildFf09MqttEnvelope, ff09MqttTopic } from "../command-router.js";
import { CMD_TRANSFER_PAYLOAD } from "../../ff09.js";

// Golden frames, synthetic identity (docs/REDACTION.md): the two directions differ only in the frame's A3 byte.
const ADMIN = "0000000000000000000000000000000000000000";
const SN = "T85D0K0000000000";
const USERNAME = "someone+tag";
const SHORT_USER_ID = "0003";
const CAP_OPEN =
  "ff096a00030002402332f7fc41ba3d6f2385e28d4936bfa4100ee8789e99f12d46b9f9f5e55d5e7015d3cf698c7ef63ae60c4cfc8a9bcfb443aff2abe414563139c53cf4ab7c33ae61d8c1640e931af2ff3141464e996b16156819f4b4db46845af812448c7a1d2679b6";
const CAP_CLOSE =
  "ff096a000300024023f56a253cc41fc164eedd2d9b892fa475b90b8f7906369878ab7e921c22696af268515313bd60267433c682ec9c35240b9d835c76849d815878c3a7990c2965d3fc00617704de73e5477ff3eeb70c685d7f91f3df0b60e1982ccfbd13fcbbe57ba8";

describe("garage/lock ff09 command over MQTT (secure-mqtt trans envelope)", () => {
  it("lock:true builds the close frame, under the MQTT channel's apiCommand 1940", () => {
    const trans = buildFf09Trans({
      engage: true, // close
      adminUserId: ADMIN,
      deviceSn: SN,
      username: USERNAME,
      shortUserId: SHORT_USER_ID,
      unixTime: 1784216752, // recovered from the captured frame's A1 TLV
      nonce: 1784216759, // any nonce s.t. unixTime|nonce === the captured keyTime reproduces it exactly
      seqNum: 1,
    });
    expect(trans.cmd).toBe(CMD_TRANSFER_PAYLOAD);
    expect(trans.account_id).toBe("");
    expect(trans.payload.apiCommand).toBe(CMD_TRANSFER_PAYLOAD);
    expect(trans.payload.lock_payload).toBe(CAP_CLOSE);
    expect(trans.mChannel).toBe(0);
    expect(trans.mValue3).toBe(0);
  });

  it("lock:false builds the open frame, under apiCommand 1940", () => {
    const trans = buildFf09Trans({
      engage: false, // open
      adminUserId: ADMIN,
      deviceSn: SN,
      username: USERNAME,
      shortUserId: SHORT_USER_ID,
      unixTime: 1783952254,
      nonce: 1,
      seqNum: 1783952254,
    });
    expect(trans.payload.apiCommand).toBe(CMD_TRANSFER_PAYLOAD);
    expect(trans.payload.lock_payload).toBe(CAP_OPEN);
  });

  it("lock:true and lock:false produce the SAME frame length (both carry full user fields, real 106B)", () => {
    const c = buildFf09Trans({
      engage: true,
      adminUserId: ADMIN,
      deviceSn: SN,
      username: USERNAME,
      shortUserId: SHORT_USER_ID,
      unixTime: 1,
    }).payload.lock_payload;
    const o = buildFf09Trans({
      engage: false,
      adminUserId: ADMIN,
      deviceSn: SN,
      username: USERNAME,
      shortUserId: SHORT_USER_ID,
      unixTime: 1,
    }).payload.lock_payload;
    expect(c.length / 2).toBe(106); // bytes
    expect(o.length / 2).toBe(106);
  });

  it("ff09MqttTopic builds cmd/eufy_security/{pn}/{sn}/req regardless of the device's own category", () => {
    expect(ff09MqttTopic("T85D0", SN)).toBe(`cmd/eufy_security/T85D0/${SN}/req`);
  });

  it("buildFf09MqttEnvelope wraps the trans in {head:{cmd:9,…}, payload:{account_id,device_sn,trans,data,update_data,method}}", () => {
    const trans = buildFf09Trans({
      engage: true,
      adminUserId: ADMIN,
      deviceSn: SN,
      username: USERNAME,
      shortUserId: SHORT_USER_ID,
      unixTime: 1,
    });
    const envelope = buildFf09MqttEnvelope({
      trans,
      clientId: "client-1",
      accountId: ADMIN,
      deviceSn: SN,
      timestamp: 1700000000,
      sessId: "abcd",
      seed: "1234",
    });
    const obj = JSON.parse(envelope);
    expect(obj.head).toEqual({
      version: "1.0.0.1",
      client_id: "client-1",
      sess_id: "abcd",
      msg_seq: 1,
      seed: "1234",
      timestamp: 1700000000,
      cmd_status: 2,
      cmd: 9,
      sign_code: 0,
    });
    const payload = JSON.parse(obj.payload);
    expect(payload).toMatchObject({ account_id: ADMIN, device_sn: SN, data: "", update_data: "", method: "" });
    const decodedTrans = JSON.parse(Buffer.from(payload.trans, "base64").toString("utf-8"));
    expect(decodedTrans).toEqual(trans);
  });
});

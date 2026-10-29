import {
  buildApiParams,
  buildGetDeviceDpsAction,
  buildPublishDpsAction,
  buildUsernameTokenGetAction,
  buildPasswordLoginRegAction,
  DEFAULT_TUYA_ENV,
  type TuyaSession,
} from "../request.js";
import { buildSignPreimage, type TuyaSigner } from "../sign.js";
import { deriveBodyKey, decryptReply } from "../et3.js";

/** Records the preimage it is handed and returns a fixed digest — no native code needed. */
class SpySigner implements TuyaSigner {
  lastPreimage?: string;
  sign(preimage: string): string {
    this.lastPreimage = preimage;
    return "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
  }
}

const session: TuyaSession = {
  sid: "eu-sid-123",
  deviceId: "7932c5202387dffd14f2e2d75e0fbb8efa1cf7f28be5",
  chKey: "7cbfe6d8",
};

describe("buildApiParams", () => {
  it("fills static env + session + generated fields and appends sign", () => {
    const signer = new SpySigner();
    const params = buildApiParams(
      { a: "smartlife.p.time.get", v: "1.0" },
      { session, signer, time: 1783934864, requestId: "fixed-req-id" },
    );

    // per-action + generated
    expect(params.a).toBe("smartlife.p.time.get");
    expect(params.v).toBe("1.0");
    expect(params.time).toBe("1783934864");
    expect(params.requestId).toBe("fixed-req-id");
    // session
    expect(params.sid).toBe("eu-sid-123");
    expect(params.deviceId).toBe(session.deviceId);
    expect(params.chKey).toBe("7cbfe6d8");
    // static env (a representative subset)
    expect(params.os).toBe("Android");
    expect(params.ttid).toBe("android");
    expect(params.lang).toBe("en_GB");
    expect(params.et).toBe("3");
    expect(params.clientId).toBe(DEFAULT_TUYA_ENV.clientId);
    expect(params.sdkVersion).toBe("7.5.0");
    expect(params.bizData).toBe(DEFAULT_TUYA_ENV.bizData);
    expect(params.cp).toBe("gzip");
    expect(params.channel).toBe("sdk");
    expect(params.nd).toBe("1");
    // sign
    expect(params.sign).toHaveLength(64);
  });

  it("signs over the allowlisted subset and EXCLUDES bizData / sdkVersion / cp / channel", () => {
    const signer = new SpySigner();
    buildApiParams(
      { a: "smartlife.p.time.get", v: "1.0" },
      { session, signer, time: 1783934864, requestId: "5b5e39e5-4bfa-475c-ab6d-63170ac6f22f" },
    );
    const pre = signer.lastPreimage!;
    expect(pre).not.toContain("bizData");
    expect(pre).not.toContain("sdkVersion");
    expect(pre).not.toContain("cp=");
    expect(pre).not.toContain("channel=");
    // and DOES contain the allowlisted ones
    expect(pre).toContain("a=smartlife.p.time.get");
    expect(pre).toContain("chKey=7cbfe6d8");
    expect(pre).toContain("clientId=w8x4ppqkdxvqnd73ahj9");
  });

  it("encrypts postData for et=3 and folds the encrypted blob into the sign preimage", () => {
    const signer = new SpySigner();
    const action = buildGetDeviceDpsAction("dev-1");
    const params = buildApiParams(action, { session, signer, time: 1, requestId: "r" });
    // et=3 ships the body encrypted, not the plaintext JSON
    expect(params.postData).not.toBe(action.postData);
    expect(JSON.parse(decryptReply(deriveBodyKey("r", null), params.postData))).toEqual(JSON.parse(action.postData!));
    // preimage never contains the raw postData json (the encrypted blob is swapMd5-folded)
    expect(signer.lastPreimage).not.toContain("dev-1");
    expect(signer.lastPreimage).toContain("postData=");
  });
});

describe("dp action builders", () => {
  it("publishDps: smartlife.m.device.dp.publish v1.0 with nested stringified dps", () => {
    const action = buildPublishDpsAction("dev-1", "gw-1", { "101": true, "102": 50 });
    expect(action.a).toBe("smartlife.m.device.dp.publish");
    expect(action.v).toBe("1.0");
    expect(JSON.parse(action.postData!)).toEqual({
      gwId: "gw-1",
      devId: "dev-1",
      dps: JSON.stringify({ "101": true, "102": 50 }),
    });
  });

  it("getDeviceDps: smartlife.m.device.dp.get v1.0", () => {
    const action = buildGetDeviceDpsAction("dev-1");
    expect(action.a).toBe("smartlife.m.device.dp.get");
    expect(action.v).toBe("1.0");
    expect(JSON.parse(action.postData!)).toEqual({ devId: "dev-1" });
  });

  it("login action builders shape their postData", () => {
    // step 1: username.token.get
    const step1 = buildUsernameTokenGetAction("44", "eh-42");
    expect(step1.a).toBe("smartlife.m.user.username.token.get");
    expect(step1.v).toBe("2.0");
    expect(JSON.parse(step1.postData!)).toEqual({ countryCode: "44", username: "eh-42", isUid: true });

    // step 2: password.login.reg
    const step2 = buildPasswordLoginRegAction("44", "eh-42", "PW", "TOK");
    expect(step2.a).toBe("smartlife.m.user.uid.password.login.reg");
    expect(step2.v).toBe("1.0");
    expect(JSON.parse(step2.postData!)).toEqual({
      countryCode: "44",
      uid: "eh-42",
      passwd: "PW",
      token: "TOK",
      ifencrypt: 1,
      createGroup: true,
      options: '{"group": 1}',
    });
  });
});

describe("preimage builder parity", () => {
  it("buildApiParams' internal preimage equals buildSignPreimage over the same params", () => {
    const signer = new SpySigner();
    const params = buildApiParams({ a: "x", v: "1.0" }, { session, signer, time: 100, requestId: "req" });
    // Recompute from the emitted params (minus the sign) — must match what the signer saw.
    const { sign: _sign, ...unsigned } = params;
    expect(buildSignPreimage(unsigned)).toBe(signer.lastPreimage);
  });
});

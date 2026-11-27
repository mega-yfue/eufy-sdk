import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { Attr, Stun, decodeStun, encodeStun, longTermKey, readXorAddress, stunIntegrity, xorAddress } from "../stun.js";

const hex = (s: string) => Buffer.from(s.replace(/\s+/g, ""), "hex");

/** RFC 5769 §2.1: short-term request, username "evtj:h6vY". */
const REQUEST = hex(`000100582112a442b7e7a701bc34d686fa87dfae802200105354554e20746573742063
  6c69656e74002400046e0001ff80290008932ff9b151263b36000600096576746a3a68367659202020000800149aeaa70cbfd8cb56781ef2b5
  b2d3f249c1b571a280280004e57a3bcf`);
/** RFC 5769 §2.2: IPv4 response, mapped 192.0.2.1:32853. */
const RESPONSE = hex(`0101003c2112a442b7e7a701bc34d686fa87dfae8022000b7465737420766563746f7220
  00200008 0001a147e112a643 000800142b91f599fd9e90c38c7489f92af9ba53f06be7d780280004c07d4c96`);
/** RFC 5769 §2.4: long-term request, realm "example.org". */
const LONG_TERM = hex(`000100602112a44278ad3433c6ad72c029da412e00060012e3839ee38388e383aae38383e382afe382b9
  0000 0015001c662f2f3439396b39353464364f4c33346f4c394653547679363473410014000b6578616d706c652e6f726700
  00080014f67024656dd64a3e02b8e0712e85c9a28ca89666`);
const PWD = Buffer.from("VOkJxbRl1RmTxUk/WvJxBt");

describe("STUN (RFC 5769)", () => {
  it("checks the sample request's integrity and fingerprint", () => {
    const m = decodeStun(REQUEST)!;
    expect(m.attrs.get(Attr.USERNAME)!.toString()).toBe("evtj:h6vY");
    expect(stunIntegrity(m, PWD)).toBe(true);
    expect(stunIntegrity(m, Buffer.from("wrong"))).toBe(false);
    const bad = Buffer.from(REQUEST);
    bad[bad.length - 1]! ^= 1;
    expect(decodeStun(bad)).toBeUndefined();
  });

  it("reads and writes the IPv4 response's XOR-MAPPED-ADDRESS", () => {
    const m = decodeStun(RESPONSE)!;
    expect(stunIntegrity(m, PWD)).toBe(true);
    expect(readXorAddress(m.attrs.get(Attr.MAPPED))).toEqual({ address: "192.0.2.1", port: 32853 });
    expect(xorAddress({ address: "192.0.2.1", port: 32853 })).toEqual(m.attrs.get(Attr.MAPPED));
  });

  it("checks the long-term request under MD5(user:realm:password)", () => {
    const m = decodeStun(LONG_TERM)!;
    expect(stunIntegrity(m, longTermKey("マトリックス", "example.org", "TheMatrIX"))).toBe(true);
  });

  it("writes integrity and fingerprint the reader accepts", () => {
    const id = randomBytes(12);
    const m = decodeStun(encodeStun(Stun.BINDING, id, [[Attr.USERNAME, Buffer.from("evtj:h6vY")]], PWD, true))!;
    expect([m.type, m.id, stunIntegrity(m, PWD)]).toEqual([Stun.BINDING, id, true]);
  });
});

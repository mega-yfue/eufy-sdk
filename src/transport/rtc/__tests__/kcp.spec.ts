import { describe, expect, it } from "vitest";
import { Kcp } from "../kcp.js";

/** Two KCP ends with the PRIV1 conv-1 parameters, joined by a link that drops a seeded 20% of datagrams. */
function pair() {
  let seed = 7;
  const lossy = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % 100 < 20;
  const wire: [Kcp, Buffer][] = [];
  const make = () => {
    const k: Kcp = new Kcp(1, (d) => lossy() || wire.push([k === a ? b : a, Buffer.from(d)]));
    k.nodelay(1, 2, 2, 1);
    k.wndsize(512, 512);
    k.setmtu(1200);
    return k;
  };
  const a = make();
  const b = make();
  return { a, b, wire };
}

describe("Kcp", () => {
  it("delivers every message in order over a link losing 20% of datagrams", () => {
    const { a, b, wire } = pair();
    const sent = Array.from({ length: 40 }, (_, i) => Buffer.alloc(1 + ((i * 977) % 5000), i));
    for (const m of sent) expect(a.send(m)).toBe(true);
    const got: Buffer[] = [];
    for (let t = 0; t < 20_000 && got.length < sent.length; t++) {
      a.update(t);
      b.update(t);
      for (const [to, d] of wire.splice(0)) expect(to.input(d)).toBe(true);
      for (let m; (m = b.recv());) got.push(m);
    }
    expect(got).toEqual(sent);
  });

  it("clamps the nodelay interval to the app's 2 ms floor and uses its 2 ms nodelay minimum RTO", () => {
    const k = new Kcp(3, () => {});
    k.nodelay(1, 1, 2, 1);
    expect([k.interval, k.rxMinrto]).toEqual([2, 2]);
  });
});

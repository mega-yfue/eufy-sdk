/**
 * KCP (ikcp.c) in message mode, as the vendor app links it for its PRIV1 data channel: stock but for two constants,
 * `IKCP_RTO_NDL` = 2 (the minimum RTO in nodelay mode) and the `nodelay` interval floor of 2 ms. A segment is the
 * 24-byte little-endian header `conv u32, cmd u8, frg u8, wnd u16, ts u32, sn u32, una u32, len u32` and its data;
 * several segments share one datagram up to the MTU. A window probe or answer carries the sn and ts of the last ack
 * flushed before it, as ikcp's reused segment does.
 */
const RTO_NDL = 2;
const RTO_MIN = 100;
const RTO_DEF = 200;
const RTO_MAX = 60000;
const CMD_PUSH = 81;
const CMD_ACK = 82;
const CMD_WASK = 83;
const CMD_WINS = 84;
const ASK_SEND = 1;
const ASK_TELL = 2;
const WND_SND = 32;
const WND_RCV = 128;
const MTU_DEF = 1400;
const INTERVAL = 100;
const OVERHEAD = 24;
const DEADLINK = 20;
const THRESH_INIT = 2;
const THRESH_MIN = 2;
const PROBE_INIT = 7000;
const PROBE_LIMIT = 120000;
const FASTACK_LIMIT = 5;

interface Segment {
  conv: number;
  cmd: number;
  frg: number;
  wnd: number;
  ts: number;
  sn: number;
  una: number;
  data: Buffer;
  resendts: number;
  rto: number;
  fastack: number;
  xmit: number;
}

const diff = (a: number, b: number) => (a - b) | 0;
const u32 = (n: number) => n >>> 0;

function segment(data: Buffer): Segment {
  return { conv: 0, cmd: 0, frg: 0, wnd: 0, ts: 0, sn: 0, una: 0, data, resendts: 0, rto: 0, fastack: 0, xmit: 0 };
}

function encode(seg: Segment): Buffer {
  const b = Buffer.alloc(OVERHEAD + seg.data.length);
  b.writeUInt32LE(seg.conv, 0);
  b[4] = seg.cmd;
  b[5] = seg.frg;
  b.writeUInt16LE(seg.wnd, 6);
  b.writeUInt32LE(u32(seg.ts), 8);
  b.writeUInt32LE(u32(seg.sn), 12);
  b.writeUInt32LE(u32(seg.una), 16);
  b.writeUInt32LE(seg.data.length, 20);
  seg.data.copy(b, OVERHEAD);
  return b;
}

/** One KCP control block (`ikcpcb`); `output` receives each datagram {@link Kcp.flush} builds. */
export class Kcp {
  sndUna = 0;
  sndNxt = 0;
  rcvNxt = 0;
  ssthresh = THRESH_INIT;
  rxRttval = 0;
  rxSrtt = 0;
  rxRto = RTO_DEF;
  rxMinrto = RTO_MIN;
  sndWnd = WND_SND;
  rcvWnd = WND_RCV;
  rmtWnd = WND_RCV;
  cwnd = 0;
  incr = 0;
  probe = 0;
  mtu = MTU_DEF;
  mss = MTU_DEF - OVERHEAD;
  current = 0;
  interval = INTERVAL;
  tsFlush = INTERVAL;
  nodelayMode = 0;
  updated = false;
  tsProbe = 0;
  probeWait = 0;
  fastresend = 0;
  nocwnd = 0;
  state = 0;
  private sndQueue: Segment[] = [];
  private rcvQueue: Segment[] = [];
  private sndBuf: Segment[] = [];
  private rcvBuf: Segment[] = [];
  private acklist: [sn: number, ts: number][] = [];

  constructor(
    readonly conv: number,
    private readonly output: (datagram: Buffer) => void,
  ) {}

  /** `ikcp_nodelay`: a negative argument keeps its value; the interval is clamped to [2, 5000]. */
  nodelay(nodelay: number, interval: number, resend: number, nc: number): void {
    if (nodelay >= 0) {
      this.nodelayMode = nodelay;
      this.rxMinrto = nodelay ? RTO_NDL : RTO_MIN;
    }
    if (interval >= 0) this.interval = Math.min(Math.max(interval, 2), 5000);
    if (resend >= 0) this.fastresend = resend;
    if (nc >= 0) this.nocwnd = nc;
  }

  wndsize(snd: number, rcv: number): void {
    if (snd > 0) this.sndWnd = snd;
    if (rcv > 0) this.rcvWnd = Math.max(rcv, WND_RCV);
  }

  setmtu(mtu: number): void {
    this.mtu = mtu;
    this.mss = mtu - OVERHEAD;
  }

  /** `ikcp_send`: one message, split into at most 127 fragments of `mss`; `false` when it needs more. */
  send(data: Buffer): boolean {
    const count = Math.max(1, Math.ceil(data.length / this.mss));
    if (count >= WND_RCV) return false;
    for (let i = 0; i < count; i++) {
      const seg = segment(Buffer.from(data.subarray(i * this.mss, (i + 1) * this.mss)));
      seg.frg = count - i - 1;
      this.sndQueue.push(seg);
    }
    return true;
  }

  /** `ikcp_recv`: the next whole message, `undefined` while none is complete. */
  recv(): Buffer | undefined {
    const first = this.rcvQueue[0];
    if (!first || this.rcvQueue.length < first.frg + 1) return undefined;
    const recover = this.rcvQueue.length >= this.rcvWnd;
    const parts = this.rcvQueue.splice(0, first.frg + 1).map((s) => s.data);
    this.moveRcvBuf();
    if (this.rcvQueue.length < this.rcvWnd && recover) this.probe |= ASK_TELL;
    return Buffer.concat(parts);
  }

  /** `ikcp_input`: one datagram of segments; `false` when it is not this conversation's or malformed. */
  input(data: Buffer): boolean {
    const prevUna = this.sndUna;
    let maxack = 0;
    let latestTs = 0;
    let flag = false;
    if (data.length < OVERHEAD) return false;
    for (let o = 0; data.length - o >= OVERHEAD;) {
      if (data.readUInt32LE(o) !== this.conv) return false;
      const cmd = data[o + 4]!;
      const frg = data[o + 5]!;
      const wnd = data.readUInt16LE(o + 6);
      const ts = data.readUInt32LE(o + 8);
      const sn = data.readUInt32LE(o + 12);
      const una = data.readUInt32LE(o + 16);
      const len = data.readUInt32LE(o + 20);
      o += OVERHEAD;
      if (data.length - o < len) return false;
      if (cmd < CMD_PUSH || cmd > CMD_WINS) return false;
      this.rmtWnd = wnd;
      this.parseUna(una);
      this.shrinkBuf();
      if (cmd === CMD_ACK) {
        if (diff(this.current, ts) >= 0) this.updateAck(diff(this.current, ts));
        this.parseAck(sn);
        this.shrinkBuf();
        if (!flag) {
          flag = true;
          maxack = sn;
          latestTs = ts;
        } else if (diff(sn, maxack) > 0) {
          maxack = sn;
          latestTs = ts;
        }
      } else if (cmd === CMD_PUSH) {
        if (diff(sn, this.rcvNxt + this.rcvWnd) < 0) {
          this.acklist.push([sn, ts]);
          if (diff(sn, this.rcvNxt) >= 0) {
            const seg = segment(Buffer.from(data.subarray(o, o + len)));
            Object.assign(seg, { conv: this.conv, cmd, frg, wnd, ts, sn, una });
            this.parseData(seg);
          }
        }
      } else if (cmd === CMD_WASK) this.probe |= ASK_TELL;
      o += len;
    }
    if (flag) this.parseFastack(maxack, latestTs);
    if (diff(this.sndUna, prevUna) > 0 && this.cwnd < this.rmtWnd) {
      const mss = this.mss;
      if (this.cwnd < this.ssthresh) {
        this.cwnd++;
        this.incr += mss;
      } else {
        if (this.incr < mss) this.incr = mss;
        this.incr += Math.floor((mss * mss) / this.incr) + Math.floor(mss / 16);
        if ((this.cwnd + 1) * mss <= this.incr) this.cwnd = Math.floor((this.incr + mss - 1) / (mss > 0 ? mss : 1));
      }
      if (this.cwnd > this.rmtWnd) {
        this.cwnd = this.rmtWnd;
        this.incr = this.rmtWnd * mss;
      }
    }
    return true;
  }

  /** `ikcp_update`: at `current` ms, flush once the interval since the last flush has passed. */
  update(current: number): void {
    this.current = u32(current);
    if (!this.updated) {
      this.updated = true;
      this.tsFlush = this.current;
    }
    let slap = diff(this.current, this.tsFlush);
    if (slap >= 10000 || slap < -10000) {
      this.tsFlush = this.current;
      slap = 0;
    }
    if (slap >= 0) {
      this.tsFlush = u32(this.tsFlush + this.interval);
      if (diff(this.current, this.tsFlush) >= 0) this.tsFlush = u32(this.current + this.interval);
      this.flush();
    }
  }

  /** `ikcp_flush`: acks, window probes, then new and due segments, packed into datagrams of at most `mtu`. */
  flush(): void {
    if (!this.updated) return;
    const current = this.current;
    let out: Buffer[] = [];
    let size = 0;
    const put = (b: Buffer) => {
      if (size + b.length > this.mtu && size) {
        this.output(Buffer.concat(out));
        out = [];
        size = 0;
      }
      out.push(b);
      size += b.length;
    };
    const wnd = this.rcvQueue.length < this.rcvWnd ? this.rcvWnd - this.rcvQueue.length : 0;
    let [sn, ts] = [0, 0];
    const ctl = (cmd: number) =>
      put(encode({ ...segment(Buffer.alloc(0)), conv: this.conv, cmd, wnd, una: this.rcvNxt, sn, ts }));
    for ([sn, ts] of this.acklist) ctl(CMD_ACK);
    this.acklist = [];
    if (this.rmtWnd === 0) {
      if (this.probeWait === 0) {
        this.probeWait = PROBE_INIT;
        this.tsProbe = u32(current + this.probeWait);
      } else if (diff(current, this.tsProbe) >= 0) {
        if (this.probeWait < PROBE_INIT) this.probeWait = PROBE_INIT;
        this.probeWait += Math.floor(this.probeWait / 2);
        if (this.probeWait > PROBE_LIMIT) this.probeWait = PROBE_LIMIT;
        this.tsProbe = u32(current + this.probeWait);
        this.probe |= ASK_SEND;
      }
    } else {
      this.tsProbe = 0;
      this.probeWait = 0;
    }
    if (this.probe & ASK_SEND) ctl(CMD_WASK);
    if (this.probe & ASK_TELL) ctl(CMD_WINS);
    this.probe = 0;
    let cwnd = Math.min(this.sndWnd, this.rmtWnd);
    if (this.nocwnd === 0) cwnd = Math.min(this.cwnd, cwnd);
    while (diff(this.sndNxt, this.sndUna + cwnd) < 0 && this.sndQueue.length) {
      const seg = this.sndQueue.shift()!;
      Object.assign(seg, { conv: this.conv, cmd: CMD_PUSH, wnd, ts: current, sn: this.sndNxt, una: this.rcvNxt });
      Object.assign(seg, { resendts: current, rto: this.rxRto, fastack: 0, xmit: 0 });
      this.sndNxt = u32(this.sndNxt + 1);
      this.sndBuf.push(seg);
    }
    const resent = this.fastresend > 0 ? this.fastresend : 0xffffffff;
    const rtomin = this.nodelayMode === 0 ? this.rxRto >> 3 : 0;
    let change = 0;
    let lost = false;
    for (const seg of this.sndBuf) {
      let needsend = false;
      if (seg.xmit === 0) {
        needsend = true;
        seg.xmit++;
        seg.rto = this.rxRto;
        seg.resendts = u32(current + seg.rto + rtomin);
      } else if (diff(current, seg.resendts) >= 0) {
        needsend = true;
        seg.xmit++;
        if (this.nodelayMode === 0) seg.rto += Math.max(seg.rto, this.rxRto);
        else seg.rto += Math.floor((this.nodelayMode < 2 ? seg.rto : this.rxRto) / 2);
        seg.resendts = u32(current + seg.rto);
        lost = true;
      } else if (seg.fastack >= resent && (seg.xmit <= FASTACK_LIMIT || FASTACK_LIMIT <= 0)) {
        needsend = true;
        seg.xmit++;
        seg.fastack = 0;
        seg.resendts = u32(current + seg.rto);
        change++;
      }
      if (!needsend) continue;
      seg.ts = current;
      seg.wnd = wnd;
      seg.una = this.rcvNxt;
      put(encode(seg));
      if (seg.xmit >= DEADLINK) this.state = -1;
    }
    if (size) this.output(Buffer.concat(out));
    if (change) {
      this.ssthresh = Math.max(Math.floor(u32(this.sndNxt - this.sndUna) / 2), THRESH_MIN);
      this.cwnd = this.ssthresh + resent;
      this.incr = this.cwnd * this.mss;
    }
    if (lost) {
      this.ssthresh = Math.max(Math.floor(cwnd / 2), THRESH_MIN);
      this.cwnd = 1;
      this.incr = this.mss;
    }
    if (this.cwnd < 1) {
      this.cwnd = 1;
      this.incr = this.mss;
    }
  }

  private updateAck(rtt: number): void {
    if (this.rxSrtt === 0) {
      this.rxSrtt = rtt;
      this.rxRttval = Math.floor(rtt / 2);
    } else {
      const delta = Math.abs(rtt - this.rxSrtt);
      this.rxRttval = Math.floor((3 * this.rxRttval + delta) / 4);
      this.rxSrtt = Math.max(Math.floor((7 * this.rxSrtt + rtt) / 8), 1);
    }
    const rto = this.rxSrtt + Math.max(this.interval, 4 * this.rxRttval);
    this.rxRto = Math.min(Math.max(this.rxMinrto, rto), RTO_MAX);
  }

  private shrinkBuf(): void {
    this.sndUna = this.sndBuf[0]?.sn ?? this.sndNxt;
  }

  private parseAck(sn: number): void {
    if (diff(sn, this.sndUna) < 0 || diff(sn, this.sndNxt) >= 0) return;
    for (let i = 0; i < this.sndBuf.length; i++) {
      const seg = this.sndBuf[i]!;
      if (sn === seg.sn) {
        this.sndBuf.splice(i, 1);
        break;
      }
      if (diff(sn, seg.sn) < 0) break;
    }
  }

  private parseUna(una: number): void {
    let n = 0;
    while (n < this.sndBuf.length && diff(una, this.sndBuf[n]!.sn) > 0) n++;
    this.sndBuf.splice(0, n);
  }

  private parseFastack(sn: number, _ts: number): void {
    if (diff(sn, this.sndUna) < 0 || diff(sn, this.sndNxt) >= 0) return;
    for (const seg of this.sndBuf) {
      if (diff(sn, seg.sn) < 0) break;
      if (sn !== seg.sn) seg.fastack++;
    }
  }

  private parseData(seg: Segment): void {
    const sn = seg.sn;
    if (diff(sn, this.rcvNxt + this.rcvWnd) >= 0 || diff(sn, this.rcvNxt) < 0) return;
    let i = this.rcvBuf.length - 1;
    for (; i >= 0; i--) {
      const s = this.rcvBuf[i]!;
      if (s.sn === sn) return this.moveRcvBuf();
      if (diff(sn, s.sn) > 0) break;
    }
    this.rcvBuf.splice(i + 1, 0, seg);
    this.moveRcvBuf();
  }

  private moveRcvBuf(): void {
    while (this.rcvBuf.length && this.rcvBuf[0]!.sn === this.rcvNxt && this.rcvQueue.length < this.rcvWnd) {
      this.rcvQueue.push(this.rcvBuf.shift()!);
      this.rcvNxt = u32(this.rcvNxt + 1);
    }
  }
}

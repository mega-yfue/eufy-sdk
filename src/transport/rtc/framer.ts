/**
 * What sits between a portal packet and the WebRTC data channel.
 *
 * The hub does not read raw `XZYH` packets off `WebrtcDataChannel`: the portal runs them through its
 * own framing layer first — a "PTCS" packetiser with padding and forward-error-correction groups, which
 * the web client ships as a WebAssembly module (`libsctp`). Inbound, the same layer reassembles frames
 * and tags each with the logical channel it arrived on (command / notify / file / …).
 *
 * The SDK does not ship Anker's module: `ptcs-framer.ts` is a clean-room implementation of the same
 * wire format, written from that module's observed input/output. This interface is the seam: a framer
 * turns one outbound portal packet into wire packets and turns inbound wire packets back into frames,
 * and the session neither knows nor cares which implementation is behind it.
 */

import { isPortalPacket, PortalLinkType } from "./portal-packet.js";

export interface PortalFramer {
  /** Arm the two callbacks; resolves once `sendFrame` may be called. */
  init(onWirePacket: (packet: Buffer) => void, onFrame: (frame: Buffer, linkType: number) => void): Promise<void>;
  isReady(): boolean;
  /** One outbound portal packet → zero or more wire packets through `onWirePacket`. */
  sendFrame(portalPacket: Buffer): void;
  /** One inbound wire packet → zero or more frames through `onFrame`. */
  recvPacket(wirePacket: Buffer): void;
  destroy(): void;
}

export type PortalFramerFactory = () => PortalFramer;

/**
 * The identity framer: portal packets go on the wire as they are, and a wire packet that starts with
 * `XZYH` is a frame. This is what the portal's own client falls back to for a frame that arrives
 * un-wrapped. Kept as a diagnostic option: with it, the hub's *acknowledgements* are readable (it answers
 * unwrapped), while whether it *accepts* unwrapped commands is a question only the hardware can answer.
 */
export class PassthroughFramer implements PortalFramer {
  private onWire?: (packet: Buffer) => void;
  private onFrame?: (frame: Buffer, linkType: number) => void;
  private ready = false;

  async init(
    onWirePacket: (packet: Buffer) => void,
    onFrame: (frame: Buffer, linkType: number) => void,
  ): Promise<void> {
    this.onWire = onWirePacket;
    this.onFrame = onFrame;
    this.ready = true;
  }

  isReady(): boolean {
    return this.ready;
  }

  sendFrame(portalPacket: Buffer): void {
    if (!this.ready) throw new Error("framer not initialised");
    this.onWire?.(portalPacket);
  }

  recvPacket(wirePacket: Buffer): void {
    if (!this.ready) return;
    if (isPortalPacket(wirePacket)) this.onFrame?.(wirePacket, PortalLinkType.COMMAND);
  }

  destroy(): void {
    this.ready = false;
    this.onWire = undefined;
    this.onFrame = undefined;
  }
}

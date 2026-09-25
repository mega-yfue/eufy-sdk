/**
 * ADTS (Audio Data Transport Stream) helpers — the framing the device expects on the audio path a
 * host pushes toward a camera. A host hands over an arbitrarily-chunked byte stream (an encoder's
 * stdout, a file read), so frame boundaries have to be RECOVERED from the stream rather than assumed
 * to align with the chunks; this is the single place that scans for them.
 *
 * An ADTS frame is a 7-byte header (9 with CRC) followed by the raw audio payload, and the header's
 * own `frameLength` field spans header + payload — so the scan is self-delimiting once synced.
 * Header layout, MSB-first, as the V6 app writes it (`media/player/audio/AacEncode.java:43-51`):
 *
 * ```
 * byte 0     1111 1111   syncword high
 * byte 1     1111 iilp   syncword low · i=MPEG version+layer · p=1 ⇒ NO CRC (2 fewer header bytes)
 * byte 2     ppff ffpc   p=profile-1 · f=sampling-frequency index · c=channel-config high bit
 * byte 3     cc.. LLL    c=channel-config low 2 bits · L=frameLength bits 12..11
 * byte 4     LLLL LLLL   frameLength bits 10..3
 * byte 5     LLLb bbbb   frameLength bits 2..0 · b=buffer fullness high
 * byte 6     bbbb bbnn   buffer fullness low · n=frames-in-block minus one
 * ```
 *
 * The device's parameters are fixed and verified against the app's own encoder configuration
 * (`AacEncode.java:23-41`, `player/audio/BDBAudioConfig.java:6-66`): AAC-LC, 16 kHz, mono. One AAC-LC
 * frame is 1024 samples, so at 16 kHz each frame carries exactly 64 ms of audio — the cadence the
 * send side paces on.
 *
 * @module p2p/adts
 */

/** AAC profile field value for Low Complexity (the app sets `aac-profile` 2, encoded as profile-1). */
const PROFILE_AAC_LC = 1;

/** Sampling-frequency index for 16000 Hz in the ADTS table. */
const FREQ_INDEX_16K = 8;

/** Channel configuration for mono. */
const CHANNELS_MONO = 1;

/** Samples per AAC-LC frame — fixed by the codec, not by these parameters. */
export const AAC_SAMPLES_PER_FRAME = 1024;

/** Sample rate the device's audio path runs at. */
export const AAC_SAMPLE_RATE = 16000;

/**
 * Duration one frame represents, in milliseconds — `1024 / 16000`, exactly 64 ms. The send side both
 * paces on this and steps its frame timestamp by it.
 */
export const AAC_FRAME_MS = (AAC_SAMPLES_PER_FRAME * 1000) / AAC_SAMPLE_RATE;

/**
 * Largest frame the device accepts. The app drops anything longer before it reaches the wire
 * (`media/recorder/recorder/BDBRawAudioRecorder.java:98`), so a longer frame is a caller bug rather
 * than something to split or truncate.
 */
export const MAX_AUDIO_FRAME_BYTES = 640;

/** The shortest byte run that can carry a frame header, hence the minimum to attempt a parse. */
const HEADER_LEN_NO_CRC = 7;

/** Parsed fields of one ADTS header, with the payload it introduces. */
export interface AdtsHeader {
  /** Header + payload length, as declared by the header itself. */
  frameLength: number;
  /** Bytes of header ahead of the payload — 7 without a CRC, 9 with one. */
  headerLength: number;
  /** Profile field, `1` for AAC-LC. */
  profile: number;
  /** Index into the ADTS sampling-frequency table, `8` for 16 kHz. */
  frequencyIndex: number;
  /** Channel configuration, `1` for mono. */
  channels: number;
}

/**
 * Read an ADTS header at `offset`, or `undefined` when the bytes there are not a plausible header —
 * no syncword, a `frameLength` shorter than its own header, or not enough bytes to decide. Says
 * nothing about whether the frame's payload has arrived yet; that is the scanner's job.
 */
export function parseAdtsHeader(buf: Buffer, offset = 0): AdtsHeader | undefined {
  if (offset + HEADER_LEN_NO_CRC > buf.length) return undefined;
  if (buf[offset] !== 0xff || (buf[offset + 1] & 0xf0) !== 0xf0) return undefined;
  const headerLength = buf[offset + 1] & 0x01 ? 7 : 9;
  const frameLength = ((buf[offset + 3] & 0x03) << 11) | (buf[offset + 4] << 3) | ((buf[offset + 5] & 0xe0) >> 5);
  if (frameLength < headerLength) return undefined;
  return {
    frameLength,
    headerLength,
    profile: (buf[offset + 2] & 0xc0) >> 6,
    frequencyIndex: (buf[offset + 2] & 0x3c) >> 2,
    channels: ((buf[offset + 2] & 0x01) << 2) | ((buf[offset + 3] & 0xc0) >> 6),
  };
}

/**
 * The 7-byte ADTS header (no CRC, buffer fullness "variable") that frames one raw AAC-LC, 16 kHz, mono
 * access unit of `payloadLength` bytes, so that header and payload together read back through
 * {@link parseAdtsHeader} as a supported frame.
 */
export function buildAdtsHeader(payloadLength: number): Buffer {
  const frameLength = payloadLength + HEADER_LEN_NO_CRC;
  return Buffer.from([
    0xff,
    0xf1,
    (PROFILE_AAC_LC << 6) | (FREQ_INDEX_16K << 2) | (CHANNELS_MONO >> 2),
    ((CHANNELS_MONO & 0x03) << 6) | ((frameLength >> 11) & 0x03),
    (frameLength >> 3) & 0xff,
    ((frameLength & 0x07) << 5) | 0x1f,
    0xfc,
  ]);
}

/**
 * Whether a header describes the audio parameters the device's path is fixed at — AAC-LC, 16 kHz,
 * mono. A stream at any other rate or channel count is rejected rather than resampled: the device has
 * no way to be told otherwise, so passing it through would produce audio at the wrong pitch and speed.
 */
export function isSupportedAdts(h: AdtsHeader): boolean {
  return h.profile === PROFILE_AAC_LC && h.frequencyIndex === FREQ_INDEX_16K && h.channels === CHANNELS_MONO;
}

/**
 * Human-readable reason a header is unsupported, for the error a caller sees. Reports the decoded
 * values so a mis-configured encoder is obvious from the message alone.
 */
export function describeAdts(h: AdtsHeader): string {
  const rate = ADTS_SAMPLE_RATES[h.frequencyIndex] ?? `index ${h.frequencyIndex}`;
  const profile = h.profile === PROFILE_AAC_LC ? "AAC-LC" : `profile field ${h.profile}`;
  return `${profile}, ${rate} Hz, ${h.channels} channel(s)`;
}

/** The ADTS sampling-frequency table, indexed by a header's frequency-index field. */
const ADTS_SAMPLE_RATES: readonly (number | undefined)[] = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
];

/**
 * Incremental ADTS frame scanner. Feed it byte chunks in arrival order and it yields whole frames,
 * holding a partial frame across calls — which is the whole point: a host's chunk boundaries have no
 * relationship to frame boundaries, and a naive per-chunk parse would either split frames or resync
 * mid-payload and emit garbage.
 *
 * A byte run that does not begin with a syncword is skipped one byte at a time until one is found, so
 * a stream that starts mid-frame (or carries an encoder's preamble) recovers instead of failing.
 */
export class AdtsFrameReader {
  private buffered: Buffer = Buffer.alloc(0);

  /**
   * Append `chunk` and return every complete frame now available, each a standalone buffer that still
   * carries its own ADTS header (the device expects the header on the wire).
   */
  push(chunk: Buffer): Buffer[] {
    this.buffered = this.buffered.length ? Buffer.concat([this.buffered, chunk]) : chunk;
    const frames: Buffer[] = [];
    let at = 0;
    for (;;) {
      const h = parseAdtsHeader(this.buffered, at);
      if (!h) {
        if (at + HEADER_LEN_NO_CRC > this.buffered.length) break;
        at++;
        continue;
      }
      if (at + h.frameLength > this.buffered.length) break;
      frames.push(this.buffered.subarray(at, at + h.frameLength));
      at += h.frameLength;
    }
    this.buffered = at ? this.buffered.subarray(at) : this.buffered;
    return frames;
  }

  /** Bytes held back awaiting the rest of their frame — non-zero mid-stream, zero on a clean boundary. */
  get pending(): number {
    return this.buffered.length;
  }
}

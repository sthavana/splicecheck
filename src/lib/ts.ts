/**
 * Just enough MPEG-2 Transport Stream to find SCTE-35.
 *
 * In TS the cue is not in the manifest at all: the PMT declares an elementary
 * stream of type 0x86, and splice_info_sections arrive on that PID. This is
 * the form the signal has when it leaves the encoder, before any packager has
 * transcribed it into a playlist tag — so it is the reference the manifest
 * should agree with.
 */

export const TS_PACKET_SIZE = 188;
export const SYNC_BYTE = 0x47;
/** ISO/IEC 13818-1 stream_type for SCTE-35 cue messages. */
export const STREAM_TYPE_SCTE35 = 0x86;
/** ISO/IEC 13818-1 stream_type for metadata carried in PES packets. */
export const STREAM_TYPE_METADATA_PES = 0x15;

export interface TsScte35Cue {
  /** PID the cue arrived on */
  pid: number;
  /** raw splice_info_section */
  data: Uint8Array;
  /** byte offset of the packet that started it */
  offset: number;
  /**
   * How the cue was carried. A section on a stream_type 0x86 PID is the
   * broadcast form; HLS deployments more often wrap it in an ID3 PRIV frame
   * inside a PES packet on a metadata PID, which also gives it a PTS.
   */
  carriage: "section" | "id3-pes";
  /** presentation timestamp from the PES header, in 90kHz ticks */
  pts?: number;
  /** ID3 PRIV owner identifier, when carried that way */
  owner?: string;
}

export interface TsScan {
  packets: number;
  /** PIDs the PMT declared as carrying SCTE-35 */
  scte35Pids: number[];
  /** PIDs the PMT declared as carrying PES metadata (ID3) */
  metadataPids: number[];
  /** PIDs carrying a PCR, used to place the stream on a clock */
  pcrPids: number[];
  /** first PCR seen, in 90kHz ticks */
  firstPcr?: number;
  /**
   * Earliest presentation timestamp seen on an elementary stream, in 90kHz
   * ticks. This is what a playlist's program date-time refers to — the PCR
   * leads it by the decoder buffer delay, so anchoring on the PCR puts every
   * cue a fixed fraction of a second late.
   */
  firstPts?: number;
  cues: TsScte35Cue[];
  /** true when the buffer looked like a transport stream at all */
  isTransportStream: boolean;
}

/** Is this buffer an MPEG-2 transport stream? Checks the sync byte cadence. */
export function looksLikeTransportStream(buf: Uint8Array): boolean {
  if (buf.length < TS_PACKET_SIZE * 2) return false;
  let hits = 0;
  const probes = Math.min(10, Math.floor(buf.length / TS_PACKET_SIZE));
  for (let i = 0; i < probes; i++) {
    if (buf[i * TS_PACKET_SIZE] === SYNC_BYTE) hits++;
  }
  return hits >= Math.max(2, probes - 1);
}

interface SectionAssembly {
  chunks: Uint8Array[];
  expected: number;
  collected: number;
  offset: number;
}

/**
 * Walks a transport stream, following PAT to PMT to find the SCTE-35 PIDs,
 * then assembling the sections carried on them.
 */
export function scanTransportStream(buf: Uint8Array): TsScan {
  const scan: TsScan = {
    packets: 0,
    scte35Pids: [],
    metadataPids: [],
    pcrPids: [],
    cues: [],
    isTransportStream: looksLikeTransportStream(buf),
  };
  if (!scan.isTransportStream) return scan;

  const pmtPids = new Set<number>();
  const scte35Pids = new Set<number>();
  const metadataPids = new Set<number>();
  const pcrPids = new Set<number>();
  const assembling = new Map<number, SectionAssembly>();
  const pesAssembly = new Map<number, { chunks: Uint8Array[]; offset: number }>();

  const flushPes = (pid: number) => {
    const pending = pesAssembly.get(pid);
    if (!pending) return;
    pesAssembly.delete(pid);
    const pes = Buffer.concat(pending.chunks.map((c) => Buffer.from(c)));
    for (const cue of readId3Pes(new Uint8Array(pes))) {
      scan.cues.push({ pid, offset: pending.offset, carriage: "id3-pes", ...cue });
    }
  };

  for (let off = 0; off + TS_PACKET_SIZE <= buf.length; off += TS_PACKET_SIZE) {
    if (buf[off] !== SYNC_BYTE) continue;
    scan.packets++;

    const pid = ((buf[off + 1] & 0x1f) << 8) | buf[off + 2];
    const payloadStart = (buf[off + 1] & 0x40) !== 0;
    const adaptationControl = (buf[off + 3] >> 4) & 0x03;
    const hasAdaptation = adaptationControl === 0x02 || adaptationControl === 0x03;
    const hasPayload = adaptationControl === 0x01 || adaptationControl === 0x03;

    // The PCR rides in the adaptation field and is what places the stream on a
    // clock, so read it whether or not this packet also carries payload.
    if (hasAdaptation) {
      const afLen = buf[off + 4];
      if (afLen >= 7 && (buf[off + 5] & 0x10) !== 0) {
        pcrPids.add(pid);
        if (scan.firstPcr === undefined) {
          scan.firstPcr =
            buf[off + 6] * 2 ** 25 +
            buf[off + 7] * 2 ** 17 +
            buf[off + 8] * 2 ** 9 +
            buf[off + 9] * 2 +
            ((buf[off + 10] >> 7) & 1);
        }
      }
    }
    if (!hasPayload) continue;

    let p = off + 4;
    if (hasAdaptation) p += 1 + buf[off + 4];
    if (p >= off + TS_PACKET_SIZE) continue;

    // Track the earliest PTS on any elementary stream that is not the metadata
    // carriage, which is the segment's true presentation start.
    if (payloadStart && !metadataPids.has(pid) && pid !== 0 && !pmtPids.has(pid) && !scte35Pids.has(pid)) {
      const pts = readPesPts(buf, p, off + TS_PACKET_SIZE);
      if (pts !== undefined && (scan.firstPts === undefined || ptsBefore(pts, scan.firstPts))) {
        scan.firstPts = pts;
      }
    }

    if (metadataPids.has(pid)) {
      // PES packets are delimited by the unit-start flag, so a new one closes
      // whatever was being collected.
      if (payloadStart) flushPes(pid);
      const pending = pesAssembly.get(pid);
      if (payloadStart) pesAssembly.set(pid, { chunks: [buf.slice(p, off + TS_PACKET_SIZE)], offset: off });
      else if (pending) pending.chunks.push(buf.slice(p, off + TS_PACKET_SIZE));
      continue;
    }

    const isSectionPid = pid === 0 || pmtPids.has(pid) || scte35Pids.has(pid);
    if (!isSectionPid) continue;

    if (payloadStart) {
      const pointer = buf[p];
      p += 1 + pointer;
      if (p + 3 > off + TS_PACKET_SIZE) continue;
      const sectionLength = ((buf[p + 1] & 0x0f) << 8) | buf[p + 2];
      const total = sectionLength + 3;
      const available = off + TS_PACKET_SIZE - p;
      const chunk = buf.slice(p, p + Math.min(total, available));
      if (total <= available) {
        handleSection(chunk, pid, off);
      } else {
        assembling.set(pid, { chunks: [chunk], expected: total, collected: chunk.length, offset: off });
      }
    } else {
      const pending = assembling.get(pid);
      if (!pending) continue;
      const need = pending.expected - pending.collected;
      const available = off + TS_PACKET_SIZE - p;
      const chunk = buf.slice(p, p + Math.min(need, available));
      pending.chunks.push(chunk);
      pending.collected += chunk.length;
      if (pending.collected >= pending.expected) {
        const whole = new Uint8Array(pending.expected);
        let w = 0;
        for (const c of pending.chunks) {
          whole.set(c.slice(0, pending.expected - w), w);
          w += c.length;
        }
        handleSection(whole, pid, pending.offset);
        assembling.delete(pid);
      }
    }
  }

  function handleSection(section: Uint8Array, pid: number, offset: number) {
    const tableId = section[0];

    if (pid === 0 && tableId === 0x00) {
      // PAT: program_number / program_map_PID pairs
      const sectionLength = ((section[1] & 0x0f) << 8) | section[2];
      const end = Math.min(3 + sectionLength - 4, section.length);
      for (let i = 8; i + 4 <= end; i += 4) {
        const programNumber = (section[i] << 8) | section[i + 1];
        const pmtPid = ((section[i + 2] & 0x1f) << 8) | section[i + 3];
        if (programNumber !== 0) pmtPids.add(pmtPid);
      }
      return;
    }

    if (pmtPids.has(pid) && tableId === 0x02) {
      // PMT: walk the elementary streams looking for stream_type 0x86
      const sectionLength = ((section[1] & 0x0f) << 8) | section[2];
      const end = Math.min(3 + sectionLength - 4, section.length);
      const programInfoLength = ((section[10] & 0x0f) << 8) | section[11];
      let i = 12 + programInfoLength;
      while (i + 5 <= end) {
        const streamType = section[i];
        const elementaryPid = ((section[i + 1] & 0x1f) << 8) | section[i + 2];
        const esInfoLength = ((section[i + 3] & 0x0f) << 8) | section[i + 4];
        if (streamType === STREAM_TYPE_SCTE35) scte35Pids.add(elementaryPid);
        else if (streamType === STREAM_TYPE_METADATA_PES) metadataPids.add(elementaryPid);
        i += 5 + esInfoLength;
      }
      return;
    }

    if (scte35Pids.has(pid) && tableId === 0xfc) {
      scan.cues.push({ pid, data: section, offset, carriage: "section" });
    }
  }

  for (const pid of [...pesAssembly.keys()]) flushPes(pid);

  scan.scte35Pids = [...scte35Pids].sort((a, b) => a - b);
  scan.metadataPids = [...metadataPids].sort((a, b) => a - b);
  scan.pcrPids = [...pcrPids].sort((a, b) => a - b);
  return scan;
}

/**
 * Reads SCTE-35 out of an ID3 PRIV frame carried in a PES packet.
 *
 * HLS transport streams usually carry the cue this way rather than on a
 * stream_type 0x86 PID: a metadata PES whose ID3 tag holds a PRIV frame owned
 * by a SCTE-35 URN. The PES header's PTS is what places the cue on the clock.
 */
export function readId3Pes(pes: Uint8Array): { data: Uint8Array; pts?: number; owner?: string }[] {
  const out: { data: Uint8Array; pts?: number; owner?: string }[] = [];
  if (pes.length < 14) return out;
  if (!(pes[0] === 0x00 && pes[1] === 0x00 && pes[2] === 0x01)) return out;

  const flags2 = pes[7];
  const headerLength = pes[8];
  let pts: number | undefined;
  if ((flags2 & 0x80) !== 0 && pes.length >= 14) {
    const b = pes.subarray(9, 14);
    pts =
      ((b[0] >> 1) & 0x07) * 2 ** 30 +
      b[1] * 2 ** 22 +
      ((b[2] >> 1) & 0x7f) * 2 ** 15 +
      b[3] * 2 ** 7 +
      ((b[4] >> 1) & 0x7f);
  }

  const body = pes.subarray(9 + headerLength);
  if (body.length < 10) return out;
  if (!(body[0] === 0x49 && body[1] === 0x44 && body[2] === 0x33)) return out; // "ID3"

  // Synchsafe 28-bit size.
  const size =
    ((body[6] & 0x7f) << 21) | ((body[7] & 0x7f) << 14) | ((body[8] & 0x7f) << 7) | (body[9] & 0x7f);
  const end = Math.min(10 + size, body.length);

  let p = 10;
  while (p + 10 <= end) {
    const id = String.fromCharCode(body[p], body[p + 1], body[p + 2], body[p + 3]);
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const frameSize =
      (body[p + 4] << 24) | (body[p + 5] << 16) | (body[p + 6] << 8) | body[p + 7];
    if (frameSize <= 0 || p + 10 + frameSize > end) break;
    const frame = body.subarray(p + 10, p + 10 + frameSize);

    if (id === "PRIV") {
      const z = frame.indexOf(0);
      if (z > 0) {
        const owner = Buffer.from(frame.subarray(0, z)).toString("ascii");
        const data = frame.subarray(z + 1);
        // The owner names the scheme; the payload is the section itself.
        if (/scte35/i.test(owner) && data[0] === 0xfc) {
          out.push({ data: new Uint8Array(data), pts, owner });
        }
      }
    }
    p += 10 + frameSize;
  }
  return out;
}

/** Reads the PTS from a PES header, if one is present. */
export function readPesPts(buf: Uint8Array, start: number, end: number): number | undefined {
  if (start + 14 > end) return undefined;
  if (!(buf[start] === 0x00 && buf[start + 1] === 0x00 && buf[start + 2] === 0x01)) return undefined;
  const flags2 = buf[start + 7];
  if ((flags2 & 0x80) === 0) return undefined;
  const b = start + 9;
  return (
    ((buf[b] >> 1) & 0x07) * 2 ** 30 +
    buf[b + 1] * 2 ** 22 +
    ((buf[b + 2] >> 1) & 0x7f) * 2 ** 15 +
    buf[b + 3] * 2 ** 7 +
    ((buf[b + 4] >> 1) & 0x7f)
  );
}

/** Ordering on the 33-bit clock, tolerant of wrap. */
function ptsBefore(a: number, b: number): boolean {
  const half = 2 ** 32;
  const d = (a - b + 2 ** 33) % 2 ** 33;
  return d > half;
}

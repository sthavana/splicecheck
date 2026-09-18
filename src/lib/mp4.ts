/**
 * Just enough ISO BMFF to find event messages in a segment.
 *
 * DASH and CMAF carry SCTE-35 inband in an `emsg` box that sits at the top
 * level of a segment, normally ahead of the `moof`. Nothing here needs to
 * decode media — only to walk the box tree far enough to read those.
 */

export interface Mp4Box {
  type: string;
  /** offset of the box header within the buffer */
  start: number;
  /** offset of the box payload */
  dataStart: number;
  /** offset one past the end of the box */
  end: number;
}

/** ISO/IEC 23009-1 Event Message Box. */
export interface EmsgBox {
  version: number;
  schemeIdUri: string;
  value: string;
  timescale: number;
  /** version 0: relative to the segment's earliest presentation time */
  presentationTimeDelta?: number;
  /** version 1: absolute on the media timeline */
  presentationTime?: number;
  eventDuration: number;
  id: number;
  /** the payload — for SCTE-35 schemes this is a raw splice_info_section */
  messageData: Uint8Array;
  /** byte offset of the box in the segment, useful when reporting */
  offset: number;
}

const MAX_BOXES = 100_000;

/** Walks the boxes at one level of a buffer. */
export function readBoxes(buf: Uint8Array, start = 0, end = buf.length): Mp4Box[] {
  const boxes: Mp4Box[] = [];
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let pos = start;
  let guard = 0;

  while (pos + 8 <= end && guard++ < MAX_BOXES) {
    let size = dv.getUint32(pos);
    const type = String.fromCharCode(buf[pos + 4], buf[pos + 5], buf[pos + 6], buf[pos + 7]);
    let dataStart = pos + 8;

    if (size === 1) {
      // 64-bit largesize
      if (pos + 16 > end) break;
      const hi = dv.getUint32(pos + 8);
      const lo = dv.getUint32(pos + 12);
      size = hi * 2 ** 32 + lo;
      dataStart = pos + 16;
    } else if (size === 0) {
      // extends to the end of the buffer
      size = end - pos;
    }

    if (size < 8 || pos + size > end) break;
    boxes.push({ type, start: pos, dataStart, end: pos + size });
    pos += size;
  }
  return boxes;
}

/** Reads a NUL-terminated UTF-8 string, returning it and the next offset. */
function readString(buf: Uint8Array, pos: number, end: number): [string, number] {
  let i = pos;
  while (i < end && buf[i] !== 0) i++;
  const s = Buffer.from(buf.slice(pos, i)).toString("utf8");
  return [s, Math.min(i + 1, end)];
}

function parseEmsg(buf: Uint8Array, box: Mp4Box): EmsgBox | undefined {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let p = box.dataStart;
  if (p + 4 > box.end) return undefined;
  const version = buf[p];
  p += 4; // version + flags

  let schemeIdUri: string;
  let value: string;
  let timescale: number;
  let presentationTimeDelta: number | undefined;
  let presentationTime: number | undefined;
  let eventDuration: number;
  let id: number;

  try {
    if (version === 0) {
      [schemeIdUri, p] = readString(buf, p, box.end);
      [value, p] = readString(buf, p, box.end);
      if (p + 16 > box.end) return undefined;
      timescale = dv.getUint32(p);
      presentationTimeDelta = dv.getUint32(p + 4);
      eventDuration = dv.getUint32(p + 8);
      id = dv.getUint32(p + 12);
      p += 16;
    } else if (version === 1) {
      if (p + 20 > box.end) return undefined;
      timescale = dv.getUint32(p);
      presentationTime = dv.getUint32(p + 4) * 2 ** 32 + dv.getUint32(p + 8);
      eventDuration = dv.getUint32(p + 12);
      id = dv.getUint32(p + 16);
      p += 20;
      [schemeIdUri, p] = readString(buf, p, box.end);
      [value, p] = readString(buf, p, box.end);
    } else {
      return undefined;
    }
  } catch {
    return undefined;
  }

  return {
    version,
    schemeIdUri,
    value,
    timescale: timescale || 1,
    presentationTimeDelta,
    presentationTime,
    eventDuration,
    id,
    messageData: buf.slice(p, box.end),
    offset: box.start,
  };
}

/**
 * Finds every emsg in a segment. They live at the top level, but some
 * packagers place them inside other containers, so one level of descent is
 * allowed for the boxes that can legitimately hold them.
 */
export function findEmsgBoxes(buf: Uint8Array): EmsgBox[] {
  const found: EmsgBox[] = [];
  for (const box of readBoxes(buf)) {
    if (box.type === "emsg") {
      const e = parseEmsg(buf, box);
      if (e) found.push(e);
    }
  }
  return found;
}

/** Media timescale from an init segment's mvhd/mdhd, when one is available. */
export function readTimescale(buf: Uint8Array): number | undefined {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  for (const moov of readBoxes(buf).filter((b) => b.type === "moov")) {
    for (const child of readBoxes(buf, moov.dataStart, moov.end)) {
      if (child.type === "mvhd") {
        const version = buf[child.dataStart];
        const off = child.dataStart + 4 + (version === 1 ? 16 : 8);
        if (off + 4 <= child.end) return dv.getUint32(off);
      }
    }
  }
  return undefined;
}

/** baseMediaDecodeTime from the first tfdt, which anchors a segment on the timeline. */
export function readBaseMediaDecodeTime(buf: Uint8Array): number | undefined {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  for (const moof of readBoxes(buf).filter((b) => b.type === "moof")) {
    for (const traf of readBoxes(buf, moof.dataStart, moof.end).filter((b) => b.type === "traf")) {
      for (const tfdt of readBoxes(buf, traf.dataStart, traf.end).filter((b) => b.type === "tfdt")) {
        const version = buf[tfdt.dataStart];
        const p = tfdt.dataStart + 4;
        if (version === 1) {
          if (p + 8 <= tfdt.end) return dv.getUint32(p) * 2 ** 32 + dv.getUint32(p + 4);
        } else if (p + 4 <= tfdt.end) {
          return dv.getUint32(p);
        }
      }
    }
  }
  return undefined;
}

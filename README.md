# SpliceCheck

Point it at an HLS stream and it reconstructs every ad break, decodes the
SCTE-35 riding with it, and reports the conditions that make server-side ad
insertion mis-fire.

## Why

When an ad break fails — the break didn't fire, the splice was late, the pod
under-filled, the return froze — nobody can say *why* without an engineer
reading manifests by hand. The tools that do this properly are priced for
tier-one operators. This is the same analysis for everyone below them.

## What it checks

**SCTE-35 decoding** — full `splice_info_section` parser per ANSI/SCTE 35 2022:
`splice_insert`, `time_signal`, segmentation descriptors, UPIDs, break
durations, and CRC-32 validation. Accepts base64 or hex.

**Per-rendition rules**

| Code | What it catches |
| --- | --- |
| `SCTE35_DECODE_FAILED` | Payload isn't a valid splice_info_section — ad servers drop it silently |
| `SCTE35_CRC_INVALID` | Section decodes but CRC is stale; strict decisioning rejects it |
| `UNCLOSED_BREAK` | CUE-OUT with no CUE-IN on a finished asset |
| `ORPHAN_CUE_IN` | Return from a break that was never opened |
| `NESTED_CUE_OUT` | A break starts before the previous one closed |
| `BREAK_OVERRUN` / `BREAK_UNDERRUN` | Segments don't add up to the signalled duration — slate at the tail, or a truncated last ad |
| `SIGNAL_DURATION_DISAGREEMENT` | Manifest duration ≠ SCTE-35 duration; players and SSAI use different ones |
| `NO_DISCONTINUITY_AT_BREAK_START/END` | Splice point unmarked in a stitched stream — freezes at the return |
| `DATERANGE_DUPLICATE_ID` | Reused DATERANGE ID; players dedupe and lose the break |
| `EVENT_ID_REUSED` | Ad platforms dedupe avails on event ID and discard the later ones |
| `TARGETDURATION_EXCEEDED` | RFC 8216 violation, common on inserted segments |
| `PDT_DISCONTINUITY` | Wall clock inconsistent with segment durations |
| `SPLICE_IMMEDIATE` | No pre-roll for the ad decision server |

**Cross-rendition rules** — the ones that explain "it only fails on some
devices". Breaks are compared across every variant over the wall-clock window
they share: `VARIANT_BREAK_COUNT_MISMATCH`, `VARIANT_MISSING_BREAK`,
`VARIANT_BREAK_MISALIGNED`, `VARIANT_DURATION_MISMATCH`.

## Deliberate non-findings

Avoiding false positives matters more than finding everything — an engineer
stops trusting a tool the first time it cries wolf.

- A stream with signalling but **no discontinuities anywhere** is upstream of
  ad insertion, not broken. Reported once as context, not per break.
- Breaks **clipped by the start of the DVR window** or still **open at the live
  edge** aren't measurable, so duration rules skip them and they're excluded
  from cross-rendition comparison.
- Emitting **both a DATERANGE and a CUE-OUT** at one splice point is normal
  dual-signalling, counted as one break.
- True **signal lead time** can't be measured from a single poll, so it isn't
  claimed. That needs the continuous monitor.

## Signalling conventions supported

`EXT-X-CUE-OUT` / `EXT-X-CUE-OUT-CONT` / `EXT-X-CUE-IN`, `EXT-X-DATERANGE`
(`SCTE35-OUT` / `SCTE35-IN` / `SCTE35-CMD`), `EXT-OATCLS-SCTE35`,
`EXT-X-SCTE35`, `EXT-X-SPLICEPOINT-SCTE35`.

## Running it

```bash
npm install
npm run dev
```

`POST /api/analyze` with `{"url": "..."}` or `{"text": "<manifest>"}` returns
the full analysis as JSON.

## Not done yet

- DASH (`EventStream` / inband `emsg`)
- Continuous monitoring: poll a stream, measure real signal lead time, alert on
  breaks that fail
- Comparing pre-stitch signalling against post-stitch output

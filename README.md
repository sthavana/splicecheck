# SpliceCheck

Point it at an HLS or DASH stream and it reconstructs every ad break, decodes
the SCTE-35 riding with it, and reports the conditions that make server-side ad
insertion mis-fire. Then it watches the stream continuously and tells you when
that changes.

Two things: the **inspector** (`/`) for a one-off look, and the **monitor**
(`/monitors`) that polls on an interval and alerts on transitions.

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

**Cross-rendition rules (HLS)** — the ones that explain "it only fails on some
devices". Breaks are compared across every variant over the wall-clock window
they share: `VARIANT_BREAK_COUNT_MISMATCH`, `VARIANT_MISSING_BREAK`,
`VARIANT_BREAK_MISALIGNED`, `VARIANT_DURATION_MISMATCH`.

**DASH multi-period rules** — in DASH an avail is a Period, so the things that
break are different.

| Code | What it catches |
| --- | --- |
| `PERIOD_TIMELINE_GAP` / `_OVERLAP` | Period media doesn't meet the next Period's `@start` — stall or repeated frame at the ad boundary |
| `PTO_MISMATCH` | `@presentationTimeOffset` disagrees with `Period@start`, so the Period renders at the wrong time |
| `REPRESENTATION_SET_CHANGED` | The ad Period presents different codecs/resolutions than the content around it, forcing decoder re-init |
| `NO_PERIOD_CONTINUITY_SIGNAL` | Adjacent Periods are genuinely continuous but don't say so, so players re-initialise anyway |
| `AV_DURATION_SKEW` | Adaptation sets in one Period don't cover the same span — lip-sync drift through a pod |
| `EVENT_MISSING_ID` | SCTE-35 `Event` has no `@id`, so a client refreshing the MPD can't dedupe it |
| `EVENT_AMBIGUOUS_TIME` | Several Events default to the same presentation time |
| `EMPTY_PERIOD` | An avail was opened and never filled |
| `DUPLICATE_PERIOD_ID` / `PERIOD_MISSING_ID` | Clients key period state on `@id` |
| `MUP_LONGER_THAN_SHORTEST_BREAK` | An avail can begin and end between two MPD refreshes and never be seen |
| `DYNAMIC_NO_MUP` / `DYNAMIC_NO_AST` | A live MPD clients can't refresh or time-align |

## Deliberate non-findings

Avoiding false positives matters more than finding everything — an engineer
stops trusting a tool the first time it cries wolf.

- A stream with signalling but **no discontinuities anywhere** is upstream of
  ad insertion, not broken. Reported once as context, not per break.
- Breaks **clipped by the start of the DVR window** or still **open at the live
  edge** aren't measurable, so duration rules skip them and they're excluded
  from cross-rendition comparison.
- Emitting **both a DATERANGE and a CUE-OUT** at one splice point is normal
  dual-signalling, counted as one break. The same applies in DASH when the same
  SCTE-35 is published in both a standard and a vendor EventStream.
- The **oldest Period in a live window** has usually been trimmed by the
  time-shift buffer, so its media starting after `Period@start` is normal.
- Period continuity is measured against the **video** adaptation set. Audio
  timelines legitimately differ by a frame, and mixing them in invents a
  sub-frame gap at every boundary.
- True **signal lead time** can't be measured from a single poll, so it isn't
  claimed. That needs the continuous monitor.

## The monitor

Add a stream, pick an interval, optionally give it a Slack webhook. Each poll
runs the same analysis the inspector does, then compares it with the previous
poll.

**Alerts fire on transitions, not on state.** A monitor that pages you every
minute for a condition that has been true since Tuesday is a monitor people
mute. So: a fault alerts when it *appears*; the same fault on the next poll is
silent; and clearing it alerts once.

| Alert | Why it matters |
| --- | --- |
| `SIGNALLING_STOPPED` | The stream is up, players are happy, and nothing is being monetised. This does not show up as an outage. |
| `BREAK_STUCK_OPEN` | A break passed its signalled duration with no return. Players are still in ad mode. |
| `NEW_<code>` | Any error or warning that was not present on the previous poll. |
| `VERDICT_DEGRADED` | pass → warn → fail. |
| `STREAM_UNREACHABLE` | Two consecutive failed polls, so a single CDN hiccup stays quiet. |
| `STREAM_RECOVERED`, `ERRORS_CLEARED`, `SIGNALLING_RESUMED` | The all-clear. |

A new monitor's first successful poll establishes a baseline and does not alert
on pre-existing faults — otherwise adding a stream floods you.

State lives in SQLite at `./data/splicecheck.db` (override with
`SPLICECHECK_DB`). The poller runs in-process, so it needs a long-lived Node
process (`npm run dev`, `npm start`, or a container) — not a serverless
deployment. Moving it to Vercel would mean a hosted Postgres and a cron route.

## Signalling conventions supported

**HLS** — `EXT-X-CUE-OUT` / `EXT-X-CUE-OUT-CONT` / `EXT-X-CUE-IN`,
`EXT-X-DATERANGE` (`SCTE35-OUT` / `SCTE35-IN` / `SCTE35-CMD`),
`EXT-OATCLS-SCTE35`, `EXT-X-SCTE35`, `EXT-X-SPLICEPOINT-SCTE35`.

**DASH** — multi-period, `EventStream` with `urn:scte:scte35:2014:xml+bin`
(`Signal/Binary`), vendor EventStreams carrying `segmentTypeId`, `SegmentTemplate`
with `SegmentTimeline`.

UPIDs are rendered including MPU format identifiers with their private payload
(operators commonly carry pod metadata as JSON there) and MID sub-UPIDs.

## Running it

```bash
npm install
npm run dev     # inspector at /, monitors at /monitors
npm test        # 18 tests: spec vectors, planted defects, alert transitions
```

**API**

- `POST /api/analyze` — `{"url": "..."}` or `{"text": "<manifest>"}`
- `GET|POST /api/monitors`, `GET|PATCH|DELETE /api/monitors/:id`
- `GET|PATCH /api/alerts`

## Testing

`fixtures/broken.m3u8` and `fixtures/broken.mpd` each carry a set of deliberate
defects, and the suite asserts every one is reported. The SCTE-35 tests run
against published spec vectors and assert CRC validation, so a regression in the
decoder fails the build rather than silently mis-reading a stream.

## Not done yet

- Inband `emsg` events (DASH) and interstitials (`EXT-X-DATERANGE` with
  `CLASS="com.apple.hls.interstitial"`)
- Comparing pre-stitch signalling against post-stitch output — the check that
  proves the SSAI service did its job
- Real signal lead time, which needs the monitor to record when a signal first
  appeared relative to its splice point rather than inferring it from one poll

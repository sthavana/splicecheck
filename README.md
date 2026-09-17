# SpliceCheck

**Ad-break inspection for HLS and DASH.** Point it at a stream and it
reconstructs every ad break, decodes the SCTE-35 riding with it, and reports the
conditions that make server-side ad insertion mis-fire. Then it watches the
stream and tells you when that changes.

Three parts:

- **Inspector** (`/`) — a one-off look at any stream
- **Pipeline comparison** (`/compare`) — the feed going *into* an ad-insertion
  service against the stitched output coming *out* of it, to see which avails
  were actually filled
- **Monitor** (`/monitors`) — polls on an interval and alerts on transitions

---

## Try it without a live stream

Real manifests from production services are recorded in `fixtures/samples/`, so
the tool demonstrates itself whether or not those origins are still up:

- **Multi-period DASH, live linear** — 29 periods, 26 ad breaks, SCTE-35 in both
  a standard and a vendor EventStream
- **HLS, dual-signalled** — four renditions, each splice point carried as both
  `EXT-X-DATERANGE` and `EXT-X-CUE-OUT`

```bash
npm install && npm run dev      # then click a "recorded" sample
```

## Did the ad service do its job?

The question operations teams actually argue about. The encoder team says the
SCTE-35 was correct; the ad-tech team says the break never arrived. Both are
looking at different streams, and nothing puts the two side by side.

Give it the packager feed and the SSAI output and it matches avails on wall
clock, then reports what happened to each one:

| Status | What it means |
| --- | --- |
| `filled` | Substituted media covers the avail |
| `under-filled` | Short of the signalled duration — slate, black, or an early return. Directly measurable as unfilled inventory. |
| `over-filled` | Runs past the break, so content after it is cut |
| `passthrough` | **The break exists and nothing was substituted into it.** The manifest is well-formed, the player is happy, and no ad was delivered. This is the failure that looks healthy from every angle except revenue. |
| `not-stitched` | Signalled upstream, absent from the output entirely |
| `unsignalled` | In the output with nothing upstream asking for it |

The headline number is **fill rate**: the proportion of signalled avail seconds
the output actually fills. The worked example (`/compare` → "Run the worked
example") shows 40% across four avails — one filled, one 12s short, one passed
through, one never stitched.

Because matching is on wall clock — `EXT-X-PROGRAM-DATE-TIME` in HLS,
`availabilityStartTime` plus period start in DASH — the two sides do not have to
be the same protocol. A DASH packager feeding an HLS output compares fine.

Two judgement calls worth naming:

- **Substitution is inferred, and labelled as inference.** Media paths inside
  the avail are compared for shape against the output's *own* surrounding
  content, so `ads/creative-8821/seg_0003.ts` reads as substituted while a
  continuation of `content/prog_1016.ts` does not. That is evidence, not proof,
  and the UI says so.
- **The comparison window comes from the media extent, not from where the
  breaks are.** If it came from the breaks, an avail missing from the end of the
  output would shrink the window until it excluded itself — and the failure this
  whole feature exists to catch would silently disappear. There is a test for
  exactly that.

## What it found on real streams

Both of these are well-built services — the tool reports zero errors on each.
What it surfaces are the things nobody has a reason to look for:

**On the DASH service**

- Every Period presents **identical** Representation ids, codecs and
  resolutions, so the stream genuinely is continuous across all 28 boundaries —
  but no Period declares `urn:mpeg:dash:period-continuity:2015`. Many players
  therefore re-initialise the decoder at every ad transition, producing a
  glitch the encoder is not actually causing.
- The SCTE-35 `Event` elements carry no `@id`. The MPD refreshes every 2.002s
  and Periods live in a 30-minute window, so the same event is re-delivered
  roughly 900 times with nothing for a client to deduplicate on.
- Every avail overruns its signalled duration by a uniform 15ms or 30ms —
  quantisation, not a fault — **except one, which runs 128ms short.** That is
  about four frames off the tail of the last creative in the pod. It is the
  only one, and the analyser reports it and nothing else.
- The MPU UPID carries pod metadata as JSON, which the decoder renders:
  `BELL {"a":5.21,"p":"1/1","i":"718656169/4228397","b":"00:00:05;06","c":"TSN1","t":0}`

**On the HLS feed**

- The `splice_insert` payloads decode correctly — event ids and break durations
  match the manifest exactly — but their **CRC-32 does not validate**. The
  packager rewrote the section without recomputing the CRC. Strict ad
  decisioning rejects sections with a bad CRC, so these breaks can be dropped
  while looking perfect in the manifest.
- Every break sets `splice_immediate_flag`, so the ad decision server is told to
  switch now rather than at a known PTS, with no time to pre-fetch creatives.

## The harder half: not crying wolf

The first run against a real stream produced 21 errors and 56 warnings. Nearly
all of them were false positives. An engineer stops trusting a tool the first
time it cries wolf, so most of the work here is in **what it deliberately does
not report**:

- A feed carrying signalling but **no discontinuities anywhere** is upstream of
  ad insertion, not broken. Reported once as context, never per break.
- Breaks **clipped by the start of a DVR window**, or still **open at the live
  edge**, are not measurable. Duration rules skip them, and they are excluded
  from cross-rendition comparison.
- Emitting **both a DATERANGE and a CUE-OUT** at one splice point is normal
  dual-signalling — one break, not two. Same for DASH when the same SCTE-35 is
  published in both a standard and a vendor EventStream.
- The **oldest Period in a live window** has usually been trimmed by the
  time-shift buffer, so its media starting after `Period@start` is expected.
- Period continuity is measured against the **video** adaptation set. Audio
  timelines legitimately differ by a frame or two, and averaging them in invents
  a sub-frame gap at every boundary.
- **True signal lead time is not claimed**, because a single poll cannot measure
  it. An earlier version reported it and was quietly wrong; the rule was removed
  rather than left in looking authoritative.
- A live window that **opens part-way through a break** leaves a return whose
  departure has already aged out. That is the window sliding, not a lost signal.
  The same return *after* a break that paired correctly is still an error,
  because then it is not the window boundary.

That last one was found by running the monitor against a live stream for 90
minutes. It alternated between `pass` and `fail` roughly every ten minutes as
the DVR window slid across a break boundary — a healthy stream flapping purely
because of where the window happened to start. Alert fatigue does not announce
itself in a unit test; it shows up after an hour of real traffic.

## What it checks

**SCTE-35** — full `splice_info_section` decoder per ANSI/SCTE 35 2022:
`splice_insert`, `time_signal`, segmentation descriptors, UPIDs (including MPU
format identifiers with their private payload, and MID sub-UPIDs), break
durations, and CRC-32 validation. Accepts base64 or hex.

**HLS**

| Code | What it catches |
| --- | --- |
| `SCTE35_DECODE_FAILED` | Payload isn't a valid splice_info_section — ad servers drop it silently |
| `SCTE35_CRC_INVALID` | Section decodes but the CRC is stale; strict decisioning rejects it |
| `UNCLOSED_BREAK` / `ORPHAN_CUE_IN` / `NESTED_CUE_OUT` | Broken avail state machine |
| `BREAK_OVERRUN` / `BREAK_UNDERRUN` | Segments don't add up to the signalled duration — slate at the tail, or a truncated last ad |
| `SIGNAL_DURATION_DISAGREEMENT` | Manifest duration ≠ SCTE-35 duration; players and SSAI honour different ones |
| `NO_DISCONTINUITY_AT_BREAK_START/END` | Splice point unmarked in a stitched stream — freezes on the return |
| `DATERANGE_DUPLICATE_ID` / `EVENT_ID_REUSED` | Players and ad platforms deduplicate on these and discard the later ones |
| `DATERANGE_START_DATE_MISMATCH` | A DATERANGE's START-DATE disagrees with where it sits, so schedulers and players fire the break at different instants |
| `TARGETDURATION_EXCEEDED` / `PDT_DISCONTINUITY` | RFC 8216 violations and an inconsistent timeline |

**Cross-rendition (HLS)** — the rules that explain "it only fails on some
devices". Breaks are compared across every variant over the wall-clock window
they share: `VARIANT_BREAK_COUNT_MISMATCH`, `VARIANT_MISSING_BREAK`,
`VARIANT_BREAK_MISALIGNED`, `VARIANT_DURATION_MISMATCH`.

**DASH multi-period** — in DASH an avail is a Period, so different things break.

| Code | What it catches |
| --- | --- |
| `PERIOD_TIMELINE_GAP` / `_OVERLAP` | Period media doesn't meet the next `Period@start` — stall or repeated frame at the boundary |
| `PTO_MISMATCH` | `@presentationTimeOffset` disagrees with `Period@start`, so the Period renders at the wrong time |
| `REPRESENTATION_SET_CHANGED` | The ad Period presents different codecs/resolutions than the content around it, forcing decoder re-init |
| `NO_PERIOD_CONTINUITY_SIGNAL` | Boundaries that are genuinely continuous but don't declare it |
| `AV_DURATION_SKEW` | Adaptation sets in one Period don't cover the same span — lip-sync drift through a pod |
| `EVENT_MISSING_ID` / `EVENT_AMBIGUOUS_TIME` | Events a refreshing client can't deduplicate or order |
| `EMPTY_PERIOD` | An avail was opened and never filled — what a failed ad decision looks like |
| `MUP_LONGER_THAN_SHORTEST_BREAK` | An avail can begin and end between two MPD refreshes and never be seen |

## The monitor

Add a stream, pick an interval, optionally give it a Slack webhook. Each poll
runs the same analysis the inspector does — so the alerts and the UI can never
disagree — then compares the result with the previous poll.

**Alerts fire on transitions, not on state.** A monitor that pages you every
minute about a condition that has been true since Tuesday is a monitor people
mute. A fault alerts when it *appears*; the same fault next poll is silent;
clearing it alerts once.

| Alert | Why it matters |
| --- | --- |
| `SIGNALLING_STOPPED` | Stream up, players happy, nothing being monetised. Does not look like an outage. |
| `BREAK_STUCK_OPEN` | A break past its signalled duration with no return. Players are still in ad mode. |
| `NEW_<code>` | Any error or warning not present on the previous poll |
| `VERDICT_DEGRADED` | pass → warn → fail |
| `STREAM_UNREACHABLE` | Two consecutive failures, so one CDN hiccup stays quiet |
| `STREAM_RECOVERED` / `ERRORS_CLEARED` / `SIGNALLING_RESUMED` | The all-clear |

A new monitor's first successful poll establishes a baseline and does not alert
on pre-existing faults — otherwise adding a stream floods you. A finding that
occurs in several renditions is one alert, not one per rendition.

**What 90 minutes of live polling taught it.** The first long run produced 55
alerts for two healthy streams. Three separate causes, all fixed:

1. A fault present in four renditions raised four identical alerts.
2. Live windows sliding across a break boundary produced errors that cleared
   themselves minutes later, so `VERDICT_DEGRADED` and `ERRORS_CLEARED` traded
   places ten times over.
3. Genuine origin blips raised alerts before the two-failure threshold had
   real data behind it.

None of these were visible in the test suite until the behaviour they caused
was understood well enough to write a test for. Both fixes are now covered.

## Testing

```bash
npm test      # 26 tests
```

- **Spec vectors** — the SCTE-35 decoder is asserted against published ANSI/SCTE
  35 vectors, including CRC validation, so a regression fails the build rather
  than silently mis-reading a stream.
- **Planted defects** — `fixtures/broken.m3u8` and `fixtures/broken.mpd` each
  carry a set of deliberate faults; the suite asserts every one is reported.
- **Real captures** — the recorded production manifests are asserted on too,
  including the single 128ms short avail and the fact that cross-rendition
  comparison stays *silent* on a stream whose renditions do agree.
- **Alert transitions** — including the case that matters most: a steady,
  unchanged stream must produce no alerts at all.
- **Pipeline comparison** — every SSAI outcome is asserted against a worked
  source/output pair, and a correctly stitched stream must produce *no findings
  whatsoever*. A tool that cannot stay silent on a healthy pipeline is useless
  on an unhealthy one.

## Architecture

```
src/lib/scte35.ts      splice_info_section decoder (no dependencies)
src/lib/hls.ts         HLS playlist parser
src/lib/dash.ts        MPD parser — multi-period, EventStream, SegmentTimeline
src/lib/analyze.ts     HLS break reconstruction + rules + cross-rendition
src/lib/analyzeDash.ts DASH period analysis + rules
src/lib/runner.ts      one analysis path, with the fetcher injected
src/lib/pipeline.ts    source vs stitched-output comparison
src/lib/monitor.ts     polling, transition diffing, alert delivery
src/lib/store.ts       SQLite state
```

The fetcher is injected, so the identical analysis runs against the network, a
recorded bundle, or a test fixture. The monitor calls the same `analyzeUrl` the
API does.

State lives in SQLite at `./data/splicecheck.db` (override with
`SPLICECHECK_DB`). The poller runs in-process, so it needs a long-lived Node
process — `npm run dev`, `npm start`, or a container. A serverless deployment
would need a hosted database and a cron route instead.

## Not done yet

- Inband `emsg` events (DASH) and HLS interstitials
  (`EXT-X-DATERANGE` with `CLASS="com.apple.hls.interstitial"`)
- Per-creative breakdown inside a filled avail — which creatives ran, and
  whether the pod was assembled as the ad server intended
- Running the pipeline comparison continuously, so fill rate becomes a tracked
  metric rather than a spot check
- Real signal lead time, which requires the monitor to record when a signal
  first appeared relative to its splice point rather than inferring it from a
  single poll

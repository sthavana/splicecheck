# The ad response

Everything else about ad insertion is about the *signal*: where the break is, how
long it runs, how that gets from an encoder to a manifest to a stitcher. This is
about the other half. The signal says an avail exists. The response says what
goes in it.

The two halves fail in completely different ways, and they get blamed on each
other constantly. An avail that is signalled perfectly and filled with a creative
the packager cannot use is still an unfilled avail — and from the manifest, it
looks exactly like a signalling fault.

**Contents**

---

## 1. What a VAST response is

**VAST** — Video Ad Serving Template — is an XML document that answers the
question *what should I play here*. It is the lingua franca between an ad
decision service and whatever is going to play the ad.

At its simplest it is one ad, with one creative, with one media file:

```xml
<VAST version="4.2">
  <Ad id="4417">
    <InLine>
      <AdSystem>Some Decision Service</AdSystem>
      <AdTitle>Northbridge Motors</AdTitle>
      <Impression><![CDATA[https://ads.example/imp?c=4417]]></Impression>
      <Error><![CDATA[https://ads.example/err?code=[ERRORCODE]]]></Error>
      <Creatives>
        <Creative id="c1">
          <UniversalAdId idRegistry="Ad-ID">ABCD0001000H</UniversalAdId>
          <Linear>
            <Duration>00:00:30</Duration>
            <TrackingEvents>
              <Tracking event="start"><![CDATA[https://ads.example/t?e=start]]></Tracking>
              <Tracking event="firstQuartile">…</Tracking>
              <Tracking event="midpoint">…</Tracking>
              <Tracking event="thirdQuartile">…</Tracking>
              <Tracking event="complete">…</Tracking>
            </TrackingEvents>
            <MediaFiles>
              <MediaFile type="video/mp4" codec="avc1.64001f"
                         width="1280" height="720" bitrate="2500"
                         delivery="progressive">
                <![CDATA[https://cdn.ads.example/4417/720p.mp4]]>
              </MediaFile>
            </MediaFiles>
          </Linear>
        </Creative>
      </Creatives>
    </InLine>
  </Ad>
</VAST>
```

Five things in that document matter more than the rest.

**`<Duration>`** is what a stitcher lays the pod out against, before it fetches
anything at all. It is a declaration, not a measurement — and when it disagrees
with the actual media, the media wins and the timeline is wrong.

**`<MediaFile>`** is the only part that is actually video. Everything else is
metadata about it. A response can be perfectly well-formed and contain no media
anyone downstream can use.

**`<Impression>`** is what gets counted, and therefore what gets billed. An ad
that plays without firing one is inventory delivered for free.

**`<Error>`** is how the decision service finds out its creative failed. Leave it
out and the ad server's fill rate stays beautiful while viewers watch slate —
two teams looking at different numbers, both of them correct.

**`<UniversalAdId>`** identifies the creative across systems. Without it,
deduplication and frequency capping are guesswork.

**SpliceCheck:** the ad response tool reads all of these and reports the ones
that are missing, with the consequence attached rather than just the rule.

---

## 2. Inline and wrapper

An `<Ad>` contains either an `<InLine>` — an actual ad — or a `<Wrapper>`, which
is a redirect to another VAST document:

```xml
<Ad id="w1">
  <Wrapper followAdditionalWrappers="true" allowMultipleAds="false">
    <AdSystem>An Exchange</AdSystem>
    <VASTAdTagURI><![CDATA[https://demand.example/vast?bid=xyz]]></VASTAdTagURI>
    <Impression><![CDATA[https://exchange.example/imp]]></Impression>
  </Wrapper>
</Ad>
```

Wrappers exist because the supply chain is a chain. A request passes through a
publisher's ad server, then a network, then an exchange, then a demand partner,
and each one wants its own impression counted. Each hop adds a redirect.

The impressions accumulate: every wrapper in the chain contributes its
`<Impression>` and its tracking URLs, and the player or stitcher is expected to
fire all of them, not just the ones from the final document.

### Why chains cost more than they look

Every hop is a real HTTP round trip, and they are **serial** — nothing can
request the next document until the previous one has answered.

| Hops | At 150ms each | At 400ms each |
| --- | --- | --- |
| 1 | 150ms | 400ms |
| 3 | 450ms | 1.2s |
| 5 | 750ms | 2.0s |

IAB guidance puts the limit at five redirects, and most players enforce
something like it. But the limit that bites first is almost always the clock,
not the count. If the ad decision has one second — and on a low-latency stream
it does — then three hops at four hundred milliseconds have spent the entire
budget before anybody has looked at a creative.

Two other wrapper failures are worth naming because they are silent:

- **A loop.** A wrapper that points back at a document already in the chain.
  Players follow it until they hit their own depth limit, then report an error —
  having paid for every round trip on the way.
- **A body that is not VAST.** A redirect that answers with an HTML error page
  fails exactly like one that does not answer at all, but it is harder to notice
  because the request succeeded. HTTP 200 is not the same as an ad.

**SpliceCheck:** following the chain is opt-in, because it makes real requests
to somebody else's ad server. It reports the depth, the per-hop timing, the
total, and whether the chain loops, dead-ends, or answers with something
unparseable.

---

## 3. What changes when a stitcher is the consumer

This is the section that matters if you work on the video side, and it is the
one most VAST documentation skips, because VAST was designed for players.

A **player** is a browser or an app. It has a JavaScript engine, it knows the
device, it knows the current bandwidth, and it can choose a media file at the
moment of playback.

A **stitcher** — a server-side ad insertion service — has none of that. It is
picking media ahead of time, on behalf of viewers it cannot see, to splice into
a presentation that already exists.

| | A player can | A stitcher cannot |
| --- | --- | --- |
| Executable creatives | Run VPAID JavaScript in its own context | There is no browser. A VPAID-only response is unfillable. |
| Media selection | Choose at playback, knowing device and bandwidth | Must choose up front, for everyone |
| Mismatched encodes | Tear down and re-initialise its decoder | Can transcode — with time the decision budget may not have |
| Tracking | Fire beacons from the device, reflecting what played | Infers playback from segment requests |
| Interactivity | Overlays, clickthrough, skip buttons | Has no UI surface at all |

### VPAID, and why it cannot work server-side

**VPAID** creatives are JavaScript. The ad is a program the player executes,
which is how interactive and expandable ads work. Server-side insertion has no
JavaScript engine, no DOM, and no player context — so a VPAID creative is not
"hard to stitch", it is impossible to stitch.

A response offering VPAID alongside a plain MP4 is fine; the stitcher takes the
MP4. A response offering *only* VPAID is an unfilled avail by construction,
however healthy the signalling around it.

VPAID is deprecated in VAST 4.x in favour of **SIMID** for interactivity and
**OMID** for verification, precisely because conflating the ad's media with the
ad's code made server-side delivery impossible. Plenty of inventory still
returns it.

### The creative has to fit a ladder that already exists

The ad is going to be spliced into an existing presentation with an existing ABR
ladder. Two mismatches matter:

- **Codec.** An HEVC ad in an H.264 stream forces a decoder tear-down at both
  ends of the break. That is the black frame or audio drop that gets reported as
  "the ad broke the stream" — and the cause is the ad service's encode, not the
  packager's.
- **Bitrate.** A creative encoded at 9 Mbps spliced into a ladder that tops out
  at 1.3 Mbps is heavier than anything that viewer has ever sustained. The
  rebuffer lands in the middle of the ad.

Conditioning ads — transcoding them to match the content ladder's codec, GOP
structure and rungs — is normally a separate pipeline that runs before the ad is
ever eligible. When it is missing or incomplete, the symptom appears at playback
and looks like a delivery fault.

**SpliceCheck:** give it the stream URL alongside the response and it compares
the creative's codec and bitrate against that stream's actual ladder. It ignores
the ladder's audio codecs when doing so — comparing an ad's video against
`mp4a` would report a mismatch on every well-formed stream there is.

---

## 4. Pods, and fitting the hole

An avail is rarely one ad. A ninety-second break is typically three thirties, or
a sixty and a thirty — a **pod**. VAST expresses this with multiple `<Ad>`
elements carrying a `sequence` attribute.

The arithmetic is unforgiving, because the break has a fixed length that
something else already decided:

- **The pod runs long.** The stitcher either truncates the last ad — which is
  then unbillable, and the advertiser is entitled to object — or it runs past the
  return and cuts into programme content.
- **The pod runs short.** The remainder is slate, black, or an early return. This
  is *under-fill*, and it is directly measurable lost revenue rather than a
  delivery fault.
- **The pod is empty.** No ads returned at all. The break collapses and content
  resumes, which is correct behaviour and completely invisible.

That last case deserves emphasis. An empty VAST response is not malformed. It is
how a decision service says *I have nothing for you*. Nothing in the manifest,
nothing in the player, and nothing in the delivery chain registers a fault —
and yet the inventory went unsold. It is indistinguishable from success unless
somebody is counting.

**SpliceCheck:** the pod is measured against the avail duration the SCTE-35
asked for, using the same over- and under-fill arithmetic the pipeline
comparison applies to manifests. An empty response is reported as no fill, at
warning rather than error, because it is a business outcome and not a bug.

---

## 5. Tracking, and what it can honestly tell you

A creative carries tracking URLs for the points in its playback worth knowing
about:

| Event | Fired when | What its absence costs |
| --- | --- | --- |
| `impression` | The ad begins | Nothing is billed |
| `start` | Playback starts | Cannot separate served from played |
| `firstQuartile` | 25% | — |
| `midpoint` | 50% | The most common completion proxy |
| `thirdQuartile` | 75% | — |
| `complete` | 100% | Completion rate is unmeasurable |
| `error` | The creative failed | The ad server never learns |

Without the full quartile set, an ad that ran to the end reports identically to
one that failed halfway. Completion rate — which is what most campaigns are
actually judged on — becomes unavailable.

### Who fires them changes what they mean

This is the measurement trade-off between the two insertion models, and it is
worth being precise about.

**Client-side**: the player fires the beacons. They reflect what actually
happened on the device — including that the tab was backgrounded, the player was
muted, or the viewer scrolled away. Accurate, and reachable by an ad blocker.

**Server-side**: the stitcher fires them, inferring playback from segment
requests. Robust against blocking, because the requests never come from the
device. But a segment request is not a view: the player may have requested it
and never rendered it, or rendered it muted, or rendered it off-screen.

Neither is wrong. They are measuring different things, and comparing a
client-side campaign's numbers with a server-side one's is comparing two
different definitions of "played".

**OMID** — Open Measurement — exists to close part of this gap by letting a
verification vendor observe the ad inside the player even when the ad was
inserted server-side.

---

## 6. VMAP: the schedule

Where VAST answers *what plays here*, **VMAP** answers *where are the breaks*.
It is the VOD counterpart to a live stream's SCTE-35 cues — a schedule, computed
in advance, for an asset whose timeline is fully known.

```xml
<VMAP version="1.0">
  <AdBreak timeOffset="start" breakType="linear" breakId="pre">
    <AdSource><AdTagURI><![CDATA[https://ads.example/pre]]></AdTagURI></AdSource>
  </AdBreak>
  <AdBreak timeOffset="00:10:00" breakType="linear" breakId="mid1">
    <AdSource><AdTagURI><![CDATA[https://ads.example/mid1]]></AdTagURI></AdSource>
  </AdBreak>
  <AdBreak timeOffset="end" breakType="linear" breakId="post">
    <AdSource><AdTagURI><![CDATA[https://ads.example/post]]></AdTagURI></AdSource>
  </AdBreak>
</VMAP>
```

`timeOffset` accepts `start`, `end`, a timestamp, or a percentage. Each break
names an `AdSource` — either a tag URI to call at playback, or an inline VAST
document embedded directly.

Three things go wrong often enough to check for:

- **A break with no `timeOffset`.** Nothing says where it belongs, so
  implementations differ on whether to drop it or place it at the start.
- **A break with no `AdSource`.** The slot is scheduled with nothing to put in
  it. It will be empty.
- **Two breaks at the same offset.** This is not a pod — a pod is several ads in
  one break. Players differ on whether they run both, run one, or error, so the
  behaviour is not predictable across devices.

---

## 7. Where this connects to the rest of the chain

The ad response does not sit on its own. Two connections matter more than the
rest, and both are invisible if you only look at one layer.

**Lead time and wrapper depth are the same problem.** Lead time is how much of a
head start the decision gets — the gap between the cue reaching the manifest and
the splice happening. The wrapper chain is how much of that head start the
decision spends before it begins deciding. A stream can carry a generous cue,
well ahead of the splice point, and still under-fill because four redirects
consumed it. Neither number appears in the other's documentation.

**The symptom surfaces a layer away from the cause.** A VPAID-only response, a
creative in the wrong codec, a chain that times out — all three appear
downstream as an avail that did not fill. In the manifest, that looks like a
signalling fault, and it is usually reported as one. The packaging team then
spends a day proving the SCTE-35 was correct, which it was.

That is the argument for checking both halves with the same tool: not because
the two are similar, but because when they disagree, whoever is looking at only
one of them will reach the wrong conclusion with complete confidence.

# Where video and ad tech talk past each other

Ad insertion is built by two groups of people who rarely share a standup. One
owns encoders, packagers, origins and CDNs. The other owns decision services,
creatives, campaigns and reporting. Both are competent. Both are usually right
about their own half.

What follows are the disagreements that come up again and again — not because
anybody is wrong, but because the same word means two different things, or
because a fault in one half only becomes visible in the other.

**Contents**

---

## 1. Words that mean two things

### "Fill rate" — 100% and 60% at the same time

**Ad tech** means the proportion of ad requests that came back with an ad. If
the decision service answered every request, fill rate is 100%.

**Video** means the proportion of avail seconds actually occupied by ad
content. If a 90-second break got 60 seconds of creative, fill rate is 67%.

Both numbers can be correct simultaneously, and they usually are. A decision
service that returns two thirties for a ninety-second break has filled every
request it received and left a third of the inventory empty.

When the two teams compare numbers in a meeting and they do not match, this is
the reason about half the time. The fix is not a better number; it is naming
which one you mean.

### "Latency" — glass to glass, or the ad server's response time

**Video** means the distance between something happening and a viewer seeing
it. Two seconds is low. Thirty is normal for HLS at default settings.

**Ad tech** means how long the decision service took to answer. Two hundred
milliseconds is good. Eight hundred is tolerable.

These are not the same scale and they are not the same problem, but they meet
at one point: the ad decision has to complete inside the distance the viewer is
sitting behind live. At thirty seconds of latency, an 800ms decision is
invisible. At two seconds, it is nearly half the budget.

### "The ad didn't play"

**Video** checks the manifest: the break is there, the markers are correct, the
segments exist. Nothing is wrong.

**Ad tech** checks the ad server: the request arrived, a creative was selected,
the impression fired. Nothing is wrong.

The viewer saw slate.

Both teams are looking at true information about their own half. The fault
lives in the handoff — and neither system has a view of the handoff. This is
the single most common shape of an ad-insertion incident.

---

## 2. What the cue does and does not say

### SCTE-35 does not say what ad to play

It says an opportunity exists, when it starts, and how long it runs. That is
all. It carries no creative, no campaign, no targeting.

The confusion comes from the UPID, which looks like an identifier for the ad
and is not. A UPID identifies the *opportunity* — this break, in this
programme, on this channel — so a decision service can apply rules to it. What
plays is decided afterwards, by something else, against that key.

### The break length is a constraint, not a request

A decision service asked for ninety seconds can return sixty, and from its side
that is a reasonable outcome: it had two ads. From the video side, the hole is
ninety seconds wide regardless. Something must occupy the other thirty —
slate, black, or an early return.

The avail duration came from playout automation. It is not negotiable at
decision time, and returning less is not a smaller break, it is an emptier one.

### An empty response is a success, technically

If the decision service has nothing to serve, it answers with an empty
document. That is correct behaviour and correctly handled: the break collapses,
content resumes, no error anywhere.

It is also unsold inventory, and it is invisible. The manifest is valid, the
player is happy, the ad server logged a no-fill and moved on. Nothing pages
anybody. The only way to know is to count avails signalled against avails
filled — which requires looking at both halves at once.

---

## 3. What a stitcher cannot do

### VPAID is not "hard to stitch". It is impossible.

VPAID creatives are JavaScript. The ad is a program the player runs, which is
how interactive and expandable formats work.

Server-side insertion has no browser, no DOM and no JavaScript engine. It is
selecting media ahead of time on behalf of viewers it cannot see. A VPAID-only
response cannot be filled by a stitcher under any circumstances — and from the
manifest, that avail looks exactly like a signalling fault.

This surprises people because VPAID works fine in client-side insertion, which
was the only kind when VPAID was designed.

### "Can't you just transcode the ad?"

Yes, and it is normally done — that is what ad conditioning is. But it happens
*in advance*, in a separate pipeline, so that a creative is eligible before
anyone asks for it.

Doing it at decision time means transcoding a thirty-second file inside a
budget measured in hundreds of milliseconds. It does not fit. A creative that
was not conditioned is not a slow ad, it is an absent one.

### The ad has to fit a ladder that already exists

The stream is encoded at several renditions, and the ad is being spliced into
them. A creative in a different codec forces a decoder reset at both ends of
the break — the black frame that gets reported as "the ad broke the stream".
One encoded at 9 Mbps, spliced into a ladder topping out at 1.3, is heavier
than anything that viewer has sustained, and the rebuffer lands mid-ad.

Neither is the packager's doing, and both are usually reported to the packaging
team.

---

## 4. Measurement means different things too

### An impression is not a view, and a segment request is not an impression

**Client-side** insertion fires beacons from the device. They reflect what
actually happened — including that the player was muted, backgrounded, or
scrolled off screen. Accurate, and reachable by an ad blocker.

**Server-side** insertion fires them from the stitcher, inferring playback from
segment requests. Robust against blocking, because nothing is asked of the
device. But a segment request is not a view: the player may have fetched it and
never rendered it.

Neither is wrong. They measure different things. Comparing a client-side
campaign's numbers with a server-side one's is comparing two definitions of
"played", and the difference is not a discrepancy to be reconciled.

### Why server-side numbers look "too good"

Because blocking is not subtracting from them. That is the trade the
architecture makes, and it is the reason to expect the two to differ rather
than a reason to distrust either.

---

## 5. Why nobody notices

### Everything fails as an unfilled avail

A VPAID-only response, a creative in the wrong codec, a decision that missed
its deadline, a wrapper chain four redirects deep, an ad server that timed out
— all of them produce the same downstream symptom. The break did not fill.

In a manifest, that looks like a signalling problem. So it gets raised with the
packaging team, who spend a day proving the SCTE-35 was correct, which it was.

### The stream stays valid throughout

This is the part that is genuinely counter-intuitive from the video side. There
is no malformed manifest, no HTTP error, no decode failure. Every component
reports success. The signalling is correct, the packaging is correct, the
delivery is correct, and the revenue is missing.

Monitoring built around stream health will not catch it, because the stream is
healthy.

### The symptom appears a layer away from the cause

Which is why answering "whose fault is it" requires a view of more than one
layer at once — the signal that asked for the break, the response that was
meant to fill it, and the manifest that shows what actually happened.

**SpliceCheck:** this is the argument the whole project is built on. The
[pipeline comparison](/compare) puts the feed going into an ad service beside
the output coming out, so a break that was signalled and not filled is visible
as neither side being wrong. The [ad response](/vast) tool checks the VAST
against what a stitcher can actually splice. The
[simulator](/simulator) lets you inject a fault in one layer and watch what a
different layer reports instead.

---

## 6. A short glossary for whichever side you came from

| Term | Video means | Ad tech means |
| --- | --- | --- |
| Avail | A slot in the timeline, bracketed by cues | An inventory unit that can be sold |
| Break | The same slot, as delivered | A scheduled interruption |
| Pod | — | The group of ads inside one break |
| Spot | — | One commercial, usually 15, 30 or 60 seconds |
| Fill | Ad content occupying avail seconds | A request that returned an ad |
| Slate | A holding card or black, shown when nothing else is | Unsold inventory, eventually |
| Cue | SCTE-35 in the stream or a manifest tag | The trigger to call the ad server |
| Conditioning | Transcoding an ad to match the content ladder | Making a creative eligible |
| Stitching | Rewriting a manifest to substitute segments | Server-side insertion generally |
| Beacon | An HTTP request the stitcher makes | A tracking event that proves delivery |
| Latency | Glass to glass | Decision response time |

# Brag Plan: Rift

## What is this app?
Rift is cover for bridge failures that pays in seconds: a Reactive contract watches a bridge's escrow and the bridged token's price on two chains, and when both break it fixes every payout in one transaction. A spread perp and an underwriting pool trade the same index; an AI agent can run it inside on-chain limits.

## The angle
Every second counts, literally. Open on a real bridge failure (the 2022 Nomad exploit, rebuilt from chain data in `research/nomad-replay.json`): the bridged token crashes before anyone can sell. Then Rift, the thing that would have paid out while $71.2M was still in the escrow. Serious, cinematic, numbers-first; the product's own brutalist look carries it.

## Hook (first 2-3 seconds)
A price ticker on black: "Nomad-bridged USDC" at $0.9995, then it falls off a cliff to $0.045 as the narrator says the tokens crash in about a minute. Red hairline chart plunging, the number rolling down.

## Key moments (the middle)
- The crash card: $0.9995 → $0.045 with the real timestamps (21:32 exploit, 22:29 crash).
- The RIFT/ wordmark slams in: "Payout fixed in ~2s" (BottomBand catchphrase).
- The real Monitor/History screen: the trip's three hops light up one by one, Base origin → Lasna reaction (+0s) → Unichain settlement (+3s).
- The replay result: escrow bar draining, freezing at "22:46:36 · Rift trips", "$71.2M still in the escrow" (of $87.5M).
- Quick montage of the real Trade screen and the real Agent chat (Gemini answering with live numbers, proposal card).

## Outro / punchline
RIFT/ wordmark, "Mind the gap." (the landing page's closing line), and rift-bice.vercel.app.

## User flow worth showing
Monitor the market → a drain trips the market and payouts are fixed (Monitor/History drain-to-payout card) → act: trade the spread, or ask the agent, which proposes the cover to sign.

## Tone
- Preset: cinematic
- Creative direction: a calm, serious incident film: black ground, one red accent, big type, hard data
- Interpretation: 5 scenes, big type, measured holds; motion comes from data moving (numbers, bars, hops), not from decoration.

## Format: landscape — 1920x1080
## Duration: ~24s (narration is the clock; must stay within 25s)

## Visual identity (from the project)
- Background: #09090b (`--ink`), panels #111114 / #18181c
- Accent: #ff4433 (`--rift`); cold #8ea4ff; ok #3fb67b
- Text: #ece7dc (`--bone`), dim #a8a397
- Display font: Archivo 900 at 125% width, uppercase, -0.045em tracking (site `.display`)
- Body font: Inter; figures: JetBrains Mono
- Strongest visual element: the RIFT/ wordmark with the red slash; the red ticker band; corner-tick panels

## Share copy (draft)
When a bridge is drained, its tokens crash in a minute. Rift is cover that pays in seconds, settled by Reactive Network. Replayed on the Nomad hack, it trips with $71.2M still in the escrow.

## Audio direction
- Role: cinematic support under narration
- Music: happy-beats-business-moves-vol-12 (steady, clean, 110 BPM)
- Music treatment: ducked to ~0.14 under the voice for the whole film, short fade-out under the end card
- Music cue guidance: preset `cues/happy-beats-business-moves-vol-12-by-ende-dot-app.music-cues.json`; strong cues 8.74s, 13.11s, 17.47s, 22.93s; beat grid ~0.546s
- Audio-reactive treatment: none (the voice carries the film; keep the type dead still)
- SFX posture: sparse, motion-matched
- Audio-coupled moments: the crash (soft impact), the wordmark (bell), each hop card landing (soft drops), the trip freeze (impact), the end card (bell)
- Restraint rule: no effect under a spoken key number; no clicks/keys

## Voiceover script
1. When a bridge is drained, the tokens it minted crash in about a minute.
2. In the Nomad hack, bridged USDC fell to four cents. Too fast to sell.
3. Rift is cover that pays in seconds.
4. Reactive Network watches both chains, and fixes every payout in one transaction.
5. Replayed on Nomad, Rift trips with seventy-one million dollars still in the escrow.
6. Trade the gap, underwrite the pool, or hand it to an agent, inside limits you set.
7. Rift. Mind the gap.

(Grounding: "about a minute" = price went 0.9995 → 0.045 between two one-minute samples; "four cents" = 0.045; $71.2M = `trip.usdcStillInEscrow`; "one transaction" = the trip callback; "limits you set" = RiftAgentVault.)

## Storyboard (times flex to the generated narration)

### Scene 1 — Crash — ~5.5s (VO 1-2)
Black. Label "Nomad-bridged USDC · Moonbeam · 1 Aug 2022". Big mono price 0.9995 holding, a flat bone line; at the word "crash" the line falls and the number rolls to 0.045 in red; timestamps 21:32 exploit / 22:29 crash appear under it.
Sequential/interaction: number roll + line draw
Audio intent: tension → drop. Audio-coupled idea: soft impact on the drop.
Transition mood: dramatic → Scene 2 (dip to black, wordmark slams)

### Scene 2 — Rift — ~2.3s (VO 3)
RIFT/ wordmark large, then "Payout fixed in ~2s".
Audio-coupled idea: bell on the wordmark. Transition: whip → Scene 3

### Scene 3 — How it settles — ~4.5s (VO 4)
Real Monitor screen (drain-to-payout). Three hop cards over it light up in order: 01 Origin · Base, 02 Reaction · Lasna (+0s), 03 Settlement · Unichain (+3s); big "3s".
Sequential/interaction: hops one by one, every other beat (~1.1s apart), then hold.
Audio-coupled idea: soft drop per hop. Transition: carry across → Scene 4

### Scene 4 — The replay — ~5s (VO 5)
Escrow bar labelled "Nomad USDC escrow · $87.5M" drains in steps; at "Rift trips" it freezes: "22:46:36 UTC · Rift trips", "$71.2M still in the escrow".
Audio-coupled idea: impact at the freeze. Transition: hard cut → Scene 5

### Scene 5 — Use it — ~4.5s (VO 6)
Real Trade screen slides in, then the real Agent screen (Gemini reply + "Proposed · needs your signature" card).
Audio-coupled idea: card slide per screen. Transition: dip → Scene 6

### Scene 6 — End card — ~2.5s (VO 7)
RIFT/ + "Mind the gap." + rift-bice.vercel.app. Holds ≥2s.
Audio-coupled idea: bell, music fades.

**Music mood:** cinematic, steady. **Audio summary:** a steady low bed under a calm narrator; four soft hits mark crash, reveal, trip and the end card.

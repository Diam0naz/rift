# Hyperframes Composition Brief: Rift

## Objective
A short cinematic launch video for Rift, narrated, built around a real bridge failure.

## Output
- Composition directory: `brag-output/composition/`
- Rendered video: `brag-output/brag.mp4`
- Format: landscape — 1920x1080, 30 fps
- Duration: ~24s (narration-led, ≤ 25s)

## Source Material
- Project root: `/home/user/Documents/Solidity_projects/rift`
- Primary files read: `README.md`, `frontend/app/landing.css`, `frontend/app/fonts.ts`, `frontend/components/BottomBand.tsx`, `frontend/components/landing/Landing.tsx`, `research/nomad-replay.json`
- Product name: Rift
- Strongest claim: Replayed on the Nomad exploit, Rift trips with $71.2M of the $87.5M USDC escrow still in place.
- Key UI to show: the real Monitor and History drain-to-payout screens, the Trade screen, the Agent chat (screenshots from the running app, `assets/screens/`).
- Copy that must appear verbatim:
  - "Payout fixed in ~2s" (BottomBand catchphrase)
  - "Mind the gap." (landing closing line)
  - "22:46:36", "$71.2M", "$87.5M", "0.9995", "0.045" (from `research/nomad-replay.json`)

## Creative Direction
- Tone preset: cinematic
- Creative direction: calm, serious incident film on black with one red accent
- Interpretation: big still type, data that moves; few, deliberate transitions
- Angle, hook, outro: see `brag-plan.md`
- Avoid: generic SaaS language, abstract filler, any visual not from the product

## Visual Identity
- Background: #09090b; panels #111114, #18181c; lines rgba(236,231,220,0.12/0.28)
- Text: #ece7dc; dim #a8a397
- Accent: #ff4433; cold #8ea4ff; ok #3fb67b
- Display font: Archivo 900, 125% width (`assets/fonts/archivo-wide-900.woff2`, from Google Fonts)
- Body font: Inter (bundled); figures: JetBrains Mono (bundled)
- Visual references: RIFT/ wordmark (`assets/logo-dark.png` / live type), corner-tick panels, red ticker band

## Storyboard
Use the storyboard in `brag-plan.md` as the creative contract. Scenes: Crash, Rift, How it settles, The replay, Use it, End card.

## Audio
- Audio role: cinematic support under narration
- Music: `assets/music/happy-beats-business-moves-vol-12-by-ende-dot-app.mp3` at ~0.14 under the voice, fade-out under the end card
- Music cue guidance: bundled preset (110 BPM; strong cues 8.74, 13.11, 17.47, 22.93s) — optional hints only; the narration is the clock
- Audio-reactive treatment: none (stillness reads as confidence; the voice leads)
- Voice: Kokoro `af_heart`, one clip per line on its own lane
- SFX: `impactSoft_medium_001/003`, `impactBell_heavy_004`, `drop_001/002`, `card-slide-1` — sparse, peaks one frame after the picture

## Hyperframes Instructions
Native HyperFrames conventions; `check` is the gate. Keep creation and rendering local.

# Fluoddity DJ

A live visual instrument built on [Fluoddity](https://github.com/aphid91/Fluoddity), aphid91's physarum-style particle system. Up to 900k particles follow each other's trails, each tribe steered by its own small Fourier "rule". The music drives the **physics itself**, not an overlay:

| What the music does | What happens in the fluid |
|---|---|
| **Kick** | Surge in steering force, a shockwave ring refracting across the image, and a ripple of flow written into the trail field (particles react to it through their own rule) |
| **Snare / clap** | Handedness twist (lateral force), a vortex that flips direction every bar, chromatic split |
| **Hi-hats** | Strafe shimmer: particles sidle sideways |
| **Bass** | Particles swell |
| **Spectrum** | Drawn live as a ring of orbiting flow that the tribes braid around |
| **Timbre brightness** | Opens and closes the sensor angle, which changes the shape of structures |
| **Loudness / intensity** | Speeds time up and down |
| **Build-up** | Tribes diversify (mutation rises), and structures destabilize as tension builds |
| **Breakdown** | Trails grow long, video echo appears, everything slows and glides |
| **Drop** | 40% of particles are reborn from the preset's seed pattern, flash, hard cut to the next preset |
| **Harmony** | The palette rotates around the circle of fifths as the key moves |
| **Phrases** | Every 16 bars the autopilot crossfades to another preset, morphing *through rule space* |

Physics modulation is **centred** on each feature's running mean. Each preset's average physics stays exactly what its author tuned, and the music makes it surge and relax around that natural state instead of dragging it somewhere else.

## Run it

```bash
npm start          # or: node serve.mjs   (zero dependencies)
```

Open http://localhost:5173 in **Chrome** (or Edge / Arc). Everything runs locally in the browser; a WebGL2 GPU is required. It hits 60 fps with 600k particles on an Apple M2.

> The original Fluoddity needs OpenGL 4.3 compute shaders, which macOS doesn't have. This is a WebGL2 port of the engine, so it runs on Macs, laptops and projector rigs.

### Audio sources

- **Tab / system audio**: pick a tab playing Spotify Web, YouTube, SoundCloud, Mixcloud… and tick **Share tab audio**.
- **Line in / mic**: DJ mixer booth out, audio interface, or a loopback like [BlackHole](https://github.com/ExistentialAudio/BlackHole) to capture the Spotify/Rekordbox/Serato desktop apps. Echo cancellation, noise suppression and AGC are disabled.
- **Files**: click or drag tracks onto the page for a playlist that auto-advances.
- **Demo**: a procedural 126 BPM techno track with intro, groove, breakdown, build and drop, for trying it out.

## Performing

- **Decks A/B + crossfader.** Clicking a preset mixes it in on the off-deck, beat-synced (1–32 beats). Shift-click cuts. During a crossfade every tribe's rule coefficients are interpolated, so the fluid passes through behaviours neither preset has.
- **Autopilot** mixes on phrase boundaries, cuts on detected drops, can **evolve** (adopt a mutated descendant of a random particle every N bars), and draws from a crate: Starter, ★ Favorites, Core, Advanced or all 131 presets.
- **Click a particle** to adopt its lineage (Fluoddity's selection mechanic). Right-click undoes.
- **Reactor.** Every target has a base, a source and a depth. There are profiles (Pulse, Liquid, Storm, Minimal) plus a master Reactivity control and an onset Sensitivity control.
- **Look**: palettes, colour by tribe / heading / speed, kaleidoscope, exposure.
- **Projector** opens a clean output window; drag it to the second screen and double-click for fullscreen. It keeps running if the controls window is hidden.
- **Rec** records video + audio to MP4/WebM.
- **MIDI learn** maps any knob, fader or pad on a controller to any control.

| Key | | Key | |
|---|---|---|---|
| `H` | hide UI | `D` | drop (rebirth + shock + flash) |
| `F` | fullscreen | `N` / `⇧N` | next preset (mix / cut) |
| `Space` | freeze | `E` | evolve |
| `T` | tap tempo | `A` | autopilot on/off |
| `Y` | set downbeat | `1–9` | favourite presets |
| `K` | kaleidoscope | `C` | palette |
| `B` | blackout | `← →` | nudge crossfader |
| `M` | mouse: select ↔ draw flow | `R` | reset simulation |

Wheel zooms, Alt-drag pans, double-click resets the camera.

## How it works

```
audio ─▶ AudioWorklet (FFT 2048 / hop 512: bands, spectral flux, chroma, centroid, flatness)
      ─▶ MusicBrain  (adaptive-gain levels, kick/snare/hat onsets, autocorrelation tempo + PLL beat clock,
                      downbeats, phrases, build / breakdown / drop detection, key on the circle of fifths)
      ─▶ Director    (autopilot: what to play next and when)
      ─▶ Mixer       (two decks, beat-synced crossfade through rule space)
      ─▶ Reactor     (modulation matrix → physics params, flow ink, FX)
      ─▶ Engine      (WebGL2 GPGPU)
```

Per physics step, **sim** (particles sense the trail field and apply their tribe's rule) → **brush** (particles stamp their velocity as points) → **canvas** (diffuse, decay, add music ink). Then particles, flow glow, echo, bloom and the final composite.

The GPU work is shaped around Apple's tile-based GPUs:

- **Per-tribe rule textures.** Each tribe's mutated rule is computed on the CPU (a bit-exact port of the GLSL hash) and uploaded as a texture, so there's no per-particle hashing.
- **Asynchronous spatial sorting.** Particles are periodically re-ordered by screen tile: key pass, PBO readback, worker counting sort, GPU gather. Stamping 600k points in raster order is about 4× faster than in random order. Particle identity lives in a texture channel, so tribes survive reordering.
- **Stochastic trail stamping.** When trails are long-lived, each step stamps an interleaved subset of particles at proportionally higher weight. The expected trail field is the same, for less work.

## Files

```
index.html, styles.css      UI shell
src/main.js                 orchestrator (frame loop, input, persistence)
src/engine.js, shaders.js   GPU simulation + rendering
src/rule.js                 bit-exact rule/mutation port (click-to-adopt, per-tribe rules)
src/decks.js                preset library, mixer, autopilot director
src/reactor.js              modulation matrix + FX
src/audio/                  worklet analysis, music brain, audio sources, demo track
src/midi.js, output.js      MIDI learn, projector window, recording
presets/presets.json        the 131 original Fluoddity configs (Core + Advanced)
scripts/build-presets.mjs   regenerates presets.json from a Fluoddity checkout
```

## Credits

The physics model, presets and rule mutation scheme are from [Fluoddity](https://github.com/aphid91/Fluoddity) and [Fluoddity-Core](https://github.com/aphid91/Fluoddity-Core) by aphid91 (MIT, see `LICENSE-FLUODDITY`). They build on Sage Jenson's [physarum](https://cargocollective.com/sagejenson/physarum) work.

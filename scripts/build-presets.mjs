// Bundles the original Fluoddity physics configs into a single compact JSON
// file so the DJ tool can hot-swap presets without any network latency.
//
//   node scripts/build-presets.mjs
//
// Source: reference/upstream/physics_configs/{Core,Advanced}/*.json
// (clone https://github.com/aphid91/Fluoddity into reference/upstream first)

import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'reference/upstream/physics_configs');
if (!existsSync(src)) {
    console.error(`Missing ${src}. Run: git clone --depth 1 https://github.com/aphid91/Fluoddity.git reference/upstream`);
    process.exit(1);
}

const r4 = (x) => Math.round(x * 1e6) / 1e6;
const out = [];
for (const category of ['Core', 'Advanced']) {
    const dir = join(src, category);
    const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort((a, b) => a.localeCompare(b));
    for (const f of files) {
        const d = JSON.parse(readFileSync(join(dir, f), 'utf8'));
        const p = d.physics, s = d.settings, a = d.appearance || {};
        out.push({
            name: basename(f, '.json').replace(/^_/, ''),
            category,
            // Older configs predate trail_diffusion/hazard_rate; use the upstream defaults.
            physics: { trail_diffusion: 1.0, hazard_rate: 0.0, ...Object.fromEntries(Object.entries(p).map(([k, v]) => [k, r4(v)])) },
            cohorts: s.num_cohorts,
            rule_seed: s.rule_seed,
            initial_conditions: s.initial_conditions ?? 0,
            boundary: s.boundary_conditions ?? 2,
            absolute_orientation: s.absolute_orientation ?? 0,
            orientation_mix: r4(s.orientation_mix ?? 1),
            disable_symmetry: !!s.disable_symmetry,
            color_by_cohort: a.color_by_cohort ?? true,
            hue_sensitivity: r4(a.hue_sensitivity ?? 0.5),
            ink_weight: r4(a.ink_weight ?? 1),
            rule: d.rule.map((v) => Math.fround(v)),
        });
    }
}
writeFileSync(join(root, 'presets/presets.json'), JSON.stringify(out));
console.log(`Wrote ${out.length} presets to presets/presets.json`);

// SPDX-License-Identifier: GPL-2.0-or-later

/* presets.js
 *
 * Single source of truth for the DSP. Imported by both the shell process and
 * the preferences window, so the numbers can never drift apart.
 *
 * The signal chain is:
 *
 *     apps -> [ pre-gain ] -> [ SC4 compressor ] -> [ presence EQ ]
 *                             -> [ limiter ] -> [ post-gain ] -> device
 *
 * The gain pair either side undoes and reapplies the sink volume, which
 * PipeWire applies ahead of the graph; see volumeToLinear in engine.js.
 *
 * SC4 does the heavy lifting: it pulls loud material down towards the
 * threshold and its makeup gain lifts everything back up, which is what
 * closes the gap between whispered dialogue and an explosion. The limiter is
 * the safety net, a hard ceiling that transients cannot cross.
 *
 * The `measured` figures come from rendering a calibrated test scene through
 * these exact settings; the preferences window shows them. README.md has the
 * method.
 */

/** Where distributions put LADSPA plugins. Searched in order. */
export const LADSPA_SEARCH_PATHS = [
    '/usr/lib64/ladspa',                  // Fedora / RHEL / openSUSE (x86_64)
    '/usr/lib/ladspa',                    // Debian / Ubuntu, and generic
    '/usr/lib/x86_64-linux-gnu/ladspa',   // Debian multiarch
    '/usr/lib/aarch64-linux-gnu/ladspa',  // Debian multiarch, arm64
    '/usr/local/lib/ladspa',              // manual builds
    '/usr/local/lib64/ladspa',
];

/** The two plugins we need, both from swh-plugins. */
export const REQUIRED_PLUGINS = {
    compressor: {file: 'sc4_1882.so', label: 'sc4'},
    limiter: {file: 'fast_lookahead_limiter_1913.so', label: 'fastLookaheadLimiter'},
};

/**
 * How to install swh-plugins, keyed by the ID/ID_LIKE field of os-release.
 * We only ever *show* these. Running a package manager on the user's behalf
 * from a shell extension is not something an extension should be doing.
 */
export const INSTALL_COMMANDS = [
    {
        ids: ['fedora', 'rhel', 'centos'],
        package: 'ladspa-swh-plugins',
        display: 'sudo dnf install ladspa-swh-plugins',
    },
    {
        ids: ['debian', 'ubuntu'],
        package: 'swh-plugins',
        display: 'sudo apt install swh-plugins',
    },
    {
        ids: ['arch'],
        package: 'swh-plugins',
        display: 'sudo pacman -S swh-plugins',
    },
    {
        ids: ['opensuse', 'suse', 'opensuse-tumbleweed', 'opensuse-leap'],
        package: 'ladspa-swh-plugins',
        display: 'sudo zypper install ladspa-swh-plugins',
    },
];

/**
 * Preset parameters.
 *
 *   rmsPeak   0 follows average level, 1 follows peaks. A little peak
 *             sensitivity catches gunshots without making everything pump.
 *   attack    ms. Faster catches transients; too fast dulls impact.
 *   release   ms. Too fast pumps, too slow leaves audio ducked after a bang.
 *   threshold dBFS. SC4 bottoms out at -30.
 *   ratio     n:1 above the threshold.
 *   knee      dB. Softens the transition into compression.
 *   makeup    dB. Lifts the whole signal back up, which is what makes quiet
 *             dialogue audible.
 *   ceiling   dBFS. Hard limiter output ceiling; nothing crosses it.
 */
export const PRESETS = {
    gentle: {
        id: 'gentle',
        name: 'Gentle',
        blurb: 'Light touch. Keeps most of the dynamics.',
        detail: 'Barely noticeable on music. Takes the edge off loud moments without flattening the mix.',
        rmsPeak: 0.20, attack: 15, release: 400,
        threshold: -14, ratio: 2, knee: 3, makeup: 5, ceiling: -1.0,
        measured: {gap: 11.3, dialogueLift: 4.9},
    },
    movie: {
        id: 'movie',
        name: 'Movie Night',
        blurb: 'Balanced. Explosions still land, just softer.',
        detail: 'The everyday choice. Dialogue comes up around 10 dB and the loud-to-quiet gap roughly halves, so action still has weight.',
        rmsPeak: 0.25, attack: 10, release: 250,
        threshold: -18, ratio: 4, knee: 3, makeup: 10, ceiling: -1.5,
        measured: {gap: 6.2, dialogueLift: 9.9},
    },
    late: {
        id: 'late',
        name: 'Late Night',
        blurb: 'Heavy. Everything sits at about one level.',
        detail: 'For very quiet listening or thin walls. Strongly flattened — dialogue is easy to follow at low volume, but impact is largely gone.',
        rmsPeak: 0.35, attack: 6, release: 180,
        threshold: -22, ratio: 4, knee: 3, makeup: 12, ceiling: -2.0,
        measured: {gap: 3.8, dialogueLift: 12.6},
    },
};

export const PRESET_ORDER = ['gentle', 'movie', 'late'];
export const DEFAULT_PRESET = 'movie';

/** Parameter bounds, taken from the plugins themselves via analyseplugin. */
export const LIMITS = {
    rmsPeak: {min: 0, max: 1, step: 0.05},
    attack: {min: 1.5, max: 400, step: 0.5},
    release: {min: 2, max: 800, step: 5},
    threshold: {min: -30, max: 0, step: 0.5},
    ratio: {min: 1, max: 20, step: 0.5},
    knee: {min: 1, max: 10, step: 0.25},
    makeup: {min: 0, max: 24, step: 0.5},
    ceiling: {min: -20, max: 0, step: 0.5},
    dialogueBoost: {min: 0, max: 9, step: 0.5},
};

/**
 * Minimal %s / %d substitution.
 *
 * String.prototype.format is a GNOME Shell environment extension and does not
 * exist in the preferences process, so anything shared between the two has to
 * bring its own. Placeholders are kept rather than switching to template
 * literals so xgettext can still extract the strings for translators.
 */
export function format(template, ...args) {
    let i = 0;
    return String(template).replace(/%[sd]/g, () => String(args[i++]));
}

/** Clamp a value into its documented range so we never hand a plugin garbage. */
export function clampParam(key, value) {
    const l = LIMITS[key];
    if (!l || !Number.isFinite(value))
        return value;
    return Math.min(l.max, Math.max(l.min, value));
}

/**
 * Resolve the effective parameters for the current settings, applying the
 * custom overrides when the user has switched a preset into custom mode.
 */
export function resolveParams(settings) {
    const id = settings.get_string('preset');
    const base = PRESETS[id] ?? PRESETS[DEFAULT_PRESET];

    if (!settings.get_boolean('use-custom'))
        return {...base};

    return {
        ...base,
        id: 'custom',
        name: 'Custom',
        rmsPeak: clampParam('rmsPeak', settings.get_double('custom-rms-peak')),
        attack: clampParam('attack', settings.get_double('custom-attack')),
        release: clampParam('release', settings.get_double('custom-release')),
        threshold: clampParam('threshold', settings.get_double('custom-threshold')),
        ratio: clampParam('ratio', settings.get_double('custom-ratio')),
        knee: clampParam('knee', settings.get_double('custom-knee')),
        makeup: clampParam('makeup', settings.get_double('custom-makeup')),
        ceiling: clampParam('ceiling', settings.get_double('custom-ceiling')),
    };
}

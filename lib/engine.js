// SPDX-License-Identifier: GPL-2.0-or-later

/* engine.js
 *
 * Owns the PipeWire filter chain: builds its config, runs it, routes audio
 * through it, and puts everything back exactly as it was on the way out.
 *
 * The chain runs as a `pipewire -c <conf>` client process rather than a module
 * loaded into the daemon. That matters for a desktop extension: the whole
 * thing is one child process we own, so tearing it down is a single kill and
 * there is no daemon-side state that can survive us and leak.
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import {
    LADSPA_SEARCH_PATHS, REQUIRED_PLUGINS, INSTALL_COMMANDS,
} from './presets.js';

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');
Gio._promisify(Gio.Subprocess.prototype, 'wait_check_async');

/** Node names inside PipeWire. The capture node is the sink apps play into. */
export const SINK_NAME = 'night_owl_sink';
export const OUTPUT_NAME = 'night_owl_output';
export const SINK_DESCRIPTION = 'Night Owl';

/** How long to wait for the virtual sink to show up before giving up. */
const SINK_WAIT_TIMEOUT_MS = 6000;
const SINK_POLL_INTERVAL_MS = 120;

/** Volume-change settling time before the gain stages are retuned. */
const VOLUME_RETUNE_DELAY_MS = 600;
/** Level drift that justifies a rebuild when live retuning fails (~3 dB). */
const RECALIBRATE_RATIO = 1.41;

/**
 * PipeWire clamps the builtin linear plugin's Mult control to 10, so the
 * pre-gain is spread over two cascaded stages. Compensation stops at 32x,
 * which covers sink volumes down to about a third.
 */
const PRE_STAGES = 2;
const PRE_GAIN_MAX = 32;

/** PulseAudio's "no card" marker, which Gvc hands through unchanged. */
const PA_INVALID_INDEX = 0xFFFFFFFF;

export const State = {
    INACTIVE: 'inactive',
    STARTING: 'starting',
    ACTIVE: 'active',
    STOPPING: 'stopping',
    FAILED: 'failed',
};

/* ------------------------------------------------------------------ *
 * Dependency discovery
 * ------------------------------------------------------------------ */

/**
 * Look for the LADSPA plugins we need. Honours LADSPA_PATH first, the way
 * every other LADSPA host does, then falls back to the usual distro paths.
 *
 * @returns {{ok: boolean, paths: object, missing: string[]}}
 */
export function detectPlugins() {
    const dirs = [];

    const envPath = GLib.getenv('LADSPA_PATH');
    if (envPath)
        dirs.push(...envPath.split(':').filter(p => p.length > 0));
    dirs.push(...LADSPA_SEARCH_PATHS);

    const paths = {};
    const missing = [];

    for (const [key, plugin] of Object.entries(REQUIRED_PLUGINS)) {
        let found = null;
        for (const dir of dirs) {
            const candidate = GLib.build_filenamev([dir, plugin.file]);
            if (GLib.file_test(candidate, GLib.FileTest.EXISTS)) {
                found = candidate;
                break;
            }
        }
        if (found)
            paths[key] = found;
        else
            missing.push(plugin.file);
    }

    return {ok: missing.length === 0, paths, missing};
}

/**
 * Work out how this machine installs packages, so we can show a command that
 * will actually work rather than a generic "install swh-plugins".
 */
export function detectInstallCommand() {
    const fallback = {
        package: 'swh-plugins',
        display: 'Install the "swh-plugins" LADSPA package',
    };

    let contents;
    try {
        const [ok, bytes] = GLib.file_get_contents('/etc/os-release');
        if (!ok)
            return fallback;
        contents = new TextDecoder().decode(bytes);
    } catch {
        return fallback;
    }

    const ids = [];
    for (const line of contents.split('\n')) {
        const m = line.match(/^(ID|ID_LIKE)=(.*)$/);
        if (m)
            ids.push(...m[2].replace(/["']/g, '').trim().split(/\s+/));
    }

    for (const entry of INSTALL_COMMANDS) {
        if (ids.some(id => entry.ids.includes(id))) {
            return {package: entry.package, display: entry.display};
        }
    }
    return fallback;
}

/* ------------------------------------------------------------------ *
 * Config generation
 * ------------------------------------------------------------------ */

/**
 * The sink's volume as a linear gain factor, on PulseAudio's cubic curve.
 *
 * PipeWire applies a sink's volume before the filter graph, so at a modest
 * slider position the compressor sees a signal far below its threshold and
 * quietly does nothing. buildConfig() undoes this with a matched pre/post
 * gain pair.
 */
export function volumeToLinear(volume, maxNorm) {
    if (!(volume > 0) || !(maxNorm > 0))
        return 1;
    const ratio = Math.min(1, volume / maxNorm);
    return ratio ** 3;
}

/**
 * Multipliers for the gain stages either side of the graph, given the linear
 * gain the sink volume applies ahead of it. The pre-gain is split evenly over
 * PRE_STAGES, keeping each stage within the linear plugin's range.
 */
export function padGains(volumeScale) {
    const preMult = 1 / Math.max(1 / PRE_GAIN_MAX, Math.min(1, volumeScale));
    return {stage: preMult ** (1 / PRE_STAGES), post: 1 / preMult};
}

function preStageNames(side) {
    return Array.from({length: PRE_STAGES}, (_, i) => `pre_${side}${i + 1}`);
}

/** The pw-cli Props payload that retunes a running chain's gain stages. */
export function padParams(volumeScale) {
    const {stage, post} = padGains(volumeScale);
    const f = value => Number(value).toFixed(6);
    const entries = [];
    for (const side of ['l', 'r']) {
        for (const name of preStageNames(side))
            entries.push(`"${name}:Mult" ${f(stage)}`);
        entries.push(`"post_${side}:Mult" ${f(post)}`);
    }
    return `{ params = [ ${entries.join(' ')} ] }`;
}

/** SPA-JSON string escaping. Device names are tame, but never assume. */
function q(str) {
    return `"${String(str).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function n(value, digits = 4) {
    return Number(value).toFixed(digits).replace(/\.?0+$/, '') || '0';
}

/**
 * Build the filter-chain config.
 *
 * With the presence EQ enabled the graph forks into two mono bands (the
 * builtin biquad is mono, SC4 is stereo) and rejoins at the limiter. The
 * gain stages are always present, even at unity, so _retune() can adjust
 * them in place when the volume moves.
 *
 * @param {object} opts
 * @param {object} opts.params      resolved preset parameters
 * @param {object} opts.pluginPaths from detectPlugins()
 * @param {string} opts.targetSink  PipeWire node name of the real device
 * @param {number} opts.boostGain   presence lift in dB; 0 disables the EQ
 * @param {number} opts.boostFreq   centre frequency of the presence lift
 * @param {number} [opts.volumeScale] linear gain the sink volume applies
 *                                    ahead of the graph
 */
export function buildConfig({
    params, pluginPaths, targetSink, boostGain, boostFreq, volumeScale = 1,
}) {
    const useEq = boostGain > 0;

    // Undo the sink volume on the way in and reapply it on the way out. The
    // two exactly cancel, so output still tracks the volume slider, but the
    // compressor always sees the signal at the level its threshold assumes.
    // Without this the night mode fades out as you turn the volume down.
    const {stage, post} = padGains(volumeScale);

    const gainNode = (name, mult) => `
                    {
                        type  = builtin
                        name  = ${name}
                        label = linear
                        control = { "Mult" = ${n(mult, 6)} "Add" = 0.0 }
                    }`;
    const link = (output, input) => `
                    { output = ${q(output)} input = ${q(input)} }`;
    // Link mono nodes head to tail, with the last one feeding `into`.
    const cascade = (names, into) => names.map((name, i) =>
        link(`${name}:Out`, i + 1 < names.length ? `${names[i + 1]}:In` : into)).join('');

    const padNodes =
        [...preStageNames('l'), ...preStageNames('r')]
            .map(name => gainNode(name, stage)).join('') +
        gainNode('post_l', post) + gainNode('post_r', post);

    const eqNodes = useEq ? `
                    {
                        type  = builtin
                        name  = eq_l
                        label = bq_peaking
                        control = { "Freq" = ${n(boostFreq)} "Q" = 0.8 "Gain" = ${n(boostGain)} }
                    }
                    {
                        type  = builtin
                        name  = eq_r
                        label = bq_peaking
                        control = { "Freq" = ${n(boostFreq)} "Q" = 0.8 "Gain" = ${n(boostGain)} }
                    }` : '';

    // compressor -> (eq) -> limiter
    const midLinks = useEq
        ? link('comp:Left output', 'eq_l:In') +
          link('comp:Right output', 'eq_r:In') +
          link('eq_l:Out', 'lim:Input 1') +
          link('eq_r:Out', 'lim:Input 2')
        : link('comp:Left output', 'lim:Input 1') +
          link('comp:Right output', 'lim:Input 2');

    const padLinks =
        cascade(preStageNames('l'), 'comp:Left input') +
        cascade(preStageNames('r'), 'comp:Right input') +
        link('lim:Output 1', 'post_l:In') +
        link('lim:Output 2', 'post_r:In');

    const links = midLinks + padLinks;

    const graphInputs = `[ ${q(`${preStageNames('l')[0]}:In`)} ` +
        `${q(`${preStageNames('r')[0]}:In`)} ]`;
    const graphOutputs = '[ "post_l:Out" "post_r:Out" ]';

    // target.object pins the output side to the real hardware. Without it the
    // chain would follow the default sink, which is ourselves: a feedback loop.
    const targetLine = targetSink ? `\n                target.object = ${q(targetSink)}` : '';

    return `# Generated by the Night Owl GNOME Shell extension. Do not edit.
context.properties = {
    log.level = 1
}

context.spa-libs = {
    audio.convert.* = audioconvert/libspa-audioconvert
    support.*       = support/libspa-support
}

context.modules = [
    { name = libpipewire-module-rt
        args = { }
        flags = [ ifexists nofail ]
    }
    { name = libpipewire-module-protocol-native }
    { name = libpipewire-module-client-node }
    { name = libpipewire-module-adapter }

    { name = libpipewire-module-filter-chain
        args = {
            node.description = ${q(SINK_DESCRIPTION)}
            media.name       = ${q(SINK_DESCRIPTION)}
            filter.graph = {
                nodes = [
                    {
                        type   = ladspa
                        name   = comp
                        plugin = ${q(pluginPaths.compressor)}
                        label  = sc4
                        control = {
                            "RMS/peak"             = ${n(params.rmsPeak)}
                            "Attack time (ms)"     = ${n(params.attack)}
                            "Release time (ms)"    = ${n(params.release)}
                            "Threshold level (dB)" = ${n(params.threshold)}
                            "Ratio (1:n)"          = ${n(params.ratio)}
                            "Knee radius (dB)"     = ${n(params.knee)}
                            "Makeup gain (dB)"     = ${n(params.makeup)}
                        }
                    }${eqNodes}${padNodes}
                    {
                        type   = ladspa
                        name   = lim
                        plugin = ${q(pluginPaths.limiter)}
                        label  = fastLookaheadLimiter
                        control = {
                            "Input gain (dB)"  = 0
                            "Limit (dB)"       = ${n(params.ceiling)}
                            "Release time (s)" = 0.3
                        }
                    }
                ]
                links = [${links}
                ]
                inputs  = ${graphInputs}
                outputs = ${graphOutputs}
            }
            audio.channels = 2
            audio.position = [ FL FR ]
            capture.props = {
                node.name        = ${q(SINK_NAME)}
                node.description = ${q(SINK_DESCRIPTION)}
                media.class      = Audio/Sink
                node.virtual     = true
            }
            playback.props = {
                node.name    = ${q(OUTPUT_NAME)}
                node.passive = true${targetLine}
            }
        }
    }
]
`;
}

/* ------------------------------------------------------------------ *
 * Engine
 * ------------------------------------------------------------------ */

export const NightOwlEngine = GObject.registerClass({
    Signals: {
        'state-changed': {param_types: [GObject.TYPE_STRING]},
        'failed': {param_types: [GObject.TYPE_STRING]},
        'recalibrate': {},
    },
}, class NightOwlEngine extends GObject.Object {
    constructor(settings, mixer) {
        super();
        this._settings = settings;
        this._mixer = mixer;
        this._state = State.INACTIVE;

        this._proc = null;
        this._confPath = null;
        this._pollId = 0;
        this._cancellable = null;

        // What we changed and must put back.
        this._restore = null;
        this._targetName = null;
        this._targetIdentity = null;
        this._calibratedFor = 0;
        this._volumeSignalId = 0;
        this._volumeDebounceId = 0;
        this._volumeWatchSink = null;
        this._pollResolve = null;
    }

    get state() {
        return this._state;
    }

    get active() {
        return this._state === State.ACTIVE || this._state === State.STARTING;
    }

    /** PipeWire node name of the hardware device we are currently feeding. */
    get targetName() {
        return this._targetName;
    }

    _setState(state) {
        if (this._state === state)
            return;
        this._state = state;
        this.emit('state-changed', state);
    }

    _fail(message) {
        console.error(`[night-owl] ${message}`);
        this._setState(State.FAILED);
        this.emit('failed', message);
    }

    /* -------------------------------------------------------------- *
     * Mixer helpers
     * -------------------------------------------------------------- */

    _findSinkByName(name) {
        for (const sink of this._mixer.get_sinks()) {
            if (sink.get_name() === name)
                return sink;
        }
        return null;
    }

    _realSinks() {
        return this._mixer.get_sinks().filter(s => s.get_name() !== SINK_NAME);
    }

    /**
     * Capture enough to find this device again later. Sink names are not
     * stable: an HDMI sink's name changes with its card profile, which is
     * reselected on its own when a display sleeps. The sysfs path identifies
     * the physical card and survives that, and losing the device would leave
     * its hardware volume stranded at unity.
     */
    _identify(stream) {
        return {
            name: stream.get_name(),
            sysfsPath: stream.get_sysfs_path(),
            cardIndex: this._cardIndex(stream),
            description: stream.get_description(),
        };
    }

    /** Card index, or null for a stream with no card such as a virtual sink. */
    _cardIndex(stream) {
        const index = stream.get_card_index();
        return index >= 0 && index < PA_INVALID_INDEX ? index : null;
    }

    /** Resolve a remembered identity back to a live stream, most exact first. */
    _findDevice(identity) {
        if (!identity)
            return null;
        const sinks = this._realSinks();

        let match = sinks.find(s => s.get_name() === identity.name);
        if (match)
            return match;

        if (identity.sysfsPath) {
            match = sinks.find(s => s.get_sysfs_path() === identity.sysfsPath);
            if (match)
                return match;
        }

        if (Number.isInteger(identity.cardIndex)) {
            match = sinks.find(s => this._cardIndex(s) === identity.cardIndex);
            if (match)
                return match;
        }

        return null;
    }

    /** The real hardware sink we should be feeding right now. */
    _resolveTargetSink() {
        const def = this._mixer.get_default_sink();
        if (def && def.get_name() !== SINK_NAME)
            return def;

        // Our own sink is the default, or there is none: fall back to the
        // real device we were already feeding, or the one a previous run
        // recorded before it died.
        const remembered = this._findDevice(this._targetIdentity) ??
            this._findDevice(this._readRestoreFile()?.device);
        if (remembered)
            return remembered;

        return this._realSinks()[0] ?? null;
    }

    /* -------------------------------------------------------------- *
     * Lifecycle
     * -------------------------------------------------------------- */

    async start(params, options) {
        if (this.active)
            return true;

        const plugins = detectPlugins();
        if (!plugins.ok) {
            this._fail(`Missing LADSPA plugins: ${plugins.missing.join(', ')}`);
            return false;
        }

        const target = this._resolveTargetSink();
        if (!target) {
            this._fail('No audio output device available.');
            return false;
        }

        this._setState(State.STARTING);
        this._targetIdentity = this._identify(target);
        this._targetName = this._targetIdentity.name;
        this._cancellable = new Gio.Cancellable();

        // A previous shell instance may have left a chain running, or died
        // between raising the hardware to unity and putting it back.
        await this._reapStaleProcess();
        if (this._abandoned())
            return false;
        this._applyOrphanedRestore();

        // Our sink inherits the device's volume in _routeThrough(), and that
        // volume lands ahead of the filter graph. Tell the graph what to undo.
        this._calibratedFor = target.volume;
        const volumeScale = volumeToLinear(
            target.volume, this._mixer.get_vol_max_norm());

        const config = buildConfig({
            params,
            volumeScale,
            pluginPaths: plugins.paths,
            targetSink: this._targetName,
            boostGain: options.boostGain,
            boostFreq: options.boostFreq,
        });

        if (!this._writeConfig(config)) {
            this._fail('Could not write the filter-chain configuration.');
            return false;
        }

        try {
            this._proc = Gio.Subprocess.new(
                ['pipewire', '-c', this._confPath],
                Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_PIPE);
        } catch (e) {
            this._fail(`Could not start the audio filter: ${e.message}`);
            this._cleanupConfig();
            return false;
        }

        this._writePidFile();
        this._watchProcess();

        const sink = await this._waitForSink();

        // stop() or stopSync() may have run while we were waiting. Do not
        // seize the default sink or raise the hardware after being told to
        // quit, since nothing would be left to undo either.
        if (this._abandoned()) {
            this._killProcess();
            this._clearPidFile();
            this._cleanupConfig();
            return false;
        }

        if (!sink) {
            this._fail('The audio filter did not start. Is PipeWire running?');
            await this.stop({restoreRouting: false});
            return false;
        }

        this._routeThrough(sink, target);
        this._setState(State.ACTIVE);
        return true;
    }

    /**
     * True if this start() has been superseded or torn down mid-flight.
     *
     * start() suspends twice, and disable() is synchronous, so by the time we
     * resume the extension may already be gone.
     */
    _abandoned() {
        return this._cancellable === null ||
               this._cancellable.is_cancelled() ||
               this._state !== State.STARTING;
    }

    _killProcess() {
        if (!this._proc)
            return;
        const proc = this._proc;
        this._proc = null;
        try {
            proc.force_exit();
        } catch {
            // already gone
        }
    }

    /**
     * Move the session onto our sink, carrying the user's volume across so the
     * level does not jump. The hardware goes to unity and our sink inherits
     * its volume, so the slider keeps its full range and the gain multiplies
     * out unchanged. Unity on the hardware is safe only because the limiter
     * guarantees a ceiling below full scale.
     */
    _routeThrough(sink, target) {
        const maxNorm = this._mixer.get_vol_max_norm();

        this._restore = {
            device: this._identify(target),
            hwVolume: target.volume,
            hwMuted: target.is_muted,
        };
        // Persist before touching anything, so a crash between here and stop()
        // is still recoverable on next start.
        this._writeRestoreFile();

        try {
            sink.volume = target.volume;
            sink.change_is_muted(target.is_muted);
            sink.push_volume();

            target.volume = maxNorm;
            target.push_volume();
        } catch (e) {
            console.warn(`[night-owl] volume hand-off failed: ${e.message}`);
        }

        this._setDefaultSink(SINK_NAME);
        this._watchSinkVolume(sink);
    }

    /**
     * The gain pair is set for the volume at build time, so a later change
     * leaves the compressor working harder or softer than intended while
     * output loudness stays correct. Once the volume settles the stages are
     * retuned in place, which players never notice. Only when that fails
     * does the chain fall back to a rebuild, and only for drift big enough
     * to matter, because a rebuild interrupts playback.
     */
    _watchSinkVolume(sink) {
        this._clearVolumeWatch();
        this._volumeWatchSink = sink;
        this._volumeSignalId = sink.connect('notify::volume', () => {
            if (this._volumeDebounceId)
                GLib.Source.remove(this._volumeDebounceId);
            this._volumeDebounceId = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT, VOLUME_RETUNE_DELAY_MS, () => {
                    this._volumeDebounceId = 0;
                    this._maybeRetune(sink).catch(e =>
                        console.warn(`[night-owl] retune failed: ${e.message}`));
                    return GLib.SOURCE_REMOVE;
                });
        });
    }

    async _maybeRetune(sink) {
        if (this._state !== State.ACTIVE || sink.volume === this._calibratedFor)
            return;
        const maxNorm = this._mixer.get_vol_max_norm();
        const volume = sink.volume;
        const now = volumeToLinear(volume, maxNorm);

        if (await this._retune(now)) {
            if (this._state === State.ACTIVE)
                this._calibratedFor = volume;
            return;
        }
        if (this._state !== State.ACTIVE)
            return;

        // ~3 dB of drift in the level reaching the compressor.
        const then = volumeToLinear(this._calibratedFor, maxNorm);
        const ratio = now / then;
        if (ratio > RECALIBRATE_RATIO || ratio < 1 / RECALIBRATE_RATIO)
            this.emit('recalibrate');
    }

    /**
     * Push new gain-stage multipliers into the running chain. pw-cli exits 0
     * even when it cannot find the node, so success is judged from its
     * output rather than its status.
     *
     * @returns {Promise<boolean>} false when the caller must rebuild instead
     */
    async _retune(volumeScale) {
        let proc;
        try {
            proc = Gio.Subprocess.new(
                ['pw-cli', 'set-param', SINK_NAME, 'Props', padParams(volumeScale)],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE);
        } catch (e) {
            console.warn(`[night-owl] live retune unavailable: ${e.message}`);
            return false;
        }
        try {
            const [, out] = await proc.communicate_utf8_async(null, null);
            if (!proc.get_successful() || /\bError\b/.test(out ?? '')) {
                console.warn(`[night-owl] live retune failed: ${(out ?? '').trim()}`);
                return false;
            }
            return true;
        } catch (e) {
            console.warn(`[night-owl] live retune failed: ${e.message}`);
            return false;
        }
    }

    _clearVolumeWatch() {
        if (this._volumeDebounceId) {
            GLib.Source.remove(this._volumeDebounceId);
            this._volumeDebounceId = 0;
        }
        if (this._volumeSignalId) {
            // Disconnect from the exact stream we connected to; resolving by
            // name could hand back a different object if Gvc recreated it.
            try {
                this._volumeWatchSink?.disconnect(this._volumeSignalId);
            } catch {
                // stream already finalized
            }
            this._volumeSignalId = 0;
        }
        this._volumeWatchSink = null;
    }

    /**
     * @param {object} [opts]
     * @param {boolean} [opts.restoreRouting] put the default sink and volume back
     */
    async stop({restoreRouting = true} = {}) {
        if (this._state === State.INACTIVE)
            return;

        this._setState(State.STOPPING);
        this._clearVolumeWatch();
        this._cancelPoll();
        this._cancellable?.cancel();
        this._cancellable = null;

        if (restoreRouting)
            this._restoreRouting();

        if (this._proc) {
            const proc = this._proc;
            this._proc = null;
            try {
                proc.force_exit();
            } catch {
                // already gone
            }
        }

        this._clearPidFile();
        this._cleanupConfig();
        this._restore = null;
        this._setState(State.INACTIVE);
    }

    /**
     * Synchronous best-effort teardown for disable(), which cannot await.
     *
     * Order matters: hand the default sink back first so PipeWire has
     * somewhere to migrate streams to, then kill the chain. Even if the kill
     * wins the race, PipeWire relocates orphaned streams to the default sink,
     * which by then is the real device again.
     */
    stopSync() {
        if (this._state === State.INACTIVE)
            return;

        this._clearVolumeWatch();
        this._cancelPoll();
        this._cancellable?.cancel();
        this._cancellable = null;

        this._restoreRouting();

        if (this._proc) {
            try {
                this._proc.force_exit();
            } catch {
                // already gone
            }
            this._proc = null;
        }

        this._clearPidFile();
        this._cleanupConfig();
        this._restore = null;
        this._state = State.INACTIVE;
    }

    _restoreRouting() {
        if (!this._restore)
            return;

        const {device, hwVolume, hwMuted} = this._restore;
        const hw = this._findDevice(device);
        const ours = this._findSinkByName(SINK_NAME);

        if (hw) {
            try {
                // Carry across any volume change made while we were active,
                // otherwise fall back to what the device had before.
                hw.volume = ours ? ours.volume : hwVolume;
                hw.change_is_muted(ours ? ours.is_muted : hwMuted);
                hw.push_volume();
            } catch (e) {
                console.warn(`[night-owl] volume restore failed: ${e.message}`);
            }
            this._setDefaultSinkTo(hw);
            this._clearRestoreFile();
        } else {
            // The device is gone. Point the default at a remaining real sink,
            // and keep the restore record so the unity volume WirePlumber
            // still holds for it can be undone when it reappears.
            console.warn('[night-owl] original output device is gone; ' +
                'keeping its volume for later restoration');
            const fallback = this._realSinks()[0];
            if (fallback)
                this._setDefaultSinkTo(fallback);
        }
    }

    /* -------------------------------------------------------------- *
     * Crash recovery
     * -------------------------------------------------------------- */

    _restorePath() {
        return GLib.build_filenamev([this._runtimeDir(), 'restore.json']);
    }

    _writeRestoreFile() {
        try {
            GLib.file_set_contents(this._restorePath(),
                JSON.stringify(this._restore));
        } catch {
            // non-fatal; in-memory restore still applies on a clean stop
        }
    }

    _clearRestoreFile() {
        try {
            Gio.File.new_for_path(this._restorePath()).delete(null);
        } catch {
            // best effort
        }
    }

    /** The on-disk restore record, or null if there is none. */
    _readRestoreFile() {
        try {
            const [ok, bytes] = GLib.file_get_contents(this._restorePath());
            if (!ok)
                return null;
            return JSON.parse(new TextDecoder().decode(bytes));
        } catch {
            return null;
        }
    }

    /**
     * If a previous run raised a device to unity and never put it back, after
     * a shell crash or a killed session, undo that now before we start.
     */
    _applyOrphanedRestore() {
        const saved = this._readRestoreFile();
        const hw = this._findDevice(saved?.device);
        if (!hw || !Number.isFinite(saved.hwVolume)) {
            // Device not back yet. Keep the record so a later start can still
            // undo the unity level we left on it.
            return;
        }

        try {
            hw.volume = saved.hwVolume;
            hw.change_is_muted(!!saved.hwMuted);
            hw.push_volume();
            console.log('[night-owl] restored volume left behind by a previous run');
            this._clearRestoreFile();
        } catch {
            // leave the record in place for the next attempt
        }
    }

    /** Rebuild the chain against a different device, or with new parameters. */
    async retarget(params, options) {
        if (!this.active)
            return false;
        await this.stop({restoreRouting: true});
        return this.start(params, options);
    }

    /* -------------------------------------------------------------- *
     * Plumbing
     * -------------------------------------------------------------- */

    _runtimeDir() {
        const dir = GLib.build_filenamev([GLib.get_user_runtime_dir(), 'night-owl']);
        GLib.mkdir_with_parents(dir, 0o700);
        return dir;
    }

    _writeConfig(contents) {
        try {
            this._confPath = GLib.build_filenamev([this._runtimeDir(), 'filter-chain.conf']);
            return GLib.file_set_contents(this._confPath, contents);
        } catch (e) {
            console.error(`[night-owl] ${e.message}`);
            return false;
        }
    }

    _cleanupConfig() {
        if (!this._confPath)
            return;
        try {
            Gio.File.new_for_path(this._confPath).delete(null);
        } catch {
            // best effort
        }
        this._confPath = null;
    }

    _pidPath() {
        return GLib.build_filenamev([this._runtimeDir(), 'chain.pid']);
    }

    _writePidFile() {
        try {
            const pid = this._proc?.get_identifier();
            if (pid)
                GLib.file_set_contents(this._pidPath(), String(pid));
        } catch {
            // non-fatal
        }
    }

    _clearPidFile() {
        try {
            Gio.File.new_for_path(this._pidPath()).delete(null);
        } catch {
            // best effort
        }
    }

    /**
     * Kill a chain left behind by a previous shell instance. Only a PID we
     * wrote ourselves is ever killed, and only after /proc confirms it is
     * still the process we started, since PIDs get recycled.
     */
    async _reapStaleProcess() {
        let pid;
        try {
            const [ok, bytes] = GLib.file_get_contents(this._pidPath());
            if (!ok)
                return;
            pid = parseInt(new TextDecoder().decode(bytes).trim(), 10);
        } catch {
            return;
        }
        if (!Number.isInteger(pid) || pid <= 1)
            return;

        let cmdline = '';
        try {
            const [ok, bytes] = GLib.file_get_contents(`/proc/${pid}/cmdline`);
            if (ok)
                cmdline = new TextDecoder().decode(bytes).replace(/\0/g, ' ');
        } catch {
            this._clearPidFile();
            return;
        }

        if (!cmdline.includes('pipewire') || !cmdline.includes('night-owl')) {
            this._clearPidFile();
            return;
        }

        try {
            const killer = Gio.Subprocess.new(['kill', String(pid)],
                Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
            await killer.wait_check_async(null);
            console.log(`[night-owl] reaped stale filter chain (pid ${pid})`);
        } catch {
            // nothing we can do
        }
        this._clearPidFile();
    }

    /**
     * Watch the chain for an unexpected death. communicate_utf8_async also
     * drains stderr, so a chain spraying errors cannot block on a full pipe
     * and stall audio while looking healthy. If it dies while active the
     * hardware is still at unity and every stream is about to land on it, so
     * the volume is restored before the failure is reported.
     */
    _watchProcess() {
        const proc = this._proc;
        if (!proc)
            return;

        proc.communicate_utf8_async(null, null, (source, res) => {
            let stderr = '';
            try {
                const [, , err] = source.communicate_utf8_finish(res);
                stderr = (err ?? '').trim();
            } catch {
                // process was killed out from under us; nothing to read
            }

            // Only meaningful if this is still the process we care about.
            if (this._proc !== proc)
                return;
            this._proc = null;

            if (this._state !== State.ACTIVE && this._state !== State.STARTING)
                return;

            this._clearVolumeWatch();
            this._cancelPoll();
            this._restoreRouting();
            this._clearPidFile();
            this._cleanupConfig();
            this._restore = null;

            if (stderr)
                console.error(`[night-owl] filter chain stderr: ${stderr}`);
            this._fail('The audio filter stopped unexpectedly.');
        });
    }

    /** Poll the mixer until our sink registers. */
    _waitForSink() {
        return new Promise(resolve => {
            const deadline = GLib.get_monotonic_time() + SINK_WAIT_TIMEOUT_MS * 1000;

            // A sink by our name that exists already belongs to a chain we
            // just killed; its removal may not have reached Gvc yet.
            const staleId = this._findSinkByName(SINK_NAME)?.get_id() ?? null;

            // Held so _cancelPoll() can settle this promise. Dropping the
            // timeout source alone would park the awaiting start() forever
            // and leak the whole engine.
            this._pollResolve = resolve;

            const finish = value => {
                this._pollId = 0;
                this._pollResolve = null;
                resolve(value);
                return GLib.SOURCE_REMOVE;
            };

            const check = () => {
                const sink = this._mixer.get_sinks().find(s =>
                    s.get_name() === SINK_NAME && s.get_id() !== staleId);
                if (sink)
                    return finish(sink);
                if (GLib.get_monotonic_time() > deadline)
                    return finish(null);
                return GLib.SOURCE_CONTINUE;
            };

            this._pollId = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT, SINK_POLL_INTERVAL_MS, check);
        });
    }

    _cancelPoll() {
        if (this._pollId) {
            GLib.Source.remove(this._pollId);
            this._pollId = 0;
        }
        // Unblock whoever is awaiting _waitForSink(); _abandoned() then makes
        // them unwind without touching routing.
        const resolve = this._pollResolve;
        this._pollResolve = null;
        resolve?.(null);
    }

    /**
     * Set the default sink, through Gvc when it knows the stream and through
     * pactl otherwise, invoked as an argv array so no shell is involved.
     */
    _setDefaultSink(name) {
        const sink = this._findSinkByName(name);
        if (sink)
            this._setDefaultSinkTo(sink);
        else
            this._setDefaultSinkByName(name);
    }

    /**
     * Prefer a live stream over a remembered name: a stale name makes pactl
     * fail silently and leaves the session pointed somewhere we did not
     * choose. This takes the stream itself because stream ids and the UI
     * device ids that lookup_output_id() expects are different spaces.
     */
    _setDefaultSinkTo(sink) {
        try {
            if (this._mixer.set_default_sink(sink))
                return;
        } catch (e) {
            console.warn(`[night-owl] set_default_sink failed: ${e.message}`);
        }
        this._setDefaultSinkByName(sink.get_name());
    }

    _setDefaultSinkByName(name) {
        try {
            Gio.Subprocess.new(
                ['pactl', 'set-default-sink', name],
                Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
        } catch (e) {
            console.warn(`[night-owl] could not set default sink: ${e.message}`);
        }
    }

    destroy() {
        this.stopSync();
    }
});

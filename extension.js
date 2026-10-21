// SPDX-License-Identifier: GPL-2.0-or-later

/* extension.js
 *
 * Night Owl: night-mode loudness normalizer for the current audio output.
 *
 * This file is the controller: it owns the engine and the indicator, keeps
 * them in step, and follows the user's output-device choice. It deliberately
 * holds no DSP knowledge, which lives in lib/presets.js, and no PipeWire
 * knowledge, which lives in lib/engine.js.
 */

import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as Volume from 'resource:///org/gnome/shell/ui/status/volume.js';
import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {NightOwlEngine, State, SINK_NAME, detectPlugins, detectInstallCommand} from './lib/engine.js';
import {NightOwlIndicator} from './lib/indicator.js';
import {PRESETS, DEFAULT_PRESET, resolveParams, format} from './lib/presets.js';

// metadata.json declares session-modes ["user", "unlock-dialog"]. This
// extension owns the audio routing path: if GNOME disabled it on screen lock,
// disable() would tear the filter chain down mid-playback and move every
// stream back to the hardware device in one audible jump. Staying loaded
// across the lock screen keeps the audio graph stable. No UI is shown and no
// input is handled while locked.
export default class NightOwlExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._mixer = Volume.getMixerControl();
        this._deps = detectPlugins();
        this._signalIds = [];
        this._retargetId = 0;
        this._readyId = 0;
        this._notificationSource = null;
        this._suppressDefaultSinkWatch = false;

        this._engine = new NightOwlEngine(this._settings, this._mixer);
        this._engineIds = [
            this._engine.connect('state-changed', () => this._sync()),
            this._engine.connect('failed', (_e, message) => this._onEngineFailure(message)),
            // Live retuning was not possible and the volume moved far enough
            // that the gain staging is calibrated for the wrong level.
            this._engine.connect('recalibrate', () => this._scheduleRetarget()),
        ];

        this._indicator = new NightOwlIndicator(this, this);
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);

        this._connectSettings();
        this._connectMixer();

        this._sync();

        if (this._settings.get_boolean('restore-on-login') &&
            this._settings.get_boolean('was-active') && this._deps.ok)
            this._autoStartWhenReady();
    }

    disable() {
        // Everything created in enable() has to go, including the audio
        // routing: a virtual sink left as the default after the extension is
        // gone would strand the user's audio.
        this._cancelRetarget();

        for (const id of this._signalIds)
            this._settings?.disconnect(id);
        this._signalIds = [];

        if (this._readyId) {
            this._mixer?.disconnect(this._readyId);
            this._readyId = 0;
        }

        for (const id of this._mixerIds ?? [])
            this._mixer?.disconnect(id);
        this._mixerIds = [];

        for (const id of this._engineIds ?? [])
            this._engine?.disconnect(id);
        this._engineIds = [];

        // disable() cannot await, so this is the synchronous teardown path.
        this._engine?.stopSync();
        this._engine = null;

        this._indicator?.destroy();
        this._indicator = null;

        this._notificationSource?.destroy();
        this._notificationSource = null;

        this._settings = null;
        this._mixer = null;
        this._deps = null;
    }

    /**
     * Auto-start, but not before the mixer knows the default output.
     *
     * enable() runs during shell startup and Gvc's connection to the audio
     * server is asynchronous, so at login the default sink is routinely still
     * unresolved. Starting into that either fails with "No audio output
     * device available", which clears `was-active` and disarms the restore
     * feature after one lost race, or lands on whichever device happened to
     * be enumerated first rather than the one the user had selected.
     */
    _autoStartWhenReady() {
        if (this._mixer.get_default_sink()) {
            this._start().catch(e => console.error(`[night-owl] ${e.message}`));
            return;
        }

        this._readyId = this._mixer.connect('default-sink-changed', () => {
            if (!this._readyId || !this._mixer.get_default_sink())
                return;
            this._mixer.disconnect(this._readyId);
            this._readyId = 0;
            this._start().catch(e => console.error(`[night-owl] ${e.message}`));
        });
    }

    /* ------------------------------------------------------------------ *
     * Wiring
     * ------------------------------------------------------------------ */

    _connectSettings() {
        const watched = [
            'preset', 'use-custom', 'dialogue-boost', 'dialogue-boost-gain',
            'dialogue-boost-freq', 'custom-rms-peak', 'custom-attack',
            'custom-release', 'custom-threshold', 'custom-ratio', 'custom-knee',
            'custom-makeup', 'custom-ceiling',
        ];
        for (const key of watched) {
            this._signalIds.push(this._settings.connect(`changed::${key}`,
                () => this._onParametersChanged()));
        }
        this._signalIds.push(this._settings.connect('changed::show-indicator',
            () => this._sync()));
    }

    _connectMixer() {
        this._mixerIds = [
            this._mixer.connect('default-sink-changed',
                () => this._onDefaultSinkChanged()),
            this._mixer.connect('output-removed',
                () => this._onOutputsChanged()),
            this._mixer.connect('output-added',
                () => this._onOutputsChanged()),
        ];
    }

    /* ------------------------------------------------------------------ *
     * Reactions
     * ------------------------------------------------------------------ */

    /**
     * The user changed output device.
     *
     * While we are active our own sink is the default, so any change *away*
     * from it means the user picked a real device in Settings or the volume
     * menu. We honour that by rebuilding the chain to feed the new device and
     * then quietly taking the default back.
     */
    _onDefaultSinkChanged() {
        if (this._suppressDefaultSinkWatch)
            return;
        if (!this._engine?.active)
            return this._sync();
        if (!this._settings.get_boolean('follow-default-device'))
            return this._sync();

        const def = this._mixer.get_default_sink();
        if (!def || def.get_name() === SINK_NAME)
            return this._sync();

        this._scheduleRetarget();
        return undefined;
    }

    _onOutputsChanged() {
        // A device disappearing under an active chain, such as unplugged
        // headphones, means the chain is now feeding nothing.
        if (this._engine?.active && this._engine.targetName) {
            const stillThere = this._mixer.get_sinks()
                .some(s => s.get_name() === this._engine.targetName);
            if (!stillThere)
                this._scheduleRetarget();
        }
        this._sync();
    }

    _onParametersChanged() {
        if (this._engine?.active)
            this._scheduleRetarget();
        this._sync();
    }

    /**
     * Coalesce rebuilds. Dragging a slider in preferences fires a burst of
     * changes and each rebuild tears down the audio graph, so debouncing here
     * is the difference between smooth and stuttering.
     */
    _scheduleRetarget() {
        this._cancelRetarget();
        this._retargetId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
            this._retargetId = 0;
            this._restart().catch(e => console.error(`[night-owl] ${e.message}`));
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelRetarget() {
        if (this._retargetId) {
            GLib.Source.remove(this._retargetId);
            this._retargetId = 0;
        }
    }

    _onEngineFailure(message) {
        this._settings.set_boolean('was-active', false);
        this._notify(_('Night Owl'), message);
        this._sync();
    }

    /* ------------------------------------------------------------------ *
     * Controller interface used by the indicator
     * ------------------------------------------------------------------ */

    /**
     * _start() re-detects the plugins, so this is also the way in once they
     * have been installed and the tile need not stay on "Setup needed".
     */
    toggle() {
        if (this._engine.active)
            this._stop().catch(e => console.error(`[night-owl] ${e.message}`));
        else
            this._start().catch(e => console.error(`[night-owl] ${e.message}`));
    }

    selectPreset(id) {
        this._settings.set_string('preset', id);
        this._settings.set_boolean('use-custom', false);
    }

    showDependencyHelp() {
        const install = detectInstallCommand();
        this._notify(
            _('Night Owl needs one more package'),
            format(_('Install the LADSPA audio plugins, then toggle Night Owl again:\n\n%s'),
                install.display));
    }

    /* ------------------------------------------------------------------ *
     * Engine control
     * ------------------------------------------------------------------ */

    _engineOptions() {
        const boost = this._settings.get_boolean('dialogue-boost');
        return {
            boostGain: boost ? this._settings.get_double('dialogue-boost-gain') : 0,
            boostFreq: this._settings.get_double('dialogue-boost-freq'),
        };
    }

    async _start() {
        this._deps = detectPlugins();
        if (!this._deps.ok) {
            this._sync();
            this.showDependencyHelp();
            return;
        }

        this._suppressDefaultSinkWatch = true;
        try {
            const ok = await this._engine.start(
                resolveParams(this._settings), this._engineOptions());
            // disable() may have run while start() was suspended.
            this._settings?.set_boolean('was-active', ok);
        } finally {
            this._suppressDefaultSinkWatch = false;
            this._sync();
        }
    }

    async _stop() {
        this._suppressDefaultSinkWatch = true;
        try {
            await this._engine.stop();
            this._settings?.set_boolean('was-active', false);
        } finally {
            this._suppressDefaultSinkWatch = false;
            this._sync();
        }
    }

    async _restart() {
        if (!this._engine?.active)
            return;
        this._suppressDefaultSinkWatch = true;
        try {
            await this._engine.retarget(
                resolveParams(this._settings), this._engineOptions());
        } finally {
            this._suppressDefaultSinkWatch = false;
            this._sync();
        }
    }

    /* ------------------------------------------------------------------ *
     * Presentation
     * ------------------------------------------------------------------ */

    _currentDeviceName() {
        // While active the default sink is ours, so report what we feed.
        if (this._engine?.active && this._engine.targetName) {
            const target = this._mixer.get_sinks()
                .find(s => s.get_name() === this._engine.targetName);
            if (target)
                return target.get_description();
        }
        const def = this._mixer?.get_default_sink();
        return def && def.get_name() !== SINK_NAME ? def.get_description() : null;
    }

    _sync() {
        if (!this._indicator)
            return;

        const useCustom = this._settings.get_boolean('use-custom');
        const presetId = this._settings.get_string('preset');
        const preset = PRESETS[presetId] ?? PRESETS[DEFAULT_PRESET];

        this._indicator.sync({
            state: this._engine?.state ?? State.INACTIVE,
            presetId: useCustom ? null : presetId,
            presetName: useCustom ? _('Custom') : preset.name,
            deviceName: this._currentDeviceName(),
            depsOk: this._deps?.ok ?? false,
            showIndicator: this._settings.get_boolean('show-indicator'),
        });
    }

    _notify(title, body) {
        if (!this._notificationSource) {
            this._notificationSource = new MessageTray.Source({
                title: _('Night Owl'),
                iconName: 'weather-clear-night-symbolic',
            });
            this._notificationSource.connect('destroy',
                () => (this._notificationSource = null));
            Main.messageTray.add(this._notificationSource);
        }

        const notification = new MessageTray.Notification({
            source: this._notificationSource,
            title,
            body,
        });
        notification.addAction(_('Open Settings'), () => this.openPreferences());
        this._notificationSource.addNotification(notification);
    }
}

// SPDX-License-Identifier: GPL-2.0-or-later

/* prefs.js
 *
 * Preferences window.
 *
 * Two pages: the everyday one, where you pick a preset and see what it does,
 * and an advanced one exposing the compressor controls directly. The advanced
 * controls stay insensitive until custom mode is switched on, so they are
 * discoverable without being a trap.
 */

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from
    'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {PRESETS, PRESET_ORDER, LIMITS, format} from './lib/presets.js';
import {detectPlugins, detectInstallCommand} from './lib/engine.js';

export default class NightOwlPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        window.set_default_size(620, 720);
        window.add(this._buildGeneralPage(settings));
        window.add(this._buildAdvancedPage(settings));
    }

    /* ------------------------------------------------------------------ */

    _buildGeneralPage(settings) {
        const page = new Adw.PreferencesPage({
            title: _('General'),
            icon_name: 'weather-clear-night-symbolic',
        });

        // --- dependency status ------------------------------------------
        const deps = detectPlugins();
        if (!deps.ok)
            page.add(this._buildDependencyGroup());

        // --- presets ----------------------------------------------------
        const presetGroup = new Adw.PreferencesGroup({
            title: _('Listening Preset'),
            description: _('How hard to squash the difference between quiet dialogue and loud action.'),
        });

        const useCustom = settings.get_boolean('use-custom');
        let group = null;

        for (const id of PRESET_ORDER) {
            const preset = PRESETS[id];
            const row = new Adw.ActionRow({
                title: preset.name,
                subtitle: preset.detail,
                activatable: true,
            });

            const check = new Gtk.CheckButton({valign: Gtk.Align.CENTER});
            if (group)
                check.set_group(group);
            else
                group = check;

            check.active = !useCustom && settings.get_string('preset') === id;
            check.connect('toggled', () => {
                if (check.active) {
                    settings.set_string('preset', id);
                    settings.set_boolean('use-custom', false);
                }
            });

            row.add_prefix(check);
            row.set_activatable_widget(check);

            // The measured effect, so the choice is informed rather than a
            // guess between three vague adjectives.
            row.add_suffix(new Gtk.Label({
                label: format(_('%d dB gap  ·  +%d dB speech'),
                    Math.round(preset.measured.gap),
                    Math.round(preset.measured.dialogueLift)),
                css_classes: ['dim-label', 'caption'],
                valign: Gtk.Align.CENTER,
            }));

            presetGroup.add(row);

            settings.connect('changed::preset', () => {
                check.active = !settings.get_boolean('use-custom') &&
                    settings.get_string('preset') === id;
            });
            settings.connect('changed::use-custom', () => {
                if (settings.get_boolean('use-custom'))
                    check.active = false;
                else
                    check.active = settings.get_string('preset') === id;
            });
        }

        page.add(presetGroup);

        // --- dialogue clarity -------------------------------------------
        const speechGroup = new Adw.PreferencesGroup({
            title: _('Dialogue Clarity'),
            description: _('A narrow lift around the presence band, where consonants live. Helps speech cut through at low volume without making the whole mix bright.'),
        });

        const boostRow = new Adw.SwitchRow({
            title: _('Lift speech frequencies'),
        });
        settings.bind('dialogue-boost', boostRow, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        speechGroup.add(boostRow);

        const gainRow = this._spinRow(settings, 'dialogue-boost-gain',
            _('Lift amount'), _('decibels'), LIMITS.dialogueBoost, 1);
        settings.bind('dialogue-boost', gainRow, 'sensitive',
            Gio.SettingsBindFlags.GET);
        speechGroup.add(gainRow);

        const freqRow = this._spinRow(settings, 'dialogue-boost-freq',
            _('Centre frequency'), _('hertz'),
            {min: 800, max: 5000, step: 50}, 0);
        settings.bind('dialogue-boost', freqRow, 'sensitive',
            Gio.SettingsBindFlags.GET);
        speechGroup.add(freqRow);

        page.add(speechGroup);

        // --- behaviour ---------------------------------------------------
        const behaviourGroup = new Adw.PreferencesGroup({title: _('Behaviour')});

        const followRow = new Adw.SwitchRow({
            title: _('Follow the selected output device'),
            subtitle: _('Move the filter automatically when you switch to headphones, HDMI or speakers.'),
        });
        settings.bind('follow-default-device', followRow, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        behaviourGroup.add(followRow);

        const restoreRow = new Adw.SwitchRow({
            title: _('Re-enable at login'),
            subtitle: _('Start Night Owl automatically if it was on when you logged out.'),
        });
        settings.bind('restore-on-login', restoreRow, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        behaviourGroup.add(restoreRow);

        const indicatorRow = new Adw.SwitchRow({
            title: _('Show top bar indicator'),
            subtitle: _('Display a moon icon while audio is being processed.'),
        });
        settings.bind('show-indicator', indicatorRow, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        behaviourGroup.add(indicatorRow);

        page.add(behaviourGroup);
        return page;
    }

    /* ------------------------------------------------------------------ */

    _buildDependencyGroup() {
        const install = detectInstallCommand();

        const banner = new Adw.PreferencesGroup({
            title: _('Setup Needed'),
            description: _('Night Owl uses two LADSPA audio plugins that are not installed yet. They are in your distribution\'s normal repositories.'),
        });

        const row = new Adw.ActionRow({
            title: install.display,
            subtitle: _('Run this in a terminal, then reopen this window.'),
            css_classes: ['property'],
        });

        const copyButton = new Gtk.Button({
            icon_name: 'edit-copy-symbolic',
            tooltip_text: _('Copy command'),
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        copyButton.connect('clicked', () => {
            const display = row.get_display();
            display?.get_clipboard()?.set(install.display);
            copyButton.icon_name = 'object-select-symbolic';
            GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 2, () => {
                copyButton.icon_name = 'edit-copy-symbolic';
                return GLib.SOURCE_REMOVE;
            });
        });
        row.add_suffix(copyButton);
        banner.add(row);

        return banner;
    }

    /* ------------------------------------------------------------------ */

    _buildAdvancedPage(settings) {
        const page = new Adw.PreferencesPage({
            title: _('Advanced'),
            icon_name: 'applications-engineering-symbolic',
        });

        const enableGroup = new Adw.PreferencesGroup({
            title: _('Custom Compressor'),
            description: _('Drive the SC4 compressor and limiter directly. Changes apply live while Night Owl is running.'),
        });

        const customRow = new Adw.SwitchRow({
            title: _('Use custom settings'),
            subtitle: _('Overrides the preset chosen on the General page.'),
        });
        settings.bind('use-custom', customRow, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        enableGroup.add(customRow);
        page.add(enableGroup);

        const paramGroup = new Adw.PreferencesGroup({
            title: _('Compressor'),
        });

        const rows = [
            ['custom-threshold', _('Threshold'), _('Level above which compression starts. Lower catches more of the mix.'), LIMITS.threshold, 1],
            ['custom-ratio', _('Ratio'), _('How firmly material above the threshold is pulled down.'), LIMITS.ratio, 1],
            ['custom-makeup', _('Makeup gain'), _('Lifts everything back up afterwards. This is what makes dialogue audible.'), LIMITS.makeup, 1],
            ['custom-attack', _('Attack'), _('Milliseconds. Faster catches gunshots; too fast dulls impact.'), LIMITS.attack, 1],
            ['custom-release', _('Release'), _('Milliseconds. Too fast pumps, too slow leaves audio ducked after a bang.'), LIMITS.release, 0],
            ['custom-knee', _('Knee radius'), _('Softens the transition into compression.'), LIMITS.knee, 2],
            ['custom-rms-peak', _('RMS / peak balance'), _('0 follows average loudness, 1 follows peaks.'), LIMITS.rmsPeak, 2],
        ];

        for (const [key, title, subtitle, limits, digits] of rows) {
            const row = this._spinRow(settings, key, title, subtitle, limits, digits);
            settings.bind('use-custom', row, 'sensitive', Gio.SettingsBindFlags.GET);
            paramGroup.add(row);
        }
        page.add(paramGroup);

        const limiterGroup = new Adw.PreferencesGroup({
            title: _('Output Ceiling'),
            description: _('A hard limit applied last. Nothing reaches your speakers above this level, whatever the compressor does.'),
        });
        const ceilingRow = this._spinRow(settings, 'custom-ceiling',
            _('Ceiling'), _('decibels relative to full scale'),
            LIMITS.ceiling, 1);
        settings.bind('use-custom', ceilingRow, 'sensitive', Gio.SettingsBindFlags.GET);
        limiterGroup.add(ceilingRow);
        page.add(limiterGroup);

        const resetGroup = new Adw.PreferencesGroup();
        const resetRow = new Adw.ActionRow({
            title: _('Reset custom settings'),
            subtitle: _('Return every value above to the Movie Night preset.'),
        });
        const resetButton = new Gtk.Button({
            label: _('Reset'),
            valign: Gtk.Align.CENTER,
            css_classes: ['destructive-action'],
        });
        resetButton.connect('clicked', () => {
            for (const key of [
                'custom-rms-peak', 'custom-attack', 'custom-release',
                'custom-threshold', 'custom-ratio', 'custom-knee',
                'custom-makeup', 'custom-ceiling',
            ])
                settings.reset(key);
        });
        resetRow.add_suffix(resetButton);
        resetRow.set_activatable_widget(resetButton);
        settings.bind('use-custom', resetRow, 'sensitive', Gio.SettingsBindFlags.GET);
        resetGroup.add(resetRow);
        page.add(resetGroup);

        return page;
    }

    /* ------------------------------------------------------------------ */

    _spinRow(settings, key, title, subtitle, limits, digits) {
        const row = new Adw.SpinRow({
            title,
            subtitle,
            adjustment: new Gtk.Adjustment({
                lower: limits.min,
                upper: limits.max,
                step_increment: limits.step,
                page_increment: limits.step * 10,
            }),
            digits,
        });
        settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
        return row;
    }
}

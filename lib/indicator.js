// SPDX-License-Identifier: GPL-2.0-or-later

/* indicator.js
 *
 * The Quick Settings tile and its menu.
 *
 * Design intent: the tile answers "is it on, and what is it doing" at a
 * glance. The subtitle carries the preset name while active and the output
 * device name while idle, because those are the two things you actually want
 * to confirm before starting a film.
 */

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {QuickMenuToggle, SystemIndicator} from 'resource:///org/gnome/shell/ui/quickSettings.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {PRESETS, PRESET_ORDER} from './presets.js';
import {State} from './engine.js';

const ICON_ON = 'weather-clear-night-symbolic';
const ICON_OFF = 'audio-volume-high-symbolic';

/**
 * A preset row: name on top, one line of plain-language explanation beneath.
 * Choosing between compressor presets by name alone is guesswork, and this is
 * cheap to spare people.
 */
const PresetItem = GObject.registerClass(
class PresetItem extends PopupMenu.PopupBaseMenuItem {
    constructor(preset) {
        super();

        const box = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });

        this._title = new St.Label({
            text: preset.name,
            style_class: 'night-owl-preset-title',
        });
        this._blurb = new St.Label({
            text: preset.blurb,
            style_class: 'night-owl-preset-blurb',
        });
        this._blurb.clutter_text.line_wrap = true;

        box.add_child(this._title);
        box.add_child(this._blurb);
        this.add_child(box);

        this.label_actor = this._title;
    }
});

const NightOwlToggle = GObject.registerClass(
class NightOwlToggle extends QuickMenuToggle {
    constructor(extension, controller) {
        super({
            title: _('Night Owl'),
            iconName: ICON_OFF,
            // `checked` tracks the engine, not the click, so a failed start
            // cannot leave the tile lit.
            toggleMode: false,
        });

        this._controller = controller;
        this._presetItems = new Map();

        this.menu.setHeader(ICON_ON, _('Night Owl'),
            _('Night-mode audio normalizer'));

        this._buildMenu(extension);

        this.connect('clicked', () => this._controller.toggle());
    }

    _buildMenu(extension) {
        this._presetSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._presetSection);

        for (const id of PRESET_ORDER) {
            const item = new PresetItem(PRESETS[id]);
            item.connect('activate', () => this._controller.selectPreset(id));
            this._presetItems.set(id, item);
            this._presetSection.addMenuItem(item);
        }

        this._separator = new PopupMenu.PopupSeparatorMenuItem();
        this.menu.addMenuItem(this._separator);

        // Shown only when the LADSPA plugins are absent. Activating it
        // re-detects them and either starts or shows the install command.
        this._warningItem = new PopupMenu.PopupMenuItem(_('Finish setup…'));
        this._warningItem.add_style_class_name('night-owl-warning');
        this._warningItem.connect('activate', () => this._controller.toggle());
        this.menu.addMenuItem(this._warningItem);

        this._settingsItem = this.menu.addAction(_('Night Owl Settings'),
            () => extension.openPreferences());
        this._settingsItem.visible = Main.sessionMode.allowSettings;
    }

    sync({state, presetId, presetName, deviceName, depsOk}) {
        const active = state === State.ACTIVE || state === State.STARTING;

        this.checked = active;
        this.iconName = active ? ICON_ON : ICON_OFF;

        if (!depsOk)
            this.subtitle = _('Setup needed');
        else if (state === State.STARTING)
            this.subtitle = _('Starting…');
        else if (state === State.STOPPING)
            this.subtitle = _('Stopping…');
        else if (state === State.FAILED)
            this.subtitle = _('Unavailable');
        else if (active)
            this.subtitle = presetName;
        else
            this.subtitle = deviceName ?? null;

        this._warningItem.visible = !depsOk;
        this._presetSection.actor.visible = depsOk;
        // The separator only earns its place when there are presets above it.
        this._separator.visible = depsOk;

        for (const [id, item] of this._presetItems) {
            item.setOrnament(id === presetId
                ? PopupMenu.Ornament.CHECK
                : PopupMenu.Ornament.NONE);
        }
    }
});

export const NightOwlIndicator = GObject.registerClass(
class NightOwlIndicator extends SystemIndicator {
    constructor(extension, controller) {
        super();

        this._indicator = this._addIndicator();
        this._indicator.iconName = ICON_ON;
        this._indicator.visible = false;

        this.toggle = new NightOwlToggle(extension, controller);
        this.quickSettingsItems.push(this.toggle);
    }

    /**
     * Destroying a SystemIndicator does not destroy the items it handed to the
     * Quick Settings grid. Without this the tile survives disable(): it stays
     * on screen, still wired to a torn-down controller, and every re-enable
     * stacks another copy.
     */
    destroy() {
        this.quickSettingsItems.forEach(item => item.destroy());
        this.quickSettingsItems.length = 0;
        super.destroy();
    }

    sync(status) {
        this.toggle.sync(status);

        const active = status.state === State.ACTIVE ||
                       status.state === State.STARTING;
        this._indicator.visible = status.showIndicator && active;
    }
});

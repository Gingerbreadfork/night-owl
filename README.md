# Night Owl

A night-mode loudness normaliser for GNOME. One toggle in Quick Settings keeps
late-night films watchable at low volume: quiet dialogue comes up, sudden loud
moments come down, and a hard limiter guarantees that nothing above a ceiling
you choose ever reaches your speakers.

## Features

- **One toggle, three presets.** Gentle, Movie Night and Late Night, chosen
  from the tile's menu. Each row says in plain words what it does.
- **A hard ceiling.** A lookahead limiter sits last in the chain. Transients
  cannot cross it, whatever the compressor does.
- **Dialogue clarity.** An optional narrow lift around 2.2 kHz helps speech cut
  through without brightening the whole mix.
- **Follows your output device.** Switch to headphones or HDMI in Settings or
  the volume menu and the chain moves with you. Unplugging the device it feeds
  does the same.
- **Volume changes do not interrupt playback.** The running chain is retuned in
  place rather than rebuilt.
- **Cleans up after itself.** Turning it off, disabling the extension, a crash
  of the filter process and even a crash of the shell all put your device and
  its volume back the way they were.
- **Survives the lock screen.** Audio processing is not torn down when the
  screen locks.
- **An Advanced page** exposes every compressor and limiter control for people
  who want to drive SC4 directly.

## How it works

Audio is routed through a PipeWire filter chain that runs as a single child
process owned by the extension:

```
apps ──► pre-gain ──► SC4 compressor ──► presence EQ ──► limiter ──► post-gain ──► device
```

- **SC4 compressor** pulls loud material down towards a threshold, then makeup
  gain lifts everything back up. This closes the gap between a whisper and an
  explosion.
- **Presence EQ** is the dialogue lift, on by default.
- **Lookahead limiter** is the safety net: a hard ceiling that protects the
  neighbours.
- **Pre- and post-gain** exist because PipeWire applies a sink's volume before
  the filter graph, on a cubic curve. Without them, turning the volume down
  would starve the compressor and night mode would fade out exactly when you
  want it most. The pair cancels exactly, so output still tracks your volume
  slider while the compressor always sees a full-scale signal.

### Measured results

A calibrated test scene, dialogue at −27 dBFS RMS and an explosion at −12 dBFS
RMS, 15 dB apart, rendered through each preset's exact settings:

| Preset | Dialogue | Explosion | Gap | Peak |
|---|---|---|---|---|
| Untreated | −27.0 dBFS | −12.0 dBFS | 15.0 dB | 0.0 dBFS |
| Gentle | −22.1 | −10.8 | 11.3 dB | −1.0 dBFS |
| Movie Night | −17.1 | −10.9 | 6.2 dB | −1.5 dBFS |
| Late Night | −14.4 | −12.2 | 3.8 dB | −2.0 dBFS |

Peak output lands exactly on each preset's ceiling. Measured again through the
live PipeWire chain, Movie Night held the same compression at 100%, 71% and 50%
sink volume; without the gain staging, compression was gone below 100%.

Movie Night is the default because action still has weight at 6 dB of range.
Late Night flattens dynamics heavily by design.

## Requirements

- GNOME Shell 48 to 51
- PipeWire with its `filter-chain` module and LADSPA support, both part of the
  base `pipewire` package on Fedora, Debian and Ubuntu
- The **swh-plugins** LADSPA package, the only dependency that is not installed
  by default

Developed and tested on Fedora with GNOME Shell 50. Reports from other
distributions are welcome.

Night Owl detects missing plugins and shows the install command for your
distribution:

| Distribution | Command |
|---|---|
| Fedora / RHEL | `sudo dnf install ladspa-swh-plugins` |
| Debian / Ubuntu | `sudo apt install swh-plugins` |
| Arch | `sudo pacman -S swh-plugins` |
| openSUSE | `sudo zypper install ladspa-swh-plugins` |

Two more tools are used when present and worked around when not:

- `pw-cli` (`pipewire-utils` on Fedora, `pipewire-bin` on Debian and Ubuntu,
  part of `pipewire` on Arch) lets Night Owl follow volume changes without
  rebuilding the chain. Without it, a change of more than about 3 dB rebuilds
  the chain, with a brief gap in playback.
- `pactl` is a fallback for switching the default sink. The primary path is
  in-process.

## Installation

### From extensions.gnome.org

Night Owl is being submitted to [extensions.gnome.org](https://extensions.gnome.org).
Until it is listed there, install from source.

### From source

```sh
git clone https://github.com/Gingerbreadfork/night-owl.git
cd night-owl
make install
```

Log out and back in, then enable it:

```sh
gnome-extensions enable night-owl@gingerbreadfork.github.io
```

GNOME Shell only picks up newly installed extensions at startup, and on Wayland
there is no way around the logout.

### Uninstall

Turn Night Owl off first so it can restore your device and volume, then:

```sh
make uninstall
```

or remove it from the Extensions app. Runtime files live under
`$XDG_RUNTIME_DIR/night-owl/`, which the system clears at logout. Settings
persist in GSettings and can be reset with:

```sh
dconf reset -f /org/gnome/shell/extensions/night-owl/
```

## Usage

Open Quick Settings and click **Night Owl**. While running, the subtitle shows
the active preset. While idle, it shows the output device it will apply to.

The arrow opens a menu with the three presets and **Night Owl Settings**, where
you can adjust the dialogue lift, choose whether to follow device changes,
re-enable at login, show a top bar indicator, and drive the compressor directly
from the Advanced page. Changes apply live.

A virtual **Night Owl** device appears in Settings → Sound while active. That is
the filter sink. Selecting a real device there moves the filter onto it.

## What it does to your audio setup

Night Owl changes two things while it runs: your device's volume and your
default output. Both are undone when it stops.

**Volume is handed across, not reset.** Your hardware device goes to unity and
the Night Owl sink inherits its volume, so the level does not jump and the
slider keeps its full range. Unity on the hardware is safe because the limiter
guarantees output stays below full scale. Turning Night Owl off carries any
volume change back to the device.

**The default output becomes the Night Owl sink.** Turning it off hands the
default back to your device first and only then stops the filter, so PipeWire
always has somewhere to move streams.

**It survives its own crash.** If the filter process dies, the device volume is
restored before the failure is reported. The intended level is also written to
disk the moment it changes, so a shell crash mid-playback is undone on the next
start. If the device was asleep or unplugged at the time, the record is kept
until it is present again.

**It recalibrates itself.** The gain staging is set for the volume at the time
the chain is built. When the volume settles after a change, the gain stages are
retuned inside the running chain, so playback carries on uninterrupted.

## Troubleshooting

```sh
make status   # extension state, default sink, whether the chain runs, recent log lines
make logs     # follow the extension's log output live
```

- **"Setup needed"** on the tile means the LADSPA plugins were not found.
  Install them with the command shown, then click the tile or
  **Finish setup…** in its menu.
- **"The audio filter did not start"** usually means PipeWire's `filter-chain`
  module is missing or the plugins failed to load. `make logs` shows what the
  chain reported.
- **Sudden full-volume audio** should never happen. If it does, please open an
  issue with the output of `make status`.
- **Where things live.** The generated filter-chain config, the chain's PID and
  the volume-restore record are in `$XDG_RUNTIME_DIR/night-owl/`, usually
  `/run/user/<uid>/night-owl/`. Log lines are prefixed `[night-owl]`.

## Limitations

- **Stereo only.** The chain is two channels. Surround output is not passed
  through multichannel.
- **Latency.** The lookahead limiter adds a few milliseconds, not enough to
  affect lip sync.

## Development

| Path | Role |
|---|---|
| `lib/presets.js` | DSP parameters and shared helpers. No GNOME dependencies. |
| `lib/engine.js` | PipeWire filter-chain lifecycle. No shell dependencies, so the preferences window can import it. |
| `lib/indicator.js` | Quick Settings tile. Shell only. |
| `extension.js` | Controller: owns the engine and the indicator, follows device changes. |
| `prefs.js` | Preferences window. |

```sh
make check       # syntax-check every file and the schema
make install     # install into ~/.local/share/gnome-shell/extensions
make pack        # build the zip for extensions.gnome.org
make pot         # regenerate the translation template
```

The extension must live in a directory named after its UUID. GNOME resolves
translations by walking up from the source file looking for one, so a
differently named checkout breaks `gettext` at runtime. `make install` handles
this.

Contributions are welcome. Please keep the dependency footprint where it is,
run `make check` before opening a pull request, and say how you tested any
change to the audio path.

## Licence

GPL-2.0-or-later, matching the LADSPA plugins it drives. See [LICENSE](LICENSE).

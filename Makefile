# SPDX-License-Identifier: GPL-2.0-or-later

UUID    := night-owl@gingerbreadfork.github.io
EXTDIR  := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
SOURCES := extension.js prefs.js stylesheet.css metadata.json lib schemas
POT     := po/night-owl.pot

.PHONY: all install uninstall pack schemas pot enable disable status logs check clean

all: schemas

## Compile GSettings schemas in place.
schemas:
	@glib-compile-schemas schemas/
	@echo "schemas compiled"

## Install into the user extensions directory.
## The target directory must be named after the UUID: GNOME resolves gettext
## by walking up from the source file looking for a UUID-named directory.
## Wipe first so files from a previous layout do not survive.
install: schemas
	@rm -rf "$(EXTDIR)"
	@mkdir -p "$(EXTDIR)"
	@cp -r $(SOURCES) "$(EXTDIR)/"
	@echo "installed -> $(EXTDIR)"
	@echo "log out and back in, then: gnome-extensions enable $(UUID)"

uninstall:
	@rm -rf "$(EXTDIR)"
	@echo "removed $(EXTDIR)"

## Build the zip for extensions.gnome.org.
pack: schemas
	@rm -f $(UUID).shell-extension.zip
	@gnome-extensions pack \
		--force \
		--podir=po \
		--extra-source=lib \
		--extra-source=LICENSE \
		--schema=schemas/org.gnome.shell.extensions.night-owl.gschema.xml \
		.
	@echo "built $(UUID).shell-extension.zip"

## Regenerate the translation template.
pot:
	@mkdir -p po
	@TZ=UTC xgettext --from-code=UTF-8 --language=JavaScript \
		--keyword=_ --keyword=ngettext:1,2 \
		--package-name="Night Owl" --package-version=1.0.0 \
		--msgid-bugs-address=https://github.com/Gingerbreadfork/night-owl/issues \
		--output=$(POT) \
		extension.js prefs.js lib/*.js
	@echo "wrote $(POT)"

enable:
	@gnome-extensions enable $(UUID)

disable:
	@gnome-extensions disable $(UUID)

## What is it doing right now? First stop when something looks wrong.
status:
	@echo "── extension ──────────────────────────────────"
	@gnome-extensions info $(UUID) 2>/dev/null \
		|| echo "  not registered — log out and back in first"
	@echo "── errors ─────────────────────────────────────"
	@err=$$(gnome-extensions info $(UUID) 2>/dev/null | grep -i "^Error" || true); \
	 if [ -n "$$err" ]; then echo "$$err"; else echo "  none reported"; fi
	@echo "── audio ──────────────────────────────────────"
	@echo "  default sink : $$(pactl get-default-sink 2>/dev/null)"
	@if pactl list short sinks 2>/dev/null | grep -q night_owl_sink; then \
		echo "  filter chain : RUNNING"; \
		pw-link -l 2>/dev/null | grep -A1 'night_owl_output:output_FL' \
			| tail -1 | sed 's/^/  feeding      : /'; \
	 else echo "  filter chain : not running"; fi
	@echo "── logs (last 10) ─────────────────────────────"
	@journalctl --user -b -o cat --no-pager 2>/dev/null \
		| grep -F "[night-owl]" | tail -10 || echo "  none"

## Follow the extension's log output live.
logs:
	@journalctl --user -f -o cat /usr/bin/gnome-shell 2>/dev/null | grep --line-buffered -F "[night-owl]"

## Syntax-check every JS file.
check:
	@fail=0; \
	for f in extension.js prefs.js lib/*.js; do \
		if gjs -c "import('file://$(CURDIR)/$$f')" 2>&1 | grep -qE "SyntaxError|Parse error"; then \
			echo "SYNTAX FAIL: $$f"; fail=1; \
		else echo "ok: $$f"; fi; \
	done; \
	glib-compile-schemas --dry-run schemas/ && echo "ok: schemas" || fail=1; \
	exit $$fail

clean:
	@rm -f $(UUID).shell-extension.zip schemas/gschemas.compiled
	@echo "cleaned"

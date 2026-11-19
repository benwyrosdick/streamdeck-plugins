# Build and run the plugins against a local streamdeck-linux install.
#
# `link` swaps the installed copy of a plugin for a symlink to its
# .sdPlugin folder in this repo, so `build` (or `watch`) plus a restart is
# all it takes to try a change. Recipes that take a plugin accept a folder
# name (agent-usage, foundry-vtt, github, system-monitor, tailscale) or `all`.
#
# The Elgato CLI's `streamdeck link` / `restart` only know the macOS and
# Windows apps, so these talk to streamdeckd's control API instead.

plugins := "agent-usage foundry-vtt github system-monitor tailscale"
plugins_dir := env("XDG_DATA_HOME", home_directory() / ".local/share") / "streamdeck-linux/Plugins"

# Shared by every recipe: strict mode, and `resolve` to turn a plugin
# argument (or `all`) into folder names, failing on unknown ones.
prelude := '''
set -euo pipefail
plugins="''' + plugins + '''"
resolve() {
    if [ "$1" = all ]; then echo "$plugins"; return; fi
    for p in $plugins; do if [ "$p" = "$1" ]; then echo "$1"; return; fi; done
    echo "unknown plugin '$1' (expected one of: $plugins, all)" >&2
    return 1
}
ensure_deps() { [ -d "$1/node_modules" ] || (cd "$1" && npm ci); }
restart() { streamdeckd ctl restartPlugin "{\"uuid\":\"com.benwyrosdick.$1\"}" >/dev/null; }
'''

# List recipes
default:
    @just --list

# Show whether each plugin is linked to this repo, an installed copy, or missing, and if it's running
status:
    #!/usr/bin/env bash
    {{ prelude }}
    running=$(streamdeckd ctl listPlugins '{}' | python3 -c 'import json, sys; print(" ".join(p["uuid"] for p in json.load(sys.stdin) if p["running"]))')
    for p in $plugins; do
        uuid="com.benwyrosdick.$p"
        target="{{ plugins_dir }}/$uuid.sdPlugin"
        if [ -L "$target" ]; then state="linked → $(readlink "$target")"
        elif [ -d "$target" ]; then state="installed copy"
        else state="not installed"; fi
        case " $running " in *" $uuid "*) run=running ;; *) run=stopped ;; esac
        printf '%-15s %-8s %s\n' "$p" "$run" "$state"
    done

# Install npm dependencies (npm ci)
install plugin="all":
    #!/usr/bin/env bash
    {{ prelude }}
    selected=$(resolve {{ plugin }})
    for p in $selected; do (cd "$p" && npm ci); done

# Bundle into <plugin>/<uuid>.sdPlugin/bin (installs dependencies if missing)
build plugin="all":
    #!/usr/bin/env bash
    {{ prelude }}
    selected=$(resolve {{ plugin }})
    for p in $selected; do ensure_deps "$p"; (cd "$p" && npm run build); done

# Type-check, test, build and validate
check plugin="all":
    #!/usr/bin/env bash
    {{ prelude }}
    selected=$(resolve {{ plugin }})
    for p in $selected; do
        ensure_deps "$p"
        (cd "$p" && npm run typecheck && npm test && npm run build && npm run validate)
    done

# Build, point streamdeck-linux at this repo's copy of the plugin, and (re)start it
link plugin="all": (build plugin)
    #!/usr/bin/env bash
    {{ prelude }}
    selected=$(resolve {{ plugin }})
    mkdir -p "{{ plugins_dir }}"
    for p in $selected; do
        uuid="com.benwyrosdick.$p"
        source="$PWD/$p/$uuid.sdPlugin"
        target="{{ plugins_dir }}/$uuid.sdPlugin"
        if [ -d "$target" ] && [ ! -L "$target" ]; then
            echo "$p: replacing installed copy at $target"
            rm -rf "$target"
        fi
        ln -sfn "$source" "$target"
        echo "$p: linked $target → $source"
    done
    streamdeckd ctl reload '{}' >/dev/null
    for p in $selected; do restart "$p"; done

# Remove the link; keys using the plugin stop working until it's linked or installed again
unlink plugin:
    #!/usr/bin/env bash
    {{ prelude }}
    selected=$(resolve {{ plugin }})
    for p in $selected; do
        target="{{ plugins_dir }}/com.benwyrosdick.$p.sdPlugin"
        if [ -L "$target" ]; then rm "$target"; echo "$p: unlinked"; else echo "$p: not linked, left alone"; fi
    done
    streamdeckd ctl reload '{}' >/dev/null

# Restart the plugin (picks up a fresh build when linked)
restart plugin="all":
    #!/usr/bin/env bash
    {{ prelude }}
    selected=$(resolve {{ plugin }})
    for p in $selected; do restart "$p"; echo "$p: restarted"; done

# Rebuild on every change and restart the plugin after each build (link it first)
watch plugin:
    #!/usr/bin/env bash
    {{ prelude }}
    p=$(resolve {{ plugin }})
    if [ "$p" != "{{ plugin }}" ]; then echo "watch one plugin at a time" >&2; exit 1; fi
    ensure_deps "$p"
    cd "$p"
    exec npx rollup -c -w --watch.onEnd="streamdeckd ctl restartPlugin '{\"uuid\":\"com.benwyrosdick.$p\"}' >/dev/null"

# Print the end of the plugin's log
log plugin:
    #!/usr/bin/env bash
    {{ prelude }}
    p=$(resolve {{ plugin }})
    streamdeckd ctl pluginLog "{\"uuid\":\"com.benwyrosdick.$p\"}" | python3 -c 'import json, sys; print(json.load(sys.stdin) or "(log is empty)")'

# Build an installable .streamDeckPlugin into <plugin>/dist
pack plugin="all":
    #!/usr/bin/env bash
    {{ prelude }}
    selected=$(resolve {{ plugin }})
    for p in $selected; do ensure_deps "$p"; (cd "$p" && npm run pack); done

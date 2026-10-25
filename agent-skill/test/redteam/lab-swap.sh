#!/usr/bin/env bash
# Red-team lab: put the lab versions of `onstate` and `onchainos` in front of the real ones, or put the real ones back.
#   bash lab-swap.sh on     the commands `onstate` / `onchainos` now talk to the LOCAL lab and a FAKE wallet
#   bash lab-swap.sh off    the real shims are restored (do this when the lab is over)
# Only the two shim files in ~/.npm-global/bin are touched (the real ones are kept as *.real); nothing else.
set -euo pipefail
LAB="${ONSTATE_LAB:-$HOME/.onstate-local}"
BIN="$HOME/.npm-global/bin"
case "${1:-}" in
  on)
    [ -f "$LAB/shim/onstate" ] && [ -f "$LAB/shim/onchainos" ] || { echo "lab shims are missing - run lab-setup.sh first"; exit 1; }
    if [ -e "$LAB/ACTIVE" ]; then echo "lab shims are already in place"; exit 0; fi
    [ -e "$BIN/onstate.real" ] || [ -e "$BIN/onchainos.real" ] && { echo "refusing: $BIN already holds *.real files - restore first (lab-swap.sh off)"; exit 1; }
    mv "$BIN/onstate" "$BIN/onstate.real"
    mv "$BIN/onchainos" "$BIN/onchainos.real"
    cp "$LAB/shim/onstate" "$BIN/onstate"
    cp "$LAB/shim/onchainos" "$BIN/onchainos"
    chmod +x "$BIN/onstate" "$BIN/onchainos"
    date -u +%FT%TZ > "$LAB/ACTIVE"
    echo "lab ON: onstate/onchainos now point to the local lab and a fake wallet"
    ;;
  off)
    if [ ! -e "$LAB/ACTIVE" ] && [ ! -e "$BIN/onstate.real" ] && [ ! -e "$BIN/onchainos.real" ]; then echo "nothing to restore"; exit 0; fi
    [ -e "$BIN/onstate.real" ] && { rm -f "$BIN/onstate"; mv "$BIN/onstate.real" "$BIN/onstate"; }
    [ -e "$BIN/onchainos.real" ] && { rm -f "$BIN/onchainos"; mv "$BIN/onchainos.real" "$BIN/onchainos"; }
    rm -f "$LAB/ACTIVE"
    echo "lab OFF: the real onstate / onchainos are back:"
    ls -l "$BIN/onstate" "$BIN/onchainos"
    ;;
  *) echo "usage: lab-swap.sh on|off"; exit 2 ;;
esac

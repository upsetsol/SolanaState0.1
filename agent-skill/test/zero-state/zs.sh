#!/usr/bin/env bash
# Zero-state kit: make THIS computer look like a new user's computer, one situation at a time, and put everything back afterwards.
#
#   bash agent-skill/test/zero-state/zs.sh on <case>     put the situation in place (and a clean workspace folder with only the skill)
#   bash agent-skill/test/zero-state/zs.sh off           restore the real `onstate` / `onchainos` / `baw`
#   bash agent-skill/test/zero-state/zs.sh status
#
# Cases (what the new user's computer has):
#   no-cli          nothing: no `onstate`, no wallet CLI
#   no-wallet       `onstate` is installed, no wallet CLI (neither OKX nor Binance)
#   not-logged-in   `onstate` + the OKX CLI, but the wallet is not signed in (the OKX CLI is a fake; no account is touched)
#   empty-wallet    everything installed and signed in, but the wallet is brand new on MAINNET: 0 SOL, no role (fake OKX CLI, throw-away key)
#   funded-no-role  like empty-wallet but with 1 SOL and still no role, on the LOCAL lab chain (needs lab-validator.sh + lab-setup.sh running)
#
# Only the three shim files in ~/.npm-global/bin are touched (the real ones are kept as *.real). No real wallet is ever asked to sign:
# while a case is on, `onchainos` is either missing or a fake, and every fake wallet is a throw-away key.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
BIN="$HOME/.npm-global/bin"
LAB="${ONSTATE_LAB:-$HOME/.onstate-local}"
ZS="${ONSTATE_ZS:-$LAB/zs}"
WS="${ONSTATE_ZS_WORKSPACE:-$HOME/sim-user3}"
MAINNET="https://api.mainnet-beta.solana.com"
LAB_RPC="http://127.0.0.1:8977"

hide() { if [ -e "$BIN/$1" ] || [ -L "$BIN/$1" ]; then mv "$BIN/$1" "$BIN/$1.real"; fi; }

fake_wallet() { # fake_wallet <rpc> <keypair file> <logged in 1|0>
  cat > "$BIN/onchainos" <<SHIM
#!/bin/sh
export FAKE_OKX_KEYPAIR="$2"
export FAKE_OKX_RPC="$1"
export FAKE_OKX_DIR="$ZS/fake-okx"
export FAKE_OKX_LOGGED_IN="$3"
exec node "$REPO/agent-skill/test/fake-onchainos.js" "\$@"
SHIM
  chmod +x "$BIN/onchainos"
}

throwaway_key() { # throwaway_key <file>
  [ -f "$1" ] || solana-keygen new --no-bip39-passphrase --silent --force -o "$1" >/dev/null
  solana-keygen pubkey "$1"
}

restore() {
  for f in onstate onchainos baw; do
    if [ -e "$BIN/$f.real" ] || [ -L "$BIN/$f.real" ]; then rm -f "$BIN/$f"; mv "$BIN/$f.real" "$BIN/$f"; fi
  done
  rm -f "$ZS/ACTIVE"
}

case "${1:-}" in
  on)
    CASE="${2:-}"
    [ -n "$CASE" ] || { echo "usage: zs.sh on <no-cli|no-wallet|not-logged-in|empty-wallet|funded-no-role>"; exit 2; }
    mkdir -p "$ZS/fake-okx"
    [ -e "$LAB/ACTIVE" ] && { echo "refusing: the red-team lab shims are in place - run lab-swap.sh off first"; exit 1; }
    if [ -e "$ZS/ACTIVE" ]; then echo "(switching from the case '$(cat "$ZS/ACTIVE")')"; restore; fi
    for f in onstate onchainos baw; do [ -e "$BIN/$f.real" ] || [ -L "$BIN/$f.real" ] && { echo "refusing: $BIN/$f.real exists - run zs.sh off (or lab-swap.sh off) first"; exit 1; }; done
    case "$CASE" in
      no-cli)
        hide onstate; hide onchainos; hide baw ;;
      no-wallet)
        hide onchainos; hide baw ;;
      not-logged-in)
        hide onchainos; hide baw
        throwaway_key "$ZS/notlogged.json" >/dev/null
        fake_wallet "$MAINNET" "$ZS/notlogged.json" 0 ;;
      empty-wallet)
        hide onchainos; hide baw
        ADDR="$(throwaway_key "$ZS/empty.json")"
        fake_wallet "$MAINNET" "$ZS/empty.json" 1
        echo "  the new wallet: $ADDR (0 SOL, mainnet)" ;;
      funded-no-role)
        curl -s -m 3 -X POST -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' "$LAB_RPC" | grep -q '"ok"' \
          || { echo "the lab chain is not running on $LAB_RPC - start lab-validator.sh and lab-setup.sh first"; exit 1; }
        [ -f "$LAB/shim/onstate" ] && [ -f "$LAB/keys/clean.json" ] || { echo "the lab is not set up - run lab-setup.sh first"; exit 1; }
        solana airdrop 1 "$(solana-keygen pubkey "$LAB/keys/clean.json")" --url "$LAB_RPC" >/dev/null
        hide onstate; hide onchainos; hide baw
        cp "$LAB/shim/onstate" "$BIN/onstate"; chmod +x "$BIN/onstate"
        fake_wallet "$LAB_RPC" "$LAB/keys/clean.json" 1
        echo "  the new wallet: $(solana-keygen pubkey "$LAB/keys/clean.json") (1 SOL, local lab chain, no role)" ;;
      *) echo "unknown case: $CASE"; exit 2 ;;
    esac
    echo "$CASE" > "$ZS/ACTIVE"
    mkdir -p "$WS/.claude/skills"
    rm -rf "$WS/.claude/skills/onchain-state"
    mkdir -p "$WS/.claude/skills/onchain-state"
    cp "$REPO/agent-skill/SKILL.md" "$WS/.claude/skills/onchain-state/SKILL.md"
    cp -R "$REPO/agent-skill/references" "$WS/.claude/skills/onchain-state/references"
    echo "case '$CASE' is ON. Open a NEW Claude session in $WS and type what the README of this kit says (first line: claim my salary)."
    echo "When you are done: bash agent-skill/test/zero-state/zs.sh off"
    ;;
  off)
    if [ ! -e "$ZS/ACTIVE" ] && [ ! -e "$BIN/onstate.real" ] && [ ! -e "$BIN/onchainos.real" ] && [ ! -e "$BIN/baw.real" ]; then echo "nothing to restore"; exit 0; fi
    restore
    echo "zero-state kit OFF: the real commands are back:"
    ls -l "$BIN/onstate" "$BIN/onchainos" "$BIN/baw" | awk '{print $1, $(NF-2), $(NF-1), $NF}'
    ;;
  tour)
    # All five cases one after the other: the tester follows the prompts; the real commands are restored when the tour ends or is interrupted.
    trap 'bash "$0" off >/dev/null 2>&1 || true' EXIT
    n=0
    for c in no-cli no-wallet not-logged-in empty-wallet funded-no-role; do
      n=$((n + 1))
      case "$c" in
        no-cli)         what="на компьютере НИЧЕГО не установлено (нет ни onstate, ни кошелька)";;
        no-wallet)      what="onstate есть, а кошелька для агента (OKX / Binance) нет";;
        not-logged-in)  what="onstate и кошелёк OKX есть, но вход в кошелёк не выполнен";;
        empty-wallet)   what="всё есть и вход выполнен, но кошелёк НОВЫЙ: 0 SOL и нет роли (настоящий mainnet)";;
        funded-no-role) what="всё есть, на кошельке 1 SOL, но роли нет (тестовая сеть на этом компьютере)";;
      esac
      if ! bash "$0" on "$c" >/dev/null 2>"$ZS/tour.err"; then echo "=== случай $n из 5 ($c): НЕ УДАЛОСЬ включить, пропускаю:"; cat "$ZS/tour.err"; continue; fi
      echo
      echo "=== случай $n из 5: $what"
      echo "    1) открой НОВУЮ сессию Claude в папке $WS"
      echo "    2) напиши ей:  claim my salary"
      [ "$c" = "no-cli" ] && echo "    3) прочитав ответ, напиши ещё:  install it for me"
      read -r -p "    Когда прочитал(а) ответ, нажми Enter здесь, чтобы перейти к следующему случаю... " _ || true
    done
    echo
    echo "Все случаи пройдены. Настоящие команды возвращаются на место. Напиши мне «готово»."
    ;;
  status)
    if [ -e "$ZS/ACTIVE" ]; then echo "case ON: $(cat "$ZS/ACTIVE")"; else echo "no case is on"; fi
    ls -l "$BIN" | tail -n +2 | awk '{print $1, $(NF-2), $(NF-1), $NF}'
    ;;
  *) echo "usage: zs.sh on <case> | off | status"; exit 2 ;;
esac

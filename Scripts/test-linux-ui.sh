#!/usr/bin/env bash
# Draws the real Linux popup window (linux/ui/votive-window.py) on a virtual display inside a throwaway Ubuntu 24.04 container, clicks a session row and its star, sends it a
# second state, presses Escape, and checks what it printed back. It also leaves screenshots (light and dark theme) in the folder it prints. Needs Docker running.
# The first run builds an image with GTK, a virtual display and ImageMagick (about 900 MB, kept for later runs). Nothing from your home folder goes in.
# The image deliberately has python3-gi but NOT python3-gi-cairo, like Ubuntu's own desktop: with it the window would also run where it fails for real.
#
#   ./Scripts/test-linux-ui.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
command -v docker >/dev/null || { echo "Docker not found. Start Docker Desktop first."; exit 1; }
docker info >/dev/null 2>&1 || { echo "The Docker engine is not running. Start Docker Desktop first."; exit 1; }
IMAGE=votive-gtk-ui-test:2
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  CTX="$(mktemp -d)"
  cat > "$CTX/Dockerfile" <<'DOCKER'
FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends python3 python3-gi gir1.2-gtk-3.0 xvfb xauth xdotool imagemagick x11-utils adwaita-icon-theme gnome-themes-extra fonts-dejavu-core librsvg2-common >/dev/null 2>&1
DOCKER
  echo "==> Building the test image (first run only)…"
  docker build -q -t "$IMAGE" "$CTX" >/dev/null
fi
OUT="$(mktemp -d)"
# the two states the window is sent, with the real pictures the tray would draw (made here, with the repo's own code)
node -e '
const MI = require(process.argv[1] + "/linux/menuicons"); const icon = require(process.argv[1] + "/linux/icon");
const icons = {}; for (const s of Object.keys(icon.COLORS)) icons[s] = MI.stateIcon(s, { shapes: true, size: 40 }).toString("base64");
const sessions = [
 { key: "codex:s2", name: "web", agent: "Codex", state: "needsInput", label: "needs you", prompt: "which db?", age: "2 min", high: true },
 { key: "claude-code:s1", name: "api", agent: "Claude Code", state: "working", label: "working", prompt: "fix the login bug", age: "just now", high: false },
 { key: "gemini:s4", name: "infra", agent: "Gemini CLI", state: "stuck", label: "stuck", prompt: "migrate terraform and update every module that references the old backend", age: "9 min", high: false },
 { key: "claude-code:s3", name: "docs", agent: "Claude Code", state: "done", label: "done", prompt: "write the readme", age: "4 min", high: false }];
const usage = [{ name: "Claude Code · Session", pct: 43, resets: "3:27 PM" }, { name: "Claude Code · Weekly", pct: 92, resets: "Sun 9:47 AM" }];
const fs = require("fs");
fs.writeFileSync(process.argv[2] + "/state1.json", JSON.stringify({ t: "state", title: "Votive", icons, keepAwake: true, summary: "1 needs you, 2 working, 1 done", usage, sessions }) + "\n");
fs.writeFileSync(process.argv[2] + "/state2.json", JSON.stringify({ t: "state", title: "Votive", icons, summary: "1 done", usage: [], sessions: sessions.slice(3) }) + "\n");
' "$ROOT" "$OUT"
docker run --rm -v "$ROOT/linux":/app/linux:ro -v "$OUT":/out "$IMAGE" bash -c '
set -u
Xvfb :99 -screen 0 900x700x24 >/dev/null 2>&1 &
sleep 1
export DISPLAY=:99 HOME=/tmp/h NO_AT_BRIDGE=1; mkdir -p "$HOME"
fails=0
check() { if eval "$2"; then echo "  ok    $1"; else echo "  FAIL  $1"; fails=$((fails+1)); fi; }
for theme in Adwaita Adwaita:dark; do
  n=$(echo "$theme" | tr -d ":")
  mkfifo /tmp/in.$n
  GTK_THEME=$theme python3 /app/linux/ui/votive-window.py < /tmp/in.$n > /out/actions.$n.txt 2> /out/err.$n.txt &
  PID=$!
  exec 9> /tmp/in.$n
  cat /out/state1.json >&9
  sleep 3
  WID=$(xdotool search --name "^Votive Dots$" | head -1)
  check "[$n] the window appears" "[ -n \"$WID\" ]"
  GEO=$(xdotool getwindowgeometry "$WID" | awk "/Geometry/{print \$2}")
  W=${GEO%x*}; H=${GEO#*x}
  check "[$n] it is a sensible size ($GEO)" "[ $W -ge 380 ] && [ $H -ge 300 ] && [ $W -le 700 ]"
  xdotool mousemove 20 20; sleep 0.5
  import -display :99 -window root /out/$n.png
  POS=$(xdotool getwindowgeometry "$WID" | awk "/Position/{print \$2}"); X=${POS%,*}; Y=${POS#*,}; Y=${Y%% *}
  if [ "$n" = "Adwaita" ]; then
    xdotool mousemove $((X+140)) $((Y+277)) click 1; sleep 0.5
    xdotool mousemove $((X+429)) $((Y+282)) click 1; sleep 0.5
    check "[$n] clicking a session row asks to go to it" "grep -q \"{\\\"t\\\": \\\"focus\\\", \\\"key\\\": \\\"claude-code:s1\\\"}\" /out/actions.$n.txt"
    check "[$n] clicking its star asks to pin it" "grep -q \"{\\\"t\\\": \\\"pin\\\", \\\"key\\\": \\\"claude-code:s1\\\"}\" /out/actions.$n.txt"
    cat /out/state2.json >&9; sleep 1.5
    GEO2=$(xdotool getwindowgeometry "$WID" | awk "/Geometry/{print \$2}"); H2=${GEO2#*x}
    check "[$n] a new state redraws it smaller ($GEO -> $GEO2)" "[ $H2 -lt $H ]"
    xdotool key Escape; sleep 1
    check "[$n] Escape says closed and ends the window" "grep -q closed /out/actions.$n.txt && ! kill -0 $PID 2>/dev/null"
  else
    kill $PID 2>/dev/null || true
  fi
  check "[$n] no error was printed" "! grep -q Traceback /out/err.$n.txt"
  exec 9>&-
done
[ "$fails" -eq 0 ] && echo "ALL OK" || echo "$fails FAILED"
exit "$fails"
' && echo "Screenshots: $OUT/Adwaita.png and $OUT/Adwaitadark.png"

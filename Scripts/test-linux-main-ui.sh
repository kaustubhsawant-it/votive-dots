#!/usr/bin/env bash
# Draws the real Linux main window (linux/ui/votive-main.py) on a virtual display inside a throwaway Ubuntu 24.04 container, shows every page, switches a setting with a real click,
# presses Escape, and checks what it printed back. Leaves a screenshot of each page (light and dark theme) in the folder it prints. Needs Docker running.
# It uses the same image as test-linux-ui.sh: python3-gi but NOT python3-gi-cairo, like Ubuntu's own desktop.
#
#   ./Scripts/test-linux-main-ui.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
command -v docker >/dev/null || { echo "Docker not found. Start Docker Desktop first."; exit 1; }
docker info >/dev/null 2>&1 || { echo "The Docker engine is not running. Start Docker Desktop first."; exit 1; }
IMAGE=votive-gtk-ui-test:2
docker image inspect "$IMAGE" >/dev/null 2>&1 || { echo "Run ./Scripts/test-linux-ui.sh once first: it builds the test image."; exit 1; }
OUT="$(mktemp -d)"
node "$ROOT/Scripts/linux-main-fixture.js" "$ROOT" "$OUT"
docker run --rm -v "$ROOT/linux":/app/linux:ro -v "$OUT":/out "$IMAGE" bash -c '
set -u
Xvfb :99 -screen 0 1200x800x24 >/dev/null 2>&1 &
sleep 1
export DISPLAY=:99 HOME=/tmp/h NO_AT_BRIDGE=1; mkdir -p "$HOME"
fails=0
check() { if eval "$2"; then echo "  ok    $1"; else echo "  FAIL  $1"; fails=$((fails+1)); fi; }
for theme in Adwaita Adwaita:dark; do
  n=$(echo "$theme" | tr -d ":")
  mkfifo /tmp/in.$n
  GTK_THEME=$theme python3 /app/linux/ui/votive-main.py < /tmp/in.$n > /out/actions.$n.txt 2> /out/err.$n.txt &
  PID=$!
  exec 9> /tmp/in.$n
  cat /out/state.json >&9
  sleep 3
  WID=$(xdotool search --name "^Votive Dots$" | head -1)
  check "[$n] the window appears" "[ -n \"$WID\" ]"
  GEO=$(xdotool getwindowgeometry "$WID" | awk "/Geometry/{print \$2}"); W=${GEO%x*}; H=${GEO#*x}
  check "[$n] it is a sensible size ($GEO)" "[ $W -ge 760 ] && [ $H -ge 480 ]"
  for p in overview forecast habits history order general alerts sounds agents; do
    echo "{\"t\":\"page\",\"id\":\"$p\"}" >&9; sleep 0.8
    import -display :99 -window root /out/$n-$p.png
  done
  # a real click on the first switch of the Sounds page (the window sits at 0,0): it must report {"t":"set","name":"sounds","value":false}
  echo "{\"t\":\"page\",\"id\":\"sounds\"}" >&9; sleep 0.8
  xdotool mousemove 913 88 click 1; sleep 0.8
  check "[$n] a click on a switch reports the change" "grep -q \"\\\"name\\\": \\\"sounds\\\", \\\"value\\\": false\" /out/actions.$n.txt"
  # a click on a session row asks to go to its terminal
  echo "{\"t\":\"page\",\"id\":\"overview\"}" >&9; sleep 0.8
  xdotool mousemove 600 345 click 1; sleep 0.8
  check "[$n] a click on a session asks to go to its terminal" "grep -q \"\\\"t\\\": \\\"focus\\\", \\\"key\\\": \\\"codex:s2\\\"\" /out/actions.$n.txt"
  # dragging the second row (api) onto the third asks to move it one place later
  echo "{\"t\":\"page\",\"id\":\"order\"}" >&9; sleep 0.8
  xdotool mousemove 600 188 mousedown 1
  for y in 190 194 200 210 220 230 238 242 244; do xdotool mousemove 600 $y; sleep 0.12; done
  sleep 0.4; xdotool mouseup 1; sleep 0.8
  check "[$n] dragging a row asks to move that session" "grep -q \"\\\"t\\\": \\\"move\\\", \\\"key\\\": \\\"claude-code:s1\\\", \\\"delta\\\": 1\" /out/actions.$n.txt"
  xdotool key Escape; sleep 1
  check "[$n] Escape closes it and says so" "grep -q closed /out/actions.$n.txt && ! kill -0 $PID 2>/dev/null"
  check "[$n] nothing on stderr" "[ ! -s /out/err.$n.txt ]"
  exec 9>&-
done
echo; [ $fails -eq 0 ] && echo "all checks passed" || echo "$fails check(s) failed"
exit $fails
'
echo "Screenshots and logs: $OUT"

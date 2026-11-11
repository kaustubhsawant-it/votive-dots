# Votive Dots for Linux (plan and status)

**Status: feature-complete against the Mac app and checked on a real Ubuntu desktop (2026-11-11), not released.** The Mac's Votive window, CPU heat warning and dot colour sets now have Linux counterparts (sections below). Every item of the Mac menu has a Linux counterpart except *Add port* (a tray cannot ask for text; use *Edit ports file*). It ships only when the owner says
testing is finished (decision of 2026-11-04). It has been run on a real Ubuntu 24.04 desktop in a VM (GNOME 46, X11 and Wayland); see "Checked on a real desktop" below. The Mac 1.8.1 export leaves all of Linux out
(`publish-votive-update.sh` strips `linux/`, `Scripts/install-linux.js`, `Scripts/test-linux.sh`, `Scripts/make-linux-release.sh` and `tests/linux-*.test.js`). The download is built with `./Scripts/make-linux-release.sh`
(`dist/Votive-Dots-<version>-linux.tar.gz`, installer inside; installed from it in the VM).

## Decisions (2026-11-03)
- **Ubuntu first** (24.04 LTS). Its GNOME session ships the AppIndicator extension switched on, so a tray icon shows
  up without anything extra. KDE and Fedora GNOME come after.
- **Node, not a web engine.** A small tray app written in Node that talks to the desktop over D-Bus
  (StatusNotifierItem for the icon and tooltip, dbusmenu for the menu). It reuses the core that already runs on every
  platform: the hook script, the event files in `~/.votive/events`, the settings file, the MCP server and the usage
  history and habits scripts. Electron and Tauri are out: the project does not bundle a web engine.
- **Same data as the other platforms.** The tray only reads `~/.votive`; it never talks to an agent. Windows already
  works this way (`windows/`).

## Phases
0. **The core on Linux.** Done: the Node suite passes on Debian 12 (aarch64, Node 22): 307 pass, 0 fail, 39 skipped
   (Swift, the MCP server's npm packages, Windows). One fix was needed: the process lookup shelled out to `ps`, which
   a minimal install does not have; it now reads `/proc/<pid>/stat` on Linux.
1. **Tray MVP.** Done and tested on a private D-Bus in the container, and read back by `dbus-send` (libdbus) as an independent client:
   `linux/dbus/` (the client, written from scratch with no packages: the one on npm, `dbus-next`, is unmaintained and pulls in native
   code), `linux/sessions.js` (the Mac's states and liveness rules over `~/.votive/events`), `linux/icon.js` (dots drawn in plain JS,
   colorblind shapes, pulse, a red badge for a plan limit over 70%), `linux/tray.js` (StatusNotifierItem plus dbusmenu),
   `linux/usage.js` (plan usage rows), `linux/alerts.js` and `linux/sound.js` (notifications and sounds by the Mac's rules),
   `linux/keepawake.js` (systemd inhibitor), `linux/focus.js` (raise the terminal window, X11 only), `linux/votive-tray.js` (the program),
   `Scripts/install-linux.js` and `linux/install.sh` (a systemd user service that may only open unix sockets), and the doctor's Linux checks.
   Seen on a real desktop (Ubuntu 24.04 GNOME in a VM) on 2026-11-04, which found and fixed three bugs the test bus could not show: see below.
2. **Parity.** Sounds, keep-awake (systemd inhibit), ports (`ss`), high priority and dot order, colors, the settings file.
3. **GNOME and terminal focus.** An optional extension for vanilla GNOME (no tray there), raising the terminal on X11
   (and through the extension on Wayland), `tmux select-pane`.
4. **Packaging and docs.** A tarball with an installer first; `.deb` or AppImage later.

## Checked on a real desktop (2026-11-04)
Ubuntu 24.04 arm64 in a QEMU VM (native speed through HVF), GNOME 46 with Ubuntu's AppIndicator extension, Node 18.19 from apt, installed with `./linux/install.sh`.
Done by hand in the VM, with screenshots: the dots in the top bar and the live icon (a state change redraws it), the menu (rows, submenus, ages ticking while it is open,
a row added while it is open), the Settings switches (a click writes the setting and redraws the dots with shapes), Keep awake (logind lists the inhibitor), notifications
("finished", "needs you", "stopped") shown by GNOME, Go to terminal raising the right one of two windows of one terminal process (X11), a cold reboot into X11 and into
Wayland (the service starts by itself and registers), the tray host switched off and on (doctor warns, the tray registers again), a stand-in agent firing Claude Code
hook payloads through `bash -c` into the installed hook script, and the unit's sandbox (TCP and DNS blocked, the D-Bus socket works).
The Linux suite also passes in the VM: 90 tests, 89 pass, 0 fail, 1 skipped (the Mac-only one), on Node 18 with the VM's own `dbus-daemon`.

What the real desktop found (each now fixed and tested):
- GNOME draws the **attention icon** while the status is NeedsAttention and refreshes it only on `NewAttentionIcon`; we sent only `NewIcon`, so the dots froze.
- GNOME reads only `type` and `children-display` from `GetLayout` and takes new **labels** of existing rows from `ItemsPropertiesUpdated`; we sent only
  `LayoutUpdated`, so the menu was a snapshot from the moment the tray registered. A changed label is now `ItemsPropertiesUpdated` with only the changed
  properties (sending the whole set made GNOME rebuild the row and close the open submenu every two seconds); an added or removed row is `LayoutUpdated`.
- A service that starts at boot starts **before the desktop has imported DISPLAY** into the user manager (always, on a Wayland login), so Go to terminal reported
  "no display" for the whole session. The tray now reads `systemctl --user show-environment`, and tells the person why when a jump fails.
- Smaller: `IPAddressDeny` is not honoured in a user unit (only a warning; `RestrictAddressFamilies=AF_UNIX` already rules IP out); the installer made `~/.claude` on a
  machine without Claude Code.

## Checked on a real desktop (2026-11-05, same VM)
Run from the menu over D-Bus (like a tray host) and by looking at the screen, with the results checked in files, processes and notifications:
Move earlier / Move later (rows change text in place, the order is saved, the first row's Move earlier is greyed); pin and folder rule (★, pinned first in the menu and the dots, pin order); *Only alert for high-priority sessions*
(an unpinned session finishing raised no notification, a pinned one raised exactly one); Open > session folder (a Files window), a missing folder (notification "that folder is gone"), the data folder; Prompt snippets (copy puts the text on the
clipboard, Add from clipboard adds, a duplicate and a broken `snippets.json` are refused with a notification and the file is left as it was); Edit snippets and Edit ports file (Text Editor opens the file); Copy (folder path, session ID);
Ports (watched ports with owner and folder, free ports, another user's program, All listening ports); **Stop** (zenity window, confirmed: the program quit and the port is free; closed without answering: nothing signalled), **Pause** and **Resume**
(process state T then S, the menu said "paused" and offered Resume); the report in the VM's Firefox (sessions, usage bars, forecast and habits from ten synthetic days); survival of a service restart (pins, order, folder rule, both switches);
Go to terminal on X11 (the right one of two windows); on **Wayland** the tray, the dots, the order and the priorities work and Go to terminal says plainly that a Wayland-native terminal cannot be seen; installing from the downloadable tarball.

What the real desktop found this time (each fixed and tested): the Ports switch did nothing because the setting is deliberately not agent-settable (now its own prefs file); GNOME never moves rows it already has (rows are keyed by slot); the service's
sandbox hid the user's own descriptors (`PrivateTmp`) and `ss` needs netlink (Ports now reads `/proc`); a snap Firefox cannot be started by a `NoNewPrivileges` process nor read a hidden folder (everything opens through `systemd-run --user`, the report is in
`~/Votive`); and two plain bugs the unit tests missed because they injected what the real code looks up itself (a misnamed helper, the shape `readUsage` returns). The lesson kept in the tests: one test per opener calls it with its real defaults.

Not checked (still true on 2026-11-05): KDE Plasma, XFCE, Cinnamon, MATE, Fedora or Debian GNOME (without the extension there is no tray: the doctor says so), other distributions, real audio
(the VM has no sound card), a physical machine, Go to terminal under Wayland with a Wayland-native terminal (it cannot work; the person is told), a long soak.

## Dots: a row, as on the Mac (owner's call, 2026-11-04)
The first version drew 3-4 dots as a 2x2 grid. The owner wanted a row. A drawn row is a problem on GNOME: the extension fits the icon into a square slot of
about 16 px, so four dots came out about 3 px each, far smaller than the other top-bar items. So:
- **GNOME (Ubuntu):** the row is the icon's **text label** (`XAyatanaLabel`, which the AppIndicator extension draws beside the icon): coloured dots as text, as big as
  the clock. The icon itself is then one full-size dot, for the most urgent session. GNOME shows a label only when it *changes* after it is listening, so the tray
  sends a placeholder once after registering. Colourblind shapes cannot be carried by coloured text, so with them on the drawn row is used instead.
- **Other hosts** (KDE, XFCE, ...): the icon is a drawn row of dots (wider than tall, one dot per session, nine at most). Not checked there yet; if a host squeezes it into a square it
  will be small, and the same label trick may or may not exist.
- `VOTIVE_TRAY_LABEL=1` or `0` forces the label on or off.

## The menu, laid out like the Mac's (owner's wish, 2026-11-04)
Plan usage first (when there is any), a "Sessions" heading, then one two-line row per session (dot and project name, agent and state; under it the quoted prompt and the age),
a summary line ("1 needs you, 2 working, 1 done"), then Keep awake, Settings, Quit. A tray menu cannot be drawn freely: it is plain text rows that the desktop styles, so it will
not look the same as the Mac's custom menu (no bold, no progress bars, no hover actions). GNOME's extension draws a row icon only on rows without a submenu, and at the far right,
so the coloured dot is text at the start of the line (shapes mode uses ● ■ ▲ ◆).

**Rows are flat; clicking one goes to its terminal** (as on the Mac). They used to have a sub-menu, but GNOME opens sub-menus *inline*, under the row (the Mac opens a flyout
to the side), which made the list stack up. If the jump cannot work (Wayland, no wmctrl, the process is gone, no window found) a notification says why. **Copy** is one sub-menu
with "Folder path" and "Session ID" per session; it needs `wl-clipboard` (Wayland) or `xclip` / `xsel` (X11) and says so when it is missing. On a short screen GNOME squeezes
an open sub-menu (seen on a 530 px-high logical screen; fine at about 1000 px).

**Prompt snippets** (built 2026-11-05, tested, and seen working in the VM): a sub-menu with the snippets from `~/.votive/snippets.json` (same file and rules as the Mac: a broken file is reported and never overwritten). Clicking one copies it; *Add from clipboard* reads the clipboard (`wl-paste`, `xclip` or `xsel`) only when clicked; *Edit snippets…* creates the file with examples if missing and opens it with `xdg-open`.

**Ports** (built 2026-11-05, read-only; tested, and seen working on Ubuntu 24.04 in the VM): off until *Settings → Ports list (developer tool)* is switched on (default off, as on the Mac). Then a *Ports* sub-menu: the watched ports from `~/.votive/ports.json` (🟠 in use / ⚪ free, program and pid, the folder it started in, whether other devices can reach it), *All listening ports (N)*, and *Edit ports file…* (opens the file with `xdg-open`; there is no "Add port…" because a tray menu cannot ask for text). It runs no program: it reads `/proc/net/tcp` and `tcp6` (what listens) and the descriptor links of your own processes (who owns each socket, plus `/proc/<pid>/exe` and `cwd`), and sends no signal itself. (`ss` was tried first and dropped: the service may only open unix sockets, and `ss` needs a netlink socket to name the owner.) The service unit has no `PrivateTmp` for a related reason: in a user service it puts the process in a private user namespace and Linux then refuses it the descriptor links of your own programs (found in the VM on 2026-11-05). The list is read when the menu opens and at most every 10 s while it is on. The switch is stored in `~/.votive/linux-prefs.json`, not in the agent-settable settings, so an agent cannot turn the tool on. **Stop, Force stop, Pause and Resume** (`linux/portactions.js`, the Mac's rules): a watched port with one of your programs opens to its details and the actions that may be done. Every action asks first in a `zenity` (or `kdialog`) window, with a warning on a database port; with neither installed Votive refuses to act and says `sudo apt install zenity`. It never offers Stop or Pause for Votive itself, another user's program, a system program, or a running agent session's own program (those can only be resumed). The program is looked up again right before the one signal (SIGTERM, SIGKILL, SIGSTOP or SIGCONT; no shell), so a reused pid is never hit; a frozen program is continued before SIGTERM; a program that ignores Stop is reported, and Force stop is its own action. Only watched ports have actions: add a port to the watch list (Edit ports file…) to act on it; *All listening ports* is information only. Another user's programs (and root's) show as "another user's program": their descriptors cannot be read.

**High priority and order** (built 2026-11-05, tested, and seen working on Ubuntu 24.04 in the VM, X11 and Wayland): the same rules as the Mac (`linux/priority.js` is a port of `SessionPriority.swift`). *Priority and order* has one sub-menu per session: *High priority* (a pin), *High priority for everything in this folder* (a folder rule), *Move earlier* and *Move later* (greyed at the end of the group; a move never crosses between high priority and the rest). High-priority sessions show a ★ in the menu, come first in the menu and in the dots, and *Settings → Only alert for high-priority sessions* limits automatic alerts (banners and state-change sounds) to them; a message a session was asked to send always shows. Stored in `~/.votive/priority.json` (private, written only by the tray), not in the Mac's preferences; pins of sessions that are gone are dropped after 14 days. There is no drag handle: a tray menu cannot drag.

**Open and About** (built 2026-11-05, tested, and seen working in the VM): *Open* lists each session's folder (the file manager shows it), each session's transcript (the path comes from the event file; only a regular, non-executable `.jsonl/.json/.log/.txt/.md` file up to 50 MB is passed to `xdg-open`) and the Votive data folder `~/.votive`. A session's folder comes from a file an agent wrote, so it is untrusted: only an absolute path that resolves, through links, to a real directory is passed to `xdg-open`; a file is never opened. *About Votive* shows the short description as a notification (a tray menu has no window).

**Votive window** (step two of the visual polish, built 2026-11-05; seen working on Ubuntu GNOME X11 in the VM: opens top right as a rounded card, stars pin live, the window reorders live, closes on Esc, the × button and a click elsewhere): *Open Votive window* is the first control row (and a plain click on the tray icon opens it on desktops that send one; GNOME opens the menu instead). It is a small popup like the Mac's dropdown: the title, **plan usage as real progress bars** (green, orange over 70%, red from 90%), the sessions with the **same shape and colour per state as the Mac** (dot, square, triangle, diamond, pause bars, cross, ring), the prompt and age, a star to pin a session, the summary line, a Report button and a Keep awake switch. Clicking a row goes to its terminal; Esc or the close button closes it; on X11 it also closes when you click elsewhere. It follows the system light or dark theme and updates live while open. It is drawn by an **optional helper**, `linux/ui/votive-window.py`, which needs only python3 with GTK 3 (`python3-gi`, `gir1.2-gtk-3.0`: Ubuntu's desktop has both). It draws nothing with cairo (Ubuntu's desktop has `python3-gi` but not `python3-gi-cairo`; the first version failed on the real desktop with "Couldn't find foreign struct converter for 'cairo.Context'" while the container, which had that package, passed): the state shapes arrive as PNGs the tray already draws, and the card and bars are CSS. The container image of `Scripts/test-linux-ui.sh` now matches a stock desktop on purpose. The tray starts it, sends the state as one JSON line on its standard input and reads back only `focus`, `pin`, `report` and `closed` (anything else is dropped); the helper has no network or program-running code, reads nothing else and writes nothing (a test reads its imports and calls). Without GTK the row says what to install and the tray menu still works. On Wayland a window cannot choose its place, so the desktop decides (GNOME put it at the top left; seen rendering natively there); on X11 it opens top right under the panel. `Scripts/test-linux-ui.sh` draws the real helper on a virtual display in a container, clicks a row and a star, redraws it with a new state, presses Esc and keeps light and dark screenshots.

**Votive Dots window** (2026-11-11; the counterpart of the Mac's Votive window; seen working on real Ubuntu GNOME in both X11 and Wayland sessions, and in a container in both themes): *Open Votive Dots…* in the menu opens a normal window with a sidebar: **Overview** (plan usage bars, the sessions with their pictures, ★ to pin, click to go to the terminal, Keep awake, Open report), **Forecast** (the model's weekly forecast with its range, the plain sentences, the pacing advice and the model's own self-test), **Habits** (a weekday and a weekend heat map of the hours you use your plan, plus the sentences about when), **History** (the highest weekly reading each day and the points used each day, last 14 days), **Dot order** (drag a row or use the arrows; the same rules as *Move earlier / later*, a row only moves inside its group), the settings pages **General** (colorblind shapes, the limit flag, **Dot colours**, CPU heat warning and its line, Ports), **Alerts**, **Sounds**, and **Agents & tools** (which agents are found on this computer). At the foot of the sidebar is the **insights card**: ranked, plain-language things worth knowing (sessions that need you, a limit close to full, the forecast, a hot CPU), critical first, at most six, one action each, turning every 6 s (not while the pointer is over it). The old popup is still there as *Quick view*. It is `linux/ui/votive-main.py` (python3-gi only, no cairo: bars and the heat map are boxes styled with CSS) and `linux/mainwindow.js`; the data is `linux/mainstate.js` (pure, tested). The window computes nothing and writes nothing: every change it makes is sent to the tray as one JSON line that the tray checks (only known settings, values that fit, session keys that exist) before it acts. `Scripts/test-linux-main-ui.sh` renders it in a container, clicks a switch and a row and drags a row. Seen on the real desktop: opening it from the tray menu, switching a setting (the setting file changed and changed back), moving a session with the arrows and by dragging (the tray order changed).

**CPU heat warning** (2026-11-11, like the Mac's 1.8.1): off by default (*Settings → Warn when the CPU is hot*); while on, the tray reads the hottest CPU sensor every 5 s from `/sys/class/hwmon` (coretemp, k10temp, zenpower, cpu_thermal, ...) or CPU-like thermal zones, without root, in memory only. At the line (95 °C by default, 70 to 110) the icon gets the red badge that a plan limit gets, the tooltip says "CPU 97°", the menu gets a line under a divider, and it stays on until 3 °C below. A machine with no sensor says so in that line. Not checked on real hardware (the VM has no sensors): the reading is tested against made-up `/sys` trees.

**Dot colours** (2026-11-11): the Mac's three sets (Default, Colorblind friendly, High contrast) in *General → Dot colours*, kept in `~/.votive/linux-prefs.json`. They colour the tray icon, the menu pictures and the window. Coloured emoji cannot be recoloured, so a non-default set uses the drawn row of dots instead of GNOME's text label. Seen on the real desktop (green became teal).

**Votive report** (the Linux stand-in for the Mac's Votive window; seen working in the VM's Firefox): *Open Votive report…* writes one self-contained page, `~/Votive/report.html` (a visible folder on purpose: Ubuntu's snap Firefox is not allowed to read hidden folders, seen as "Access to the file was denied"), and opens it in a browser. It shows the sessions (★ high priority first, then needs-you), plan usage bars, and the forecast, habits and pacing text from the same scripts the Mac window uses. The page has no script, image or link, a Content-Security-Policy that forbids any request, and every piece of text from another program is escaped. It is a snapshot: choose the row again to refresh.

**Opening things from the service**: the tray runs with `NoNewPrivileges`, and a process that inherits it cannot start a snap application (Ubuntu's Firefox says "snap-confine ... cannot continue"). So every "open this" action starts its program through the user's systemd manager (`systemd-run --user --collect --no-block`, desktop variables passed on), and the report opens a browser directly (`x-www-browser`, then the usual ones) because the desktop's HTML handler can be a text editor.

Mac menu items **not built on Linux yet:** Ports *Add port* (a tray cannot ask for text: use Edit ports file). Everything else of the Mac menu has a Linux counterpart.

## Known limits to say out loud
- The window is a snapshot for the report only: *Open Votive Dots report…* writes a local page and opens it in a browser (not live). The window itself (*Open Votive Dots…*) is live.
- A Node tray idles at about 55 to 60 MB resident (measured in the Ubuntu VM on Node 18, 0.4% of one CPU with the icon pulsing; on Node 22 with six sessions 60 MB), against 15 to 25 MB for the Mac app.
- Wayland does not let one app raise another's window; the extension or KDE scripting is the only way. "Go to terminal" works on X11 with
  `wmctrl` (or `xdotool`) installed, raises a window rather than a tab, and is greyed out otherwise.
- Sounds play through `canberra-gtk-play`, `paplay` or `pw-play` if one is installed; the Mac's sound names map to the freedesktop sound theme.
  The notification pop-up setting of the Mac app shares the banner setting here.
- Not built: *Add port* (use Edit ports file) and any live window.

## Installing (once it is released)
From the download (`Votive-Dots-<version>-linux.tar.gz`, built by `./Scripts/make-linux-release.sh`, see its `INSTALL.txt`), or from a checkout:
```sh
./linux/install.sh             # copies the tray to ~/.local/share/votive, wires the agents, starts a systemd user service
./linux/install.sh --remove
node Scripts/doctor.js         # checks the install, the service and whether a tray host is running
node linux/votive-tray.js --print    # what the tray would show right now, as JSON
```

## Checking it
```sh
./Scripts/test-linux.sh        # the whole Node suite in a throwaway Debian container (Docker needed); installs `dbus` there for the bus tests
```

#!/usr/bin/env python3
# Votive Dots for Linux: the popup window (the counterpart of the Mac's menu-bar dropdown).
#
# It is a small, optional helper that the tray program starts when you ask for the window. It needs only what Ubuntu's desktop already has
# (python3 with GTK 3: packages python3-gi and gir1.2-gtk-3.0). It has no network code: it draws what the tray sends it and tells the tray what you clicked.
#
#   in  (standard input, one JSON object per line):  {"t":"state", ...}  what to show;  {"t":"present"}  bring the window forward;  {"t":"close"}
#   out (standard output, one JSON object per line): {"t":"focus","key":..}  {"t":"pin","key":..}  {"t":"report"}  {"t":"keepawake"}  {"t":"closed"}
#
# It reads nothing else, writes nothing to disk, and never runs a program. Text it shows comes from the tray (which cleaned it); it is set as plain text, never as markup.
# It draws nothing itself: the state shapes arrive as small PNG pictures from the tray (so it does not need python3-gi-cairo, which Ubuntu's desktop does not install), the card
# and the bars are styled with CSS.
import base64
import json
import os
import sys
import threading

import gi
gi.require_version('Gtk', '3.0')
gi.require_version('Gdk', '3.0')
from gi.repository import Gdk, GdkPixbuf, GLib, Gtk, Pango  # noqa: E402

WIDTH = 380
MAX_LINE = 256 * 1024

CSS = b"""
window.votive { background-color: @theme_bg_color; border-radius: 14px; border: 1px solid alpha(@theme_fg_color, 0.18); }
.votive .head { font-weight: 700; font-size: 15px; }
.votive .dim { color: alpha(@theme_fg_color, 0.62); }
.votive .small { font-size: 12px; }
.votive .section { font-size: 11px; font-weight: 700; color: alpha(@theme_fg_color, 0.55); letter-spacing: 0.5px; }
.votive .name { font-weight: 700; }
.votive .row { padding: 8px 10px; border-radius: 10px; margin: 1px 0; }
.votive .row:hover { background-color: alpha(@theme_fg_color, 0.08); }
.votive .star { color: #eab308; }
.votive progressbar trough { min-height: 8px; border-radius: 4px; background-color: alpha(@theme_fg_color, 0.14); }
.votive progressbar progress { min-height: 8px; border-radius: 4px; background-image: none; background-color: #30d158; border: none; }
.votive progressbar.warn progress { background-color: #ff9f0a; }
.votive progressbar.hot progress { background-color: #ff453a; }
.votive button.flat { padding: 3px 9px; border-radius: 7px; }
"""


def picture(png_b64, size=20):
    """One state's picture, from the PNG the tray sent (base64). Returns a Gtk.Image, or an empty spacer when it cannot be read."""
    try:
        loader = GdkPixbuf.PixbufLoader.new_with_type('png')
        loader.write(base64.b64decode(png_b64))
        loader.close()
        pixbuf = loader.get_pixbuf()
        if pixbuf is not None and (pixbuf.get_width() != size or pixbuf.get_height() != size):
            pixbuf = pixbuf.scale_simple(size, size, GdkPixbuf.InterpType.HYPER)
        return Gtk.Image.new_from_pixbuf(pixbuf)
    except Exception:
        spacer = Gtk.Box()
        spacer.set_size_request(size, size)
        return spacer


def label(text, css=None, ellipsize=False, lines=1, xalign=0.0):
    lab = Gtk.Label(label=str(text))  # plain text: never parsed as markup
    lab.set_use_markup(False)
    lab.set_xalign(xalign)
    if css:
        for c in css.split():
            lab.get_style_context().add_class(c)
    if ellipsize:
        lab.set_ellipsize(Pango.EllipsizeMode.END)
        lab.set_max_width_chars(44)
    lab.set_lines(lines)
    return lab


class VotiveWindow(Gtk.Window):
    def __init__(self):
        super().__init__(title='Votive Dots')
        self.set_default_size(WIDTH, 120)
        self.set_resizable(False)
        self.set_decorated(False)
        self.set_skip_taskbar_hint(True)
        self.set_keep_above(True)
        self.set_type_hint(Gdk.WindowTypeHint.DIALOG)
        self.set_border_width(0)
        screen = self.get_screen()
        visual = screen.get_rgba_visual()
        if visual is not None and screen.is_composited():
            self.set_visual(visual)   # lets the rounded corners show; the CSS paints the card itself
        self.get_style_context().add_class('votive')
        provider = Gtk.CssProvider()
        provider.load_from_data(CSS)
        Gtk.StyleContext.add_provider_for_screen(screen, provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)
        self.state = {}
        self.shown_json = None
        self.opened_at = GLib.get_monotonic_time()
        self.root = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=0)
        self.root.set_margin_top(14)
        self.root.set_margin_bottom(12)
        self.root.set_margin_start(14)
        self.root.set_margin_end(14)
        self.add(self.root)
        self.connect('key-press-event', self.on_key)
        self.connect('delete-event', self.on_delete)
        self.connect('focus-out-event', self.on_focus_out)
        self.connect('button-press-event', self.on_background_press)
        self.add_events(Gdk.EventMask.BUTTON_PRESS_MASK)

    # ---- output to the tray
    def send(self, obj):
        try:
            sys.stdout.write(json.dumps(obj) + '\n')
            sys.stdout.flush()
        except Exception:
            Gtk.main_quit()

    # ---- events
    def on_key(self, widget, event):
        if event.keyval == Gdk.KEY_Escape:
            self.close_window()
            return True
        return False

    def on_delete(self, widget, event):
        self.send({'t': 'closed'})
        Gtk.main_quit()
        return False

    def close_window(self):
        self.send({'t': 'closed'})
        Gtk.main_quit()

    def on_focus_out(self, widget, event):
        # a popup closes when you click elsewhere; on Wayland a window cannot tell reliably, so there it stays until Esc or the close button
        if os.environ.get('GDK_BACKEND') == 'wayland' or os.environ.get('WAYLAND_DISPLAY') and not os.environ.get('DISPLAY'):
            return False
        if (GLib.get_monotonic_time() - self.opened_at) < 700000:
            return False
        self.close_window()
        return False

    def on_background_press(self, widget, event):
        if event.button == 1:
            self.begin_move_drag(1, int(event.x_root), int(event.y_root), event.time)
        return False

    # ---- content
    def present_window(self):
        self.show_all()
        self.present()
        self.place()

    def place(self):
        """Top right, just under the panel, on a desktop that lets a window choose its place (X11). Elsewhere the desktop decides."""
        try:
            display = Gdk.Display.get_default()
            monitor = display.get_primary_monitor() or display.get_monitor(0)
            area = monitor.get_workarea()
            w, h = self.get_size()
            self.move(area.x + area.width - w - 12, area.y + 8)
        except Exception:
            pass

    def rebuild(self, st):
        for child in self.root.get_children():
            self.root.remove(child)
        icons = st.get('icons') or {}

        head = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        head.pack_start(label(st.get('title') or 'Votive Dots', 'head'), True, True, 0)
        close = Gtk.Button.new_from_icon_name('window-close-symbolic', Gtk.IconSize.BUTTON)
        close.set_relief(Gtk.ReliefStyle.NONE)
        close.set_tooltip_text('Close')
        close.connect('clicked', lambda b: self.close_window())
        head.pack_end(close, False, False, 0)
        self.root.pack_start(head, False, False, 0)

        usage = st.get('usage') or []
        if usage:
            self.root.pack_start(label('PLAN USAGE', 'section'), False, False, 0)
            self.root.get_children()[-1].set_margin_top(10)
            self.root.get_children()[-1].set_margin_bottom(4)
            for u in usage:
                box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=3)
                top = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
                top.pack_start(label(u.get('name', ''), 'name'), False, False, 0)
                top.pack_end(label('%d%%' % int(u.get('pct', 0)), 'name'), False, False, 0)
                box.pack_start(top, False, False, 0)
                bar = Gtk.ProgressBar()
                bar.set_fraction(max(0.0, min(1.0, float(u.get('pct', 0)) / 100.0)))
                pct = float(u.get('pct', 0))
                bar.get_style_context().add_class('hot' if pct >= 90 else 'warn' if pct > 70 else 'ok')
                box.pack_start(bar, False, False, 0)
                if u.get('resets'):
                    box.pack_start(label('resets ' + str(u.get('resets')), 'dim small'), False, False, 0)
                box.set_margin_bottom(8)
                self.root.pack_start(box, False, False, 0)

        sessions = st.get('sessions') or []
        title = 'SESSIONS' if sessions else 'NO AGENT SESSIONS'
        self.root.pack_start(label(title, 'section'), False, False, 0)
        self.root.get_children()[-1].set_margin_top(8)
        self.root.get_children()[-1].set_margin_bottom(4)
        for s in sessions[:12]:
            ev = Gtk.EventBox()
            ev.get_style_context().add_class('row')
            ev.set_visible_window(True)
            ev.add_events(Gdk.EventMask.BUTTON_PRESS_MASK | Gdk.EventMask.ENTER_NOTIFY_MASK | Gdk.EventMask.LEAVE_NOTIFY_MASK)
            row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=10)
            row.set_margin_top(7)
            row.set_margin_bottom(7)
            row.set_margin_start(8)
            row.set_margin_end(4)
            dot = picture(icons.get(s.get('state'), ''))
            dot.set_valign(Gtk.Align.START)
            dot.set_margin_top(2)
            row.pack_start(dot, False, False, 0)
            col = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=1)
            line1 = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
            line1.pack_start(label(s.get('name', ''), 'name', ellipsize=True), False, False, 0)
            line1.pack_start(label(str(s.get('agent', '')) + ' · ' + str(s.get('label', '')), 'dim small'), False, False, 0)
            col.pack_start(line1, False, False, 0)
            sub = (('“' + str(s['prompt']) + '”  ·  ') if s.get('prompt') else '') + str(s.get('age', ''))
            col.pack_start(label(sub, 'dim small', ellipsize=True), False, False, 0)
            row.pack_start(col, True, True, 0)
            star = Gtk.Button(label='★' if s.get('high') else '☆')
            star.set_relief(Gtk.ReliefStyle.NONE)
            star.set_tooltip_text('High priority: on' if s.get('high') else 'Make this session high priority')
            if s.get('high'):
                star.get_style_context().add_class('star')
            star.connect('clicked', lambda b, k=s.get('key'): self.send({'t': 'pin', 'key': k}))
            row.pack_end(star, False, False, 0)
            ev.add(row)
            ev.connect('button-press-event', lambda w, e, k=s.get('key'): (self.send({'t': 'focus', 'key': k}), True)[1] if e.button == 1 else False)
            ev.set_tooltip_text('Go to this session\'s terminal')
            self.root.pack_start(ev, False, False, 0)

        if st.get('summary'):
            self.root.pack_start(label(st['summary'], 'dim small'), False, False, 0)
            self.root.get_children()[-1].set_margin_top(8)
            self.root.get_children()[-1].set_margin_start(10)

        foot = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=4)
        foot.set_margin_top(10)
        for text, t in (('Report', 'report'),):
            b = Gtk.Button(label=text)
            b.get_style_context().add_class('flat')
            b.connect('clicked', lambda w, t=t: self.send({'t': t}))
            foot.pack_start(b, False, False, 0)
        if 'keepAwake' in st:
            # a switch for "keep the machine awake while agents work"; the tray owns the real state and sends it back on every refresh
            box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
            box.pack_start(label('Keep awake', 'small'), False, False, 0)
            sw = Gtk.Switch()
            sw.set_active(bool(st.get('keepAwake')))
            sw.set_valign(Gtk.Align.CENTER)
            sw.connect('notify::active', lambda w, p: self.send({'t': 'keepawake'}) if w.get_active() != bool(self.state.get('keepAwake')) else None)
            box.pack_start(sw, False, False, 0)
            foot.pack_end(box, False, False, 0)
        self.root.pack_start(foot, False, False, 0)
        self.root.show_all()
        self.resize(WIDTH, 1)

    def update(self, st):
        text = json.dumps(st, sort_keys=True)
        if text == self.shown_json:
            return
        self.shown_json = text
        self.state = st
        self.rebuild(st)


def read_input(win):
    """Reads the tray's lines on a thread and hands each to the GTK loop. The end of the input (the tray stopped) ends the window."""
    for raw in sys.stdin:
        if len(raw) > MAX_LINE:
            continue
        try:
            msg = json.loads(raw)
        except ValueError:
            continue
        if not isinstance(msg, dict):
            continue
        GLib.idle_add(handle, win, msg)
    GLib.idle_add(Gtk.main_quit)


def handle(win, msg):
    t = msg.get('t')
    if t == 'state':
        win.update(msg)
        if not win.get_visible():
            win.present_window()
    elif t == 'present':
        win.present_window()
    elif t == 'close':
        Gtk.main_quit()
    return False


def main():
    win = VotiveWindow()
    threading.Thread(target=read_input, args=(win,), daemon=True).start()
    Gtk.main()


if __name__ == '__main__':
    main()

#!/usr/bin/env python3
# Votive Dots for Linux: the main window (the counterpart of the Mac's Votive window: a sidebar with Overview, Forecast, Habits, History, Dot order, the settings
# pages and Agents & tools, and an insights card at the foot of the sidebar).
#
# Like the popup (votive-window.py) it is a small optional helper the tray starts when you ask for it. It needs only python3 with GTK 3 (python3-gi and
# gir1.2-gtk-3.0), NOT python3-gi-cairo: it draws nothing itself. Bars and the heat map are boxes styled with CSS; the state shapes arrive as PNGs from the tray.
# It has no network code. It computes nothing: the tray sends it everything to show, and it tells the tray what you changed.
#
#   in  (stdin, one JSON object per line):  {"t":"state", ...}  what to show;  {"t":"present"};  {"t":"page","id"}  show a page;  {"t":"close"}
#   out (stdout, one JSON object per line): {"t":"focus","key"}  {"t":"pin","key"}  {"t":"move","key","delta"}  {"t":"set","name","value"}  {"t":"keepawake"}
#                                           {"t":"report"}  {"t":"closed"}
#
# Text it shows comes from the tray (which cleaned it) and is set as plain text, never as markup. It writes nothing to disk and never runs a program.
import base64
import json
import os
import sys
import threading

import gi
gi.require_version('Gtk', '3.0')
gi.require_version('Gdk', '3.0')
from gi.repository import Gdk, GdkPixbuf, GLib, Gtk, Pango  # noqa: E402

MAX_LINE = 512 * 1024
PAGES = [
    ('overview', 'Overview'), ('forecast', 'Forecast'), ('habits', 'Habits'), ('history', 'History'), ('order', 'Dot order'),
    None,
    ('general', 'General'), ('alerts', 'Alerts'), ('sounds', 'Sounds'), ('agents', 'Agents & tools'),
]
TONES = {'critical': ('#ff453a', 'Needs attention'), 'warning': ('#ff9f0a', 'Worth a look'), 'info': ('#30d158', 'For your information')}
GREEN, ORANGE, RED = '#30d158', '#ff9f0a', '#ff453a'

CSS = b"""
window.votive-main { background-color: @theme_bg_color; }
.votive-main .side { background-color: alpha(@theme_fg_color, 0.045); border-right: 1px solid alpha(@theme_fg_color, 0.12); }
.votive-main .page-title { font-size: 22px; font-weight: 700; }
.votive-main .head { font-weight: 700; font-size: 15px; }
.votive-main .dim { color: alpha(@theme_fg_color, 0.62); }
.votive-main .small { font-size: 12px; }
.votive-main .section { font-size: 11px; font-weight: 700; color: alpha(@theme_fg_color, 0.55); letter-spacing: 0.5px; }
.votive-main .name { font-weight: 700; }
.votive-main .big { font-size: 40px; font-weight: 800; }
.votive-main .card { background-color: alpha(@theme_fg_color, 0.05); border-radius: 12px; border: 1px solid alpha(@theme_fg_color, 0.10); }
.votive-main .row { border-radius: 10px; }
.votive-main .row:hover { background-color: alpha(@theme_fg_color, 0.08); }
.votive-main .star { color: #eab308; }
.votive-main .mono { font-family: monospace; font-size: 12px; }
.votive-main .nav row { padding: 7px 12px; border-radius: 8px; margin: 1px 8px; }
.votive-main .nav row:selected { background-color: alpha(@theme_selected_bg_color, 0.9); color: @theme_selected_fg_color; }
.votive-main progressbar trough { min-height: 8px; border-radius: 4px; background-color: alpha(@theme_fg_color, 0.14); }
.votive-main progressbar progress { min-height: 8px; border-radius: 4px; background-image: none; background-color: #30d158; border: none; }
.votive-main progressbar.warn progress { background-color: #ff9f0a; }
.votive-main progressbar.hot progress { background-color: #ff453a; }
.votive-main .cell { border-radius: 3px; min-width: 14px; min-height: 22px; }
.votive-main .bar-col { border-radius: 4px 4px 0 0; min-width: 22px; }
.votive-main .tone-critical { border-left: 4px solid #ff453a; }
.votive-main .tone-warning { border-left: 4px solid #ff9f0a; }
.votive-main .tone-info { border-left: 4px solid #30d158; }
"""


def picture(png_b64, size=20):
    """One state's picture from the PNG the tray sent (base64); an empty spacer when it cannot be read."""
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


def label(text, css=None, wrap=False, xalign=0.0, ellipsize=False):
    lab = Gtk.Label(label=str(text))  # plain text: never parsed as markup
    lab.set_use_markup(False)
    lab.set_xalign(xalign)
    if css:
        for c in css.split():
            lab.get_style_context().add_class(c)
    if wrap:
        lab.set_line_wrap(True)
        lab.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR)
        lab.set_max_width_chars(80)
    if ellipsize:
        lab.set_ellipsize(Pango.EllipsizeMode.END)
    return lab


def vbox(spacing=0):
    return Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=spacing)


def hbox(spacing=0):
    return Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=spacing)


def colour(widget, hex_colour):
    """Paints one widget background (a bar or a heat-map cell) from CSS."""
    p = Gtk.CssProvider()
    p.load_from_data(('* { background-color: %s; background-image: none; }' % hex_colour).encode())
    widget.get_style_context().add_provider(p, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)


def pct_class(pct):
    return 'hot' if pct >= 90 else 'warn' if pct > 70 else 'ok'


def bar(pct):
    b = Gtk.ProgressBar()
    b.set_fraction(max(0.0, min(1.0, float(pct) / 100.0)))
    b.get_style_context().add_class(pct_class(float(pct)))
    return b


def card(child, tone=None, pad=14):
    box = vbox()
    box.get_style_context().add_class('card')
    if tone:
        box.get_style_context().add_class('tone-' + tone)
    child.set_margin_top(pad)
    child.set_margin_bottom(pad)
    child.set_margin_start(pad + 2)
    child.set_margin_end(pad + 2)
    box.pack_start(child, True, True, 0)
    return box


def blank_page(title):
    page = vbox(12)
    page.set_margin_top(22)
    page.set_margin_bottom(22)
    page.set_margin_start(28)
    page.set_margin_end(28)
    page.pack_start(label(title, 'page-title'), False, False, 0)
    return page


class MainWindow(Gtk.Window):
    def __init__(self):
        super().__init__(title='Votive Dots')
        self.set_default_size(980, 640)
        self.set_size_request(760, 480)
        self.get_style_context().add_class('votive-main')
        provider = Gtk.CssProvider()
        provider.load_from_data(CSS)
        Gtk.StyleContext.add_provider_for_screen(self.get_screen(), provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)
        self.state = {}
        self.pages = {}          # page id -> (json it was built from, widget)
        self.insight_index = 0
        self.insight_hover = False
        self.quiet = False       # true while the window itself sets a control, so that does not count as a change from the person
        self.connect('delete-event', self.on_delete)
        self.connect('key-press-event', self.on_key)

        root = hbox()
        self.add(root)
        side = vbox()
        side.set_size_request(250, -1)
        side.set_hexpand(False)
        side.get_style_context().add_class('side')
        root.pack_start(side, False, False, 0)
        brand = label('Votive Dots', 'head')
        brand.set_margin_top(16)
        brand.set_margin_bottom(10)
        brand.set_margin_start(18)
        side.pack_start(brand, False, False, 0)
        self.nav = Gtk.ListBox()
        self.nav.set_selection_mode(Gtk.SelectionMode.SINGLE)
        self.nav.get_style_context().add_class('nav')
        self.nav.set_header_func(self.nav_header)
        self.nav_rows = {}
        for entry in PAGES:
            if entry is None:
                continue
            pid, title = entry
            row = Gtk.ListBoxRow()
            row.add(label(title))
            row.page_id = pid
            self.nav.add(row)
            self.nav_rows[pid] = row
        self.nav.connect('row-selected', self.on_nav)
        side.pack_start(self.nav, True, True, 0)
        self.insight_box = vbox()
        self.insight_box.set_margin_start(12)
        self.insight_box.set_margin_end(12)
        self.insight_box.set_margin_bottom(12)
        side.pack_end(self.insight_box, False, False, 0)

        self.stack = Gtk.Stack()
        self.stack.set_transition_type(Gtk.StackTransitionType.CROSSFADE)
        self.stack.set_transition_duration(120)
        root.pack_start(self.stack, True, True, 0)
        self.nav.select_row(self.nav_rows['overview'])
        GLib.timeout_add_seconds(6, self.rotate_insight)

    def nav_header(self, row, before):
        if row.page_id == 'general' and before is not None:
            row.set_header(Gtk.Separator())
            row.get_header().set_margin_top(6)
            row.get_header().set_margin_bottom(6)

    # ---- output to the tray
    def send(self, obj):
        try:
            sys.stdout.write(json.dumps(obj) + '\n')
            sys.stdout.flush()
        except Exception:
            Gtk.main_quit()

    def on_delete(self, widget, event):
        self.send({'t': 'closed'})
        Gtk.main_quit()
        return False

    def on_key(self, widget, event):
        if event.keyval == Gdk.KEY_Escape:
            self.send({'t': 'closed'})
            Gtk.main_quit()
            return True
        return False

    def on_nav(self, box, row):
        if row is not None:
            self.show_page(row.page_id)

    def show_page(self, pid):
        self.ensure_page(pid)
        if pid in self.pages:
            self.stack.set_visible_child_name(pid)
        row = self.nav_rows.get(pid)
        if row is not None and self.nav.get_selected_row() is not row:
            self.nav.select_row(row)

    # ---- state
    def update(self, st):
        self.state = st
        self.build_insights()
        current = self.stack.get_visible_child_name() or 'overview'
        for pid in list(self.pages):
            self.ensure_page(pid)
        self.ensure_page(current)
        self.stack.set_visible_child_name(current)

    def ensure_page(self, pid):
        """Builds a page from the current state; rebuilds it only when what it shows changed."""
        if not self.state:
            return
        data = self.page_data(pid)
        text = json.dumps(data, sort_keys=True)
        old = self.pages.get(pid)
        if old and old[0] == text:
            return
        scroll = None
        if old:
            adj = old[1].get_vadjustment()
            scroll = adj.get_value()
            self.stack.remove(old[1])
        widget = Gtk.ScrolledWindow()
        widget.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
        self.quiet = True
        try:
            widget.add(getattr(self, 'build_' + (pid if pid in ('overview', 'forecast', 'habits', 'history', 'order', 'agents') else 'settings'))(pid))
        finally:
            self.quiet = False
        widget.show_all()
        self.stack.add_named(widget, pid)
        self.pages[pid] = (text, widget)
        if scroll:
            GLib.idle_add(lambda: widget.get_vadjustment().set_value(scroll) or False)

    def page_data(self, pid):
        st = self.state
        if pid == 'overview':
            return [st.get('sessions'), st.get('usage'), st.get('summary'), st.get('keepAwake'), st.get('icons')]
        if pid in ('forecast',):
            return [st.get('forecast'), st.get('usage')]
        if pid == 'habits':
            return [st.get('habits'), (st.get('forecast') or {}).get('habitLines')]
        if pid == 'history':
            return [st.get('history'), st.get('habits', {}).get('daily')]
        if pid == 'order':
            return [st.get('order'), st.get('icons')]
        if pid == 'agents':
            return [st.get('agents'), st.get('version')]
        return [p for p in (st.get('settings') or []) if p.get('id') == pid]

    # ---- pages
    def build_overview(self, pid):
        st = self.state
        page = blank_page('Overview')
        if st.get('summary'):
            page.pack_start(label(st['summary'], 'dim'), False, False, 0)
        usage = st.get('usage') or []
        if usage:
            page.pack_start(label('PLAN USAGE', 'section'), False, False, 4)
            inner = vbox(12)
            for u in usage:
                top = hbox(6)
                top.pack_start(label(u.get('name', ''), 'name'), False, False, 0)
                top.pack_end(label('%d%%' % int(u.get('pct', 0)), 'name'), False, False, 0)
                col = vbox(3)
                col.pack_start(top, False, False, 0)
                col.pack_start(bar(u.get('pct', 0)), False, False, 0)
                if u.get('resets'):
                    col.pack_start(label('resets ' + str(u['resets']), 'dim small'), False, False, 0)
                inner.pack_start(col, False, False, 0)
            page.pack_start(card(inner), False, False, 0)
        sessions = st.get('sessions') or []
        page.pack_start(label('SESSIONS' if sessions else 'NO AGENT SESSIONS', 'section'), False, False, 4)
        icons = st.get('icons') or {}
        for s in sessions:
            page.pack_start(self.session_row(s, icons), False, False, 0)
        if not sessions:
            page.pack_start(label('When an agent starts, its dot appears here and in the system tray.', 'dim', wrap=True), False, False, 0)
        foot = hbox(8)
        report = Gtk.Button(label='Open report')
        report.connect('clicked', lambda b: self.send({'t': 'report'}))
        foot.pack_start(report, False, False, 0)
        if 'keepAwake' in st:
            box = hbox(6)
            box.pack_start(label('Keep awake', 'small'), False, False, 0)
            sw = Gtk.Switch()
            sw.set_active(bool(st.get('keepAwake')))
            sw.set_valign(Gtk.Align.CENTER)
            sw.connect('notify::active', lambda w, p: (not self.quiet) and self.send({'t': 'keepawake'}))
            box.pack_start(sw, False, False, 0)
            foot.pack_end(box, False, False, 0)
        foot.set_margin_top(8)
        page.pack_start(foot, False, False, 0)
        return page

    def session_row(self, s, icons):
        ev = Gtk.EventBox()
        ev.get_style_context().add_class('row')
        ev.add_events(Gdk.EventMask.BUTTON_PRESS_MASK)
        row = hbox(10)
        row.set_margin_top(8)
        row.set_margin_bottom(8)
        row.set_margin_start(10)
        row.set_margin_end(6)
        dot = picture(icons.get(s.get('state'), ''))
        dot.set_valign(Gtk.Align.START)
        dot.set_margin_top(2)
        row.pack_start(dot, False, False, 0)
        col = vbox(1)
        line1 = hbox(6)
        line1.pack_start(label(s.get('name', ''), 'name', ellipsize=True), False, False, 0)
        line1.pack_start(label(str(s.get('agent', '')) + ' · ' + str(s.get('label', '')), 'dim small'), False, False, 0)
        col.pack_start(line1, False, False, 0)
        sub = (('“' + str(s['prompt']) + '”  ·  ') if s.get('prompt') else '') + str(s.get('age', ''))
        col.pack_start(label(sub, 'dim small', ellipsize=True), False, False, 0)
        if s.get('cwd'):
            col.pack_start(label(s['cwd'], 'dim small mono', ellipsize=True), False, False, 0)
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
        ev.set_tooltip_text("Go to this session's terminal")
        return ev

    def build_forecast(self, pid):
        fc = self.state.get('forecast') or {}
        page = blank_page('Forecast')
        if fc.get('has'):
            inner = vbox(8)
            top = hbox(14)
            top.pack_start(label('%d%%' % fc['projected'], 'big'), False, False, 0)
            side = vbox(2)
            side.set_valign(Gtk.Align.CENTER)
            side.pack_start(label('expected at the weekly reset' + ((' (' + fc['resets'] + ')') if fc.get('resets') else ''), 'dim'), False, False, 0)
            if fc.get('low') is not None:
                side.pack_start(label('likely between %d%% and %d%%' % (fc['low'], fc['high']), 'dim small'), False, False, 0)
            side.pack_start(label('now %d%%, your target is %d%%' % (fc['used'], fc['target']), 'dim small'), False, False, 0)
            top.pack_start(side, False, False, 0)
            inner.pack_start(top, False, False, 0)
            inner.pack_start(bar(fc['projected']), False, False, 0)
            page.pack_start(card(inner), False, False, 0)
        else:
            page.pack_start(card(label('No forecast yet. It starts after a few days of usage history; there is nothing to configure.', 'dim', wrap=True)), False, False, 0)
        for line in fc.get('lines') or []:
            page.pack_start(label('•  ' + line, wrap=True), False, False, 0)
        if fc.get('pacing'):
            page.pack_start(label('PACING ADVICE', 'section'), False, False, 6)
            page.pack_start(card(label(fc['pacing'], 'mono', wrap=True)), False, False, 0)
        if fc.get('samples'):
            page.pack_start(label('Based on %d samples over %d whole days. A small statistical model of your own usage history, not a neural network. It runs on this computer.' % (fc['samples'], fc.get('daysSeen', 0)), 'dim small', wrap=True), False, False, 6)
        return page

    def build_habits(self, pid):
        hb = self.state.get('habits') or {}
        page = blank_page('Habits')
        peak = float(hb.get('peak') or 0.0001)
        for title, key in (('WEEKDAYS', 'weekday'), ('WEEKEND', 'weekend')):
            page.pack_start(label(title + ' · average points of your weekly limit used in each hour', 'section'), False, False, 4)
            grid = hbox(2)
            for hour, value in enumerate(hb.get(key) or [0] * 24):
                col = vbox(2)
                cell = Gtk.Box()
                cell.get_style_context().add_class('cell')
                share = max(0.0, min(1.0, float(value) / peak))
                colour(cell, 'rgba(48,209,88,%.2f)' % (0.10 + 0.90 * share) if share > 0 else 'rgba(128,128,128,0.18)')
                cell.set_tooltip_text('%02d:00  %.1f points' % (hour, float(value)))
                col.pack_start(cell, False, False, 0)
                col.pack_start(label('%d' % hour if hour % 3 == 0 else ' ', 'dim small', xalign=0.5), False, False, 0)
                grid.pack_start(col, True, True, 0)
            page.pack_start(card(grid, pad=10), False, False, 0)
        lines = (self.state.get('forecast') or {}).get('habitLines') or []
        for line in lines:
            page.pack_start(label('•  ' + line, wrap=True), False, False, 0)
        if not lines and not any(hb.get('weekday') or []) and not any(hb.get('weekend') or []):
            page.pack_start(label('No usage history yet. It starts after the next status-line refresh of an agent that reports plan usage.', 'dim', wrap=True), False, False, 0)
        return page

    def column_chart(self, rows, value_key, unit, full):
        """Fourteen columns; a box per day, as tall as its value. No drawing code: a fixed-height strip with the box aligned to the bottom."""
        wrap = hbox(6)
        for r in rows:
            val = r.get(value_key)
            col = vbox(3)
            strip = Gtk.Box()
            strip.set_size_request(26, 120)
            col.pack_start(label('' if val is None else ('%d%s' % (round(val), unit)), 'dim small', xalign=0.5), False, False, 0)
            if val is not None and val > 0:
                column = Gtk.Box()
                column.get_style_context().add_class('bar-col')
                colour(column, GREEN if val < full * 0.7 else ORANGE if val < full * 0.9 else RED)
                column.set_size_request(22, max(4, int(110 * min(1.0, float(val) / full))))
                column.set_valign(Gtk.Align.END)
                column.set_halign(Gtk.Align.CENTER)
                strip.pack_end(column, True, True, 0)
            col.pack_start(strip, False, False, 0)
            col.pack_start(label(r.get('label', ''), 'dim small', xalign=0.5), False, False, 0)
            wrap.pack_start(col, True, True, 0)
        return wrap

    def build_history(self, pid):
        page = blank_page('History')
        history = self.state.get('history') or []
        page.pack_start(label('HIGHEST WEEKLY USAGE EACH DAY · last 14 days', 'section'), False, False, 4)
        if any(r.get('pct') is not None for r in history):
            page.pack_start(card(self.column_chart(history, 'pct', '%', 100.0), pad=12), False, False, 0)
        else:
            page.pack_start(label('No history yet.', 'dim'), False, False, 0)
        daily = (self.state.get('habits') or {}).get('daily') or []
        if any((r.get('points') or 0) > 0 for r in daily):
            page.pack_start(label('POINTS OF THE WEEKLY LIMIT USED EACH DAY', 'section'), False, False, 10)
            top = max(float(r.get('points') or 0) for r in daily)
            page.pack_start(card(self.column_chart(daily, 'points', '', max(top, 1.0)), pad=12), False, False, 0)
        return page

    def build_order(self, pid):
        order = self.state.get('order') or []
        icons = self.state.get('icons') or {}
        page = blank_page('Dot order')
        page.pack_start(label('The order of the dots in the tray. Drag a row, or use the arrows. High-priority sessions are their own group and stay first; a row only moves inside its group.', 'dim', wrap=True), False, False, 0)
        if not order:
            page.pack_start(label('No agent sessions.', 'dim'), False, False, 0)
            return page
        lb = Gtk.ListBox()
        lb.set_selection_mode(Gtk.SelectionMode.NONE)
        lb.get_style_context().add_class('card')
        targets = [Gtk.TargetEntry.new('text/votive-key', Gtk.TargetFlags.SAME_APP, 0)]
        for i, s in enumerate(order):
            row = Gtk.ListBoxRow()
            handle = Gtk.EventBox()          # a row has no window of its own; the event box gives the drag something to start from
            handle.session_key = s['key']
            box = hbox(10)
            box.set_margin_top(8)
            box.set_margin_bottom(8)
            box.set_margin_start(12)
            box.set_margin_end(8)
            box.pack_start(label('⠿', 'dim'), False, False, 0)
            box.pack_start(picture(icons.get(s.get('state'), '')), False, False, 0)
            box.pack_start(label(('★ ' if s.get('high') else '') + s.get('name', ''), 'name'), False, False, 0)
            box.pack_start(label(s.get('agent', ''), 'dim small'), False, False, 0)
            up = Gtk.Button.new_from_icon_name('go-up-symbolic', Gtk.IconSize.BUTTON)
            up.set_relief(Gtk.ReliefStyle.NONE)
            up.set_tooltip_text('Move earlier')
            up.connect('clicked', lambda b, k=s['key']: self.send({'t': 'move', 'key': k, 'delta': -1}))
            down = Gtk.Button.new_from_icon_name('go-down-symbolic', Gtk.IconSize.BUTTON)
            down.set_relief(Gtk.ReliefStyle.NONE)
            down.set_tooltip_text('Move later')
            down.connect('clicked', lambda b, k=s['key']: self.send({'t': 'move', 'key': k, 'delta': 1}))
            box.pack_end(down, False, False, 0)
            box.pack_end(up, False, False, 0)
            handle.add(box)
            row.add(handle)
            lb.add(row)
            handle.drag_source_set(Gdk.ModifierType.BUTTON1_MASK, targets, Gdk.DragAction.MOVE)
            handle.connect('drag-data-get', self.on_drag_data_get)
            handle.drag_dest_set(Gtk.DestDefaults.ALL, targets, Gdk.DragAction.MOVE)
            handle.connect('drag-data-received', self.on_drag_data_received)
        page.pack_start(lb, False, False, 0)
        return page

    def on_drag_data_get(self, row, ctx, data, info, time):
        data.set(data.get_target(), 8, row.session_key.encode('utf-8'))

    def on_drag_data_received(self, row, ctx, x, y, data, info, time):
        try:
            key = data.get_data().decode('utf-8')
        except Exception:
            return
        order = self.state.get('order') or []
        keys = [s['key'] for s in order]
        if key in keys and row.session_key in keys and key != row.session_key:
            delta = keys.index(row.session_key) - keys.index(key)
            self.send({'t': 'move', 'key': key, 'delta': max(-20, min(20, delta))})

    def build_settings(self, pid):
        pages = [p for p in (self.state.get('settings') or []) if p.get('id') == pid]
        title = next((t for p, t in [e for e in PAGES if e] if p == pid), pid.title())
        page = blank_page(title)
        rows = pages[0]['rows'] if pages else []
        for r in rows:
            line = hbox(12)
            text = vbox(2)
            text.pack_start(label(r['label'], 'name', wrap=True), False, False, 0)
            if r.get('help'):
                text.pack_start(label(r['help'], 'dim small', wrap=True), False, False, 0)
            line.pack_start(text, True, True, 0)
            name = r['name']
            if r['type'] == 'bool':
                w = Gtk.Switch()
                w.set_active(bool(r['value']))
                w.set_valign(Gtk.Align.CENTER)
                w.connect('notify::active', lambda sw, p, n=name: (not self.quiet) and self.send({'t': 'set', 'name': n, 'value': bool(sw.get_active())}))
            elif r['type'] == 'int':
                w = Gtk.SpinButton.new_with_range(r.get('min', 0), r.get('max', 1000), 1)
                w.set_value(int(r['value']))
                w.set_valign(Gtk.Align.CENTER)
                w.connect('value-changed', lambda sp, n=name: (not self.quiet) and self.send({'t': 'set', 'name': n, 'value': int(sp.get_value())}))
            else:
                w = Gtk.ComboBoxText()
                for c in r.get('choices') or []:
                    w.append_text(c)
                try:
                    w.set_active(r['choices'].index(r['value']))
                except ValueError:
                    w.set_active(0)
                w.set_valign(Gtk.Align.CENTER)
                w.connect('changed', lambda cb, n=name: (not self.quiet) and self.send({'t': 'set', 'name': n, 'value': cb.get_active_text()}))
            line.pack_end(w, False, False, 0)
            page.pack_start(card(line, pad=10), False, False, 0)
        return page

    def build_agents(self, pid):
        page = blank_page('Agents & tools')
        page.pack_start(label('Agents Votive Dots can show. A hook (a tiny script the agent runs on each step) is what reports its state; Scripts/install-agents.js adds them, and the doctor (Scripts/doctor.js) checks them.', 'dim', wrap=True), False, False, 0)
        for a in self.state.get('agents') or []:
            line = hbox(10)
            line.pack_start(label(a.get('name', a.get('id', '')), 'name'), True, True, 0)
            line.pack_end(label('found on this computer' if a.get('detected') else 'not found', 'dim small'), False, False, 0)
            page.pack_start(card(line, pad=9), False, False, 0)
        if self.state.get('version'):
            page.pack_start(label('Votive Dots for Linux ' + str(self.state['version']), 'dim small'), False, False, 8)
        return page

    # ---- insights card (sidebar foot)
    def build_insights(self):
        for child in self.insight_box.get_children():
            self.insight_box.remove(child)
        items = self.state.get('insights') or []
        if not items:
            return
        self.insight_index = min(self.insight_index, len(items) - 1)
        it = items[self.insight_index]
        box = vbox(4)
        box.pack_start(label(TONES.get(it.get('tone'), TONES['info'])[1].upper(), 'section'), False, False, 0)
        t1 = label(it.get('title', ''), 'name', wrap=True)
        t1.set_max_width_chars(24)
        t2 = label(it.get('text', ''), 'dim small', wrap=True)
        t2.set_max_width_chars(28)
        box.pack_start(t1, False, False, 0)
        box.pack_start(t2, False, False, 0)
        row = hbox(4)
        for i in range(len(items)):
            dot = label('●' if i == self.insight_index else '○', 'dim small')
            row.pack_start(dot, False, False, 0)
        if len(items) > 1:
            nxt = Gtk.Button(label='Next')
            nxt.set_relief(Gtk.ReliefStyle.NONE)
            nxt.connect('clicked', lambda b: self.advance_insight())
            row.pack_end(nxt, False, False, 0)
        go = Gtk.Button(label='Open')
        go.set_relief(Gtk.ReliefStyle.NONE)
        go.connect('clicked', lambda b, p=it.get('page', 'overview'): self.show_page(p if p in self.nav_rows else 'overview'))
        row.pack_end(go, False, False, 0)
        box.pack_start(row, False, False, 0)
        ev = Gtk.EventBox()
        ev.add_events(Gdk.EventMask.ENTER_NOTIFY_MASK | Gdk.EventMask.LEAVE_NOTIFY_MASK)
        ev.connect('enter-notify-event', lambda w, e: setattr(self, 'insight_hover', True) or False)
        ev.connect('leave-notify-event', lambda w, e: setattr(self, 'insight_hover', False) or False)
        inner = card(box, tone=it.get('tone', 'info'), pad=10)
        ev.add(inner)
        self.insight_box.pack_start(ev, False, False, 0)
        self.insight_box.show_all()

    def advance_insight(self):
        items = self.state.get('insights') or []
        if len(items) > 1:
            self.insight_index = (self.insight_index + 1) % len(items)
            self.build_insights()

    def rotate_insight(self):
        if not self.insight_hover:
            self.advance_insight()
        return True


def read_input(win):
    """Reads the tray's lines on a thread and hands each to the GTK loop. The end of the input (the tray stopped) ends the window."""
    for raw in sys.stdin:
        if len(raw) > MAX_LINE:
            continue
        try:
            msg = json.loads(raw)
        except ValueError:
            continue
        if isinstance(msg, dict):
            GLib.idle_add(handle, win, msg)
    GLib.idle_add(Gtk.main_quit)


def handle(win, msg):
    t = msg.get('t')
    if t == 'state':
        win.update(msg)
        if not win.get_visible():
            win.show_all()
            win.present()
    elif t == 'present':
        win.show_all()
        win.present()
    elif t == 'page':
        pid = msg.get('id')
        if isinstance(pid, str) and pid in win.nav_rows:
            win.show_page(pid)
    elif t == 'close':
        Gtk.main_quit()
    return False


def main():
    win = MainWindow()
    threading.Thread(target=read_input, args=(win,), daemon=True).start()
    Gtk.main()


if __name__ == '__main__':
    main()

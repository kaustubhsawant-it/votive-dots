'use strict';
//
// com.canonical.dbusmenu: the menu a tray host (the GNOME AppIndicator extension, KDE's tray, ...) draws for a
// StatusNotifierItem. Items are plain text rows with an optional submenu; there are no custom views.
//
// A menu is a tree of nodes: { key, label, enabled?, visible?, separator?, toggle?: 'checkmark'|'radio', checked?, children?, onClick? }.
// `key` is what keeps an item's numeric id the same across rebuilds, so a menu that is open while it changes does not jump.
//
const { Variant } = require('./wire');

const IFACE = 'com.canonical.dbusmenu';
const MAX_ICON = 16384;     // bytes of PNG for one row's picture
const MAX_ITEMS = 500;      // a menu is a few dozen rows; this bounds what an unexpected caller can make us build
const MAX_LABEL = 200;

class DbusMenu {
  constructor() {
    this.ids = new Map();       // key -> id, kept across rebuilds
    this.nextId = 1;
    this.byId = new Map();      // id -> node, for the current tree
    this.root = { id: 0, children: [] };
    this.revision = 1;
    this._sig = '';
    this.onChange = null;       // called with (revision, { layout, updated, removed }) when something visible changed
    this._struct = '';          // the shape of the tree (ids, order, separators, submenus)
    this._snap = new Map();     // id -> JSON of the item's properties, to tell what changed
    this.onAboutToShow = null;  // may refresh the tree; return true when it changed
  }

  /**
   * Replaces the tree. Returns true when anything visible changed (the revision is bumped and onChange is called).
   * onChange says what kind of change it was, because tray hosts differ in how they listen: the GNOME AppIndicator extension
   * re-reads only the shape of the tree on LayoutUpdated and takes the text and state of items it already has from
   * ItemsPropertiesUpdated, so a changed label must be announced as a property change, not as a new layout.
   */
  setItems(children) {
    const byId = new Map();
    let count = 0;
    const build = (node) => {
      if (++count > MAX_ITEMS) throw new Error('menu is too large');
      if (!node.key) throw new Error('every menu item needs a key');
      let id = this.ids.get(node.key);
      if (id === undefined) {
        id = this.nextId++;
        this.ids.set(node.key, id);
      }
      const built = Object.assign({}, node, { id, children: (node.children || []).map(build) });
      byId.set(id, built);
      return built;
    };
    const root = { id: 0, children: (children || []).map(build) };
    const sig = JSON.stringify(root, (k, v) => (k === 'onClick' ? undefined : v));
    // forget ids of items that are gone for good, so the table cannot grow forever
    if (this.ids.size > 4 * MAX_ITEMS) {
      const live = new Set([...byId.values()].map((n) => n.key));
      for (const k of [...this.ids.keys()]) if (!live.has(k)) this.ids.delete(k);
    }
    this.byId = byId;
    this.root = root;
    if (sig === this._sig) return false;
    this._sig = sig;
    // what changed: the shape of the tree, or properties of items that were already there
    const struct = JSON.stringify(shape(root));
    const layout = struct !== this._struct;
    this._struct = struct;
    const snap = new Map(), updated = [], removed = [];
    for (const [id, node] of byId) {
      const p = this.props(node, []);
      const now = new Map([...p].map(([k, v]) => [k, JSON.stringify([v.sig, v.value])]));
      snap.set(id, now);
      const before = this._snap.get(id);
      if (!before) continue;                                  // a new item: the host asks for its properties itself
      const gone = [...before.keys()].filter((k) => !now.has(k));
      const differs = gone.length > 0 || [...now].some(([k, v]) => before.get(k) !== v);
      if (differs) {
        // only the properties that changed: a host that sees "children-display" again may rebuild the row and close its open submenu
        updated.push([id, new Map([...p].filter(([k]) => before.get(k) !== now.get(k)))]);
        if (gone.length) removed.push([id, gone]);
      }
    }
    this._snap = snap;
    this.revision++;
    if (this.onChange) this.onChange(this.revision, { layout, updated, removed });
    return true;
  }

  // ---------- properties of one item, as the protocol names them ----------

  props(node, names) {
    const all = {};
    if (node.id === 0) { all['children-display'] = new Variant('s', 'submenu'); return filter(all, names); }
    if (node.separator) all.type = new Variant('s', 'separator');
    else {
      all.label = new Variant('s', String(node.label == null ? '' : node.label).slice(0, MAX_LABEL));
      if (node.enabled === false) all.enabled = new Variant('b', false);
      if (node.icon && node.icon.length && node.icon.length <= MAX_ICON) all['icon-data'] = new Variant('ay', Buffer.from(node.icon));
      if (node.toggle) {
        all['toggle-type'] = new Variant('s', node.toggle);
        all['toggle-state'] = new Variant('i', node.checked ? 1 : 0);
      }
      if (node.children && node.children.length) all['children-display'] = new Variant('s', 'submenu');
    }
    if (node.visible === false) all.visible = new Variant('b', false);
    return filter(all, names);
  }

  /** (id, properties, children) for a node and, to `depth` levels (-1 = all), the nodes below it. */
  layout(node, depth, names) {
    const kids = depth === 0 ? [] : node.children.map((c) => new Variant('(ia{sv}av)', this.layout(c, depth - 1, names)));
    return [node.id, this.props(node, names), kids];
  }

  getLayout(parentId, depth, names) {
    const node = parentId === 0 ? this.root : this.byId.get(parentId);
    if (!node) return null;
    return [this.revision, this.layout(node, depth < 0 ? -1 : depth, names)];
  }

  // ---------- the D-Bus object ----------

  /** The interface definition for Connection.exportObject. */
  definition() {
    const find = (id) => (id === 0 ? this.root : this.byId.get(id));
    const click = (id, eventId) => {
      const node = find(id);
      if (!node) return false;
      if (eventId === 'clicked' && node.onClick && node.enabled !== false) {
        try { node.onClick(); } catch (e) { /* a failing action must not take the menu down */ }
      }
      return true;
    };
    return {
      [IFACE]: {
        methods: {
          GetLayout: { in: 'iias', out: 'u(ia{sv}av)', fn: (parent, depth, names) => {
            const r = this.getLayout(parent, depth, names);
            if (!r) throw Object.assign(new Error('no menu item ' + parent), { dbusName: 'org.freedesktop.DBus.Error.InvalidArgs' });
            return r;
          } },
          GetGroupProperties: { in: 'aias', out: 'a(ia{sv})', fn: (ids, names) => {
            const list = ids.length ? ids : [0, ...this.byId.keys()];
            return [list.map((id) => find(id)).filter(Boolean).map((n) => [n.id, this.props(n, names)])];
          } },
          GetProperty: { in: 'is', out: 'v', fn: (id, name) => {
            const n = find(id);
            const v = n && this.props(n, [name])[name];
            if (!v) throw Object.assign(new Error('no property ' + name), { dbusName: 'org.freedesktop.DBus.Error.InvalidArgs' });
            return [v];
          } },
          Event: { in: 'isvu', out: '', fn: (id, eventId) => {
            if (!click(id, eventId)) throw Object.assign(new Error('no menu item ' + id), { dbusName: 'org.freedesktop.DBus.Error.InvalidArgs' });
            return [];
          } },
          EventGroup: { in: 'a(isvu)', out: 'ai', fn: (events) => [events.filter(([id, eventId]) => !click(id, eventId)).map(([id]) => id)] },
          AboutToShow: { in: 'i', out: 'b', fn: (id) => {
            const changed = this.onAboutToShow ? !!this.onAboutToShow(id) : false;
            return [changed];
          } },
          AboutToShowGroup: { in: 'ai', out: 'aiai', fn: (ids) => {
            const changed = this.onAboutToShow ? !!this.onAboutToShow(0) : false;
            return [changed ? [0] : [], ids.filter((id) => !find(id))];
          } },
        },
        properties: {
          Version: { sig: 'u', get: () => 3 },
          TextDirection: { sig: 's', get: () => 'ltr' },
          Status: { sig: 's', get: () => 'normal' },
          IconThemePath: { sig: 'as', get: () => [] },
        },
        signals: { ItemsPropertiesUpdated: 'a(ia{sv})a(ias)', LayoutUpdated: 'ui', ItemActivationRequested: 'iu' },
      },
    };
  }
}

/** The shape of a tree: ids, order, separators and whether an item opens a submenu. Text and state are not part of it. */
function shape(node) {
  return [node.id, node.separator ? 1 : 0, node.children.map(shape)];
}

function filter(all, names) {
  if (!names || !names.length) return new Map(Object.entries(all));
  return new Map(Object.entries(all).filter(([k]) => names.includes(k)));
}

module.exports = { DbusMenu, IFACE };

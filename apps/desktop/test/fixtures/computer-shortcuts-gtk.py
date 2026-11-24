import gi
import json
import os
import signal

gi.require_version("Gtk", "3.0")
from gi.repository import Gtk, GLib

window = Gtk.Window(title="Computer shortcuts proof")
window.set_default_size(700, 600)
box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12)
box.set_border_width(16)
window.add(box)
name = Gtk.Entry()
name.get_accessible().set_name("Project name")
name.set_text("Original")
box.pack_start(name, False, False, 0)
flag = Gtk.CheckButton(label="Include details")
box.pack_start(flag, False, False, 0)
status = Gtk.Label(label="No project saved")
button = Gtk.Button(label="Save project")
box.pack_start(button, False, False, 0)
box.pack_start(status, False, False, 0)
state = {"saved": [], "text": "Original"}
sibling = Gtk.Window(title="Sibling window")
sibling.set_default_size(300, 180)
sibling_button = Gtk.Button(label="Sibling only")
sibling.add(sibling_button)
def sibling_click(_):
    state["siblingClicks"] = state.get("siblingClicks", 0) + 1
    record()
sibling_button.connect("clicked", sibling_click)
def show_sibling(*_):
    sibling.move(0, 0)
    sibling.show_all()
    return False
signal.signal(signal.SIGUSR1, lambda *_: GLib.idle_add(show_sibling))

def record():
    with open("/tmp/computer-shortcuts-state.json.tmp", "w") as stream:
        json.dump(state, stream)
    os.replace("/tmp/computer-shortcuts-state.json.tmp", "/tmp/computer-shortcuts-state.json")

def changed(entry):
    state["text"] = entry.get_text()
    record()
name.connect("changed", changed)

def save(_):
    value = name.get_text()
    state["saved"].append({"name": value, "details": flag.get_active()})
    status.set_text("Saved: " + value)
    record()
button.connect("clicked", save)
scroller = Gtk.ScrolledWindow()
scroller.get_accessible().set_name("Projects")
scroller.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
rows = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
for index in range(80):
    row = Gtk.Button(label="Project " + str(index + 1))
    row.connect("clicked", lambda control: status.set_text("Opened: " + control.get_label()))
    rows.pack_start(row, False, False, 0)
scroller.add(rows)
box.pack_start(scroller, True, True, 0)
window.connect("destroy", Gtk.main_quit)
record()
window.show_all()
Gtk.main()

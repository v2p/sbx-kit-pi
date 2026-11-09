#!/usr/bin/env python3
"""Host-only GTK review. Text is data, never markup, paths to open, or code."""

import json
import sys
import time

try:
    import gi

    gi.require_version("Gtk", "4.0")
    gi.require_version("Gdk", "4.0")
    from gi.repository import Gdk, GLib, Gtk, Pango
except (ImportError, ValueError) as error:
    print(
        "Git review requires Python PyGObject and GTK 4 "
        f"(Debian/Ubuntu: python3-gi gir1.2-gtk-4.0): {error}",
        file=sys.stderr,
    )
    raise SystemExit(2)


class ReviewWindow(Gtk.Window):
    def __init__(self, review, on_finish, timeout_seconds=120):
        super().__init__(
            title="Pi: host Git commit dry run" if review["dryRun"] else "Pi: approve host Git commit"
        )
        self.set_default_size(1000, 750)
        self.result = None
        self.on_finish = on_finish
        self.timer = None
        self.deadline = time.monotonic() + timeout_seconds

        self.buffer = Gtk.TextBuffer()
        prefix = (
            review["summary"]
            + "\n\n--- Requested commit message (untrusted) ---\n"
            + review["message"]
            + "\n--- Staged diff (untrusted) ---\n"
        )
        self.buffer.set_text(prefix + review["diff"])
        tags = {
            "file": self.buffer.create_tag("file", weight=Pango.Weight.BOLD),
            "hunk": self.buffer.create_tag(
                "hunk", foreground="#0550ae", paragraph_background="#ddf4ff"
            ),
            "addition": self.buffer.create_tag(
                "addition", foreground="#116329", paragraph_background="#dafbe1"
            ),
            "deletion": self.buffer.create_tag(
                "deletion", foreground="#82071e", paragraph_background="#ffebe9"
            ),
        }
        offset = len(prefix)
        in_hunk = False
        for line in review["diff"].splitlines(keepends=True):
            style = None
            if line.startswith("diff --git "):
                in_hunk = False
                style = "file"
            elif line.startswith("@@"):
                in_hunk = True
                style = "hunk"
            elif in_hunk and line.startswith("+"):
                style = "addition"
            elif in_hunk and line.startswith("-"):
                style = "deletion"
            elif not in_hunk and line.startswith(("--- ", "+++ ", "index ")):
                style = "file"
            if style:
                self.buffer.apply_tag(
                    tags[style],
                    self.buffer.get_iter_at_offset(offset),
                    self.buffer.get_iter_at_offset(offset + len(line)),
                )
            offset += len(line)

        # A visible cursor keeps the read-only view focusable/selectable. This is
        # a normal content widget, not a titlebar/window-drag surface.
        self.view = Gtk.TextView(buffer=self.buffer)
        self.view.set_editable(False)
        self.view.set_cursor_visible(True)
        self.view.set_monospace(True)
        self.view.set_wrap_mode(Gtk.WrapMode.NONE)
        self.view.set_left_margin(12)
        self.view.set_right_margin(12)
        self.view.set_top_margin(12)
        self.view.set_bottom_margin(12)
        scroll = Gtk.ScrolledWindow(hexpand=True, vexpand=True)
        scroll.set_child(self.view)

        self.approval = Gtk.CheckButton(
            label=(
                "I approve testing host Git identity/signing without changing the repository"
                if review["dryRun"]
                else "I approve committing this staged snapshot using the repository's Git configuration"
            )
        )
        self.confirm = Gtk.Button(label="Test" if review["dryRun"] else "Commit")
        self.confirm.set_sensitive(False)
        self.confirm.add_css_class("suggested-action")
        self.approval.connect(
            "toggled", lambda checkbox: self.confirm.set_sensitive(checkbox.get_active())
        )
        self.confirm.connect("clicked", self.approve)
        cancel = Gtk.Button(label="Cancel")
        cancel.connect("clicked", lambda _button: self.finish(1))
        buttons = Gtk.Box(spacing=8, halign=Gtk.Align.END)
        buttons.append(cancel)
        buttons.append(self.confirm)
        footer = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12)
        for edge in ("top", "bottom", "start", "end"):
            getattr(footer, f"set_margin_{edge}")(12)
        footer.append(self.approval)
        footer.append(buttons)
        content = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
        content.append(scroll)
        content.append(footer)
        self.set_child(content)
        # Enter must not silently approve a request. Escape/closing always decline.
        self.set_default_widget(cancel)
        self.connect("close-request", self.close_requested)
        self.keys = Gtk.EventControllerKey()
        self.keys.connect("key-pressed", self.key_pressed)
        self.add_controller(self.keys)
        self.timer = GLib.timeout_add(max(1, int(timeout_seconds * 1000)), self.expire)

    def approve(self, _button):
        if time.monotonic() >= self.deadline:
            self.finish(5)
        elif self.approval.get_active():
            self.finish(0)

    def finish(self, result):
        if self.result is not None:
            return
        self.result = result
        if self.timer is not None:
            GLib.source_remove(self.timer)
            self.timer = None
        self.destroy()
        self.on_finish()

    def expire(self):
        self.timer = None
        self.finish(5)
        return GLib.SOURCE_REMOVE

    def close_requested(self, _window):
        self.finish(1)
        return True

    def key_pressed(self, _controller, keyval, _keycode, _state):
        if keyval == Gdk.KEY_Escape:
            self.finish(1)
            return True
        return False


def read_review(stream):
    # JSON escaping and visible control escapes can expand the bounded Git diff.
    maximum = 16 * 1024 * 1024
    raw = stream.read(maximum + 1)
    if len(raw) > maximum:
        raise ValueError("Git review input exceeds limit")
    review = json.loads(raw)
    if (
        not isinstance(review, dict)
        or set(review) != {"summary", "message", "diff", "dryRun"}
        or any(not isinstance(review[key], str) for key in ("summary", "message", "diff"))
        or not isinstance(review["dryRun"], bool)
    ):
        raise ValueError("Invalid Git review input")
    return review


def main():
    if sys.argv[1:] == ["--check"]:
        # Check bindings without requiring a display or opening a window.
        return 0
    if sys.argv[1:]:
        raise ValueError("Usage: git-review.py [--check]")
    review = read_review(sys.stdin.buffer)
    if not Gtk.init_check() or Gdk.Display.get_default() is None:
        raise RuntimeError("Cannot open GTK display; run sbx-pi from your host desktop session")
    loop = GLib.MainLoop()
    window = ReviewWindow(review, loop.quit)
    window.present()
    loop.run()
    return window.result if window.result is not None else 2


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        print(f"Git review: {error}", file=sys.stderr)
        sys.exit(2)

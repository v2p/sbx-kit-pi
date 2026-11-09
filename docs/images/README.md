# Documentation images

## `host-git-commit-review.png`

This is a 1200 × 1100 PNG capture of the real GTK 4 `ReviewWindow` from
`scripts/host-rpc-handlers/git-review.py`, rendered under Xvfb. It shows the
uncommitted README changes present when the host-commit feature was documented,
including additions, deletions, hunk colors and the disabled Commit button.

The diff came from `git diff --no-ext-diff --no-textconv --no-color HEAD -- README.md`.
The summary and proposed message were preview labels supplied directly to the
widget, not a live commit request. No files were staged, no Git commit handler
was invoked, and no commit/signing operation occurred.

To refresh safely, use the Python/GTK and Xvfb dependencies listed in
[Development](../development.md#host-git-review-checks). Import `git-review.py`
with `importlib.util` without calling its `main`, construct `ReviewWindow` with a
preview payload (`summary`, `message`, `diff`, `dryRun: False`), and present it.
After layout, capture the widget using `Gtk.WidgetPaintable`, `Gtk.Snapshot`, and
the native GSK renderer's `render_texture(...).save_to_png(...)`. Use
`GDK_BACKEND=x11 GSK_RENDERER=cairo xvfb-run -a` for headless rendering and close
with `window.finish(1)` after capture. Do not check approval or invoke the real
commit handler just to take a screenshot.

Keep preview text representative, leave approval unchecked, and inspect the PNG
for secrets, private paths and rendering problems before adding it to the README.
The screenshot is documentation, not a GUI golden-file test.

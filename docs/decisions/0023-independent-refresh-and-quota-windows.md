# Independent project reads and complete quota windows

Date: 2026-10-21

## Problem

The project picker waited for every source before committing any result. A
slow official usage request therefore hid available Git, milestone, and local
task data. Main-window project usage only refreshed after observer task events,
which are not emitted by other Codex clients. The account adapter also discarded
the secondary rate-limit window, and compact English text could hide the
remaining percentage.

## Decision

- Commit each project source independently. Associate reads with a request
  identity and selected path, ignore stale results, and allow one project read
  batch at a time for the active selection.
- Refresh the viewed project every minute while visible and when returning to
  the window. Periodic reads never save workspace state or execute tests/builds.
- Keep the existing primary quota fields for compatibility and add an optional
  `secondary` window with its own percentage, period, and reset time. This is an
  additive in-memory protocol change, not a local-store migration.
- Use the smallest reported remaining percentage for the selected Codex bucket
  in compact summaries. Detailed views show both windows with their periods and
  reset times. Percentages from different windows are not summed or converted
  to a token balance; an unknown window remains unknown.
- Use separate compact label/value/meter rows. Keep the settings action bar
  outside the scroll container. Modal settings take keyboard focus, trap Tab,
  and restore focus to their trigger when closed.

## Trade-offs and verification

Polling introduces bounded additional local/API reads. Hidden windows pause
project polling; overlapping read batches are suppressed. The smallest reported
percentage is a concise warning signal, not a prediction of requests remaining.
Per-source failures retain available results and an explicit error indication.

Rust and frontend regressions cover secondary-window preservation, exhausted
weekly quota, unknown values, and rendering independent windows. Browser
verification covers delayed project usage, periodic refresh, modal keyboard
navigation, compact text, and a visible settings action. Browser results do not
validate native AppKit materials or multi-display occlusion.

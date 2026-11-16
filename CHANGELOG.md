# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Interactive viewer with folding, mouse and Vim navigation, distinct content colors, and
  lightweight highlighting of fenced code and tool arguments.
- Stream subagent thinking, text and tool calls from live events while retaining JSONL as the
  durable transcript.
- Open a saved session by ID, ID prefix or JSONL path.
- `OMP_HERDR_PANES_AUTO_CLOSE=0` keeps finished panes open until manually closed or omp exits.
- `t` toggles all thinking blocks and sets the default for new thinking.
- `/herdr-panes` controls pane creation and automatic close delays in the current OMP process.
- `/herdr-panes` offers argument completion and shows usage alongside the current settings.
- Show the resolved model on a color-coded status line and follow default/fallback model changes.

### Changed

- Run read-only viewer panes with standalone Bun so Herdr does not list them as OMP agents.
- Honor configured close delays even when other subagents are waiting for a pane.
- Merge consecutive thinking and fold consecutive tool calls with their results into counted groups.
- Pair tool calls and results by call ID in one expandable item, including out-of-order results.
- Use compact card spacing and distinguish content types with the configured ANSI colors.
- Start thinking collapsed and render without ANSI dim styling.
- Move the selected item along with Ctrl+U/Ctrl+D half-page scrolling.

### Fixed

- Start the live-event socket only when a subagent starts, so plugin installation validation can exit.

## [0.2.0] - 2026-10-04

### Added

- Pane titles get a `✓` (completed) or `✗` (failed, aborted) prefix when the subagent ends; a
  revived subagent drops the mark again.
- `OMP_HERDR_PANES_FAIL_DELAY_MS` (default `10000`): failed or aborted subagents keep their pane
  open longer than completed ones.
- Subagents beyond `OMP_HERDR_PANES_MAX` now wait for a slot and get a pane once one frees up,
  instead of never getting one.
- At the pane limit, the oldest finished pane gives up its slot right away instead of blocking a
  new subagent until its close delay runs out.
- Session summary on the last line of a pane: `■ session ended · 47.2k tok · $0.0008 · 2m13s`.
- Tool results name their tool (`✓ read  …`), so results of parallel calls can be told apart.
- `yield` calls show their status and result keys instead of raw JSON.
- Assistant turns that end with an error or abort show a red `✗ error: …` / `✗ aborted` line.

### Changed

- The `Task:` header is bold.
- After the subagent's session ends, the viewer polls the transcript every 2 s instead of every
  250 ms; it still shows anything appended later.

### Fixed

- Escape and control sequences in transcript text (tool output, model text) are stripped before
  they reach the pane, so they can no longer restyle the terminal, change its title, or write to
  the clipboard.
- Every `herdr` call is killed after 5 s. Before, a hung `herdr` stalled the pane queue for good
  and could block omp's shutdown.
- Viewers exit when the omp process is gone, so killing omp no longer leaves panes open forever.
- The lifecycle listener is registered once per event bus. Before, every subagent added another
  listener to the shared bus, so events were handled once per subagent ever spawned.
- Long assistant text is wrapped in linear time instead of quadratic.

## [0.1.0] - 2026-09-25

### Added

- First release: one read-only Herdr pane per omp subagent, stacked to the right of omp, streaming
  task, thinking, tool calls and results live, and closing a few seconds after the subagent ends.

[Unreleased]: https://github.com/OhYee/omp-herdr-panes/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/bekto/omp-herdr-panes/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/bekto/omp-herdr-panes/releases/tag/v0.1.0

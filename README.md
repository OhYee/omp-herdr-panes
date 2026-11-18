# omp-panes

Watch [omp](https://github.com/oh-my-pi) subagents work live in Herdr, Tern, or tmux panes.

When omp spawns subagents, their work normally happens out of sight: you get a progress line and,
at the end, a result. This extension gives every subagent a **read-only pane** next to your omp
pane that streams its task, thinking, tool calls, and results as they happen. A pane closes by
itself by default a few seconds after its subagent finishes, and your omp pane goes back to full width.

## What you get

- **One pane per subagent**, to the right of its own parent view. Siblings stack when the layout
  permits; nested subagents split beside the viewer that spawned them. The viewer shows
  `<name> · <agent>` and color-codes state, stream, name and model; long names are abbreviated in narrow panes.
- **Interactive transcript**: inspect full input, thinking, tool calls, tool results, errors and
  output. Expand or collapse each item and scroll without sending input to the subagent.
  Thinking, tool calls, tool results and errors start collapsed.
  Thinking uses the terminal's default foreground; input is magenta, tool calls blue, tool results
  cyan, advisor feedback bright magenta, output green, and other items yellow. Code and tool arguments
  retain syntax highlighting.
  Consecutive thinking blocks are merged. Consecutive tool calls form a collapsed `TOOLS: N`
  group. A call and its matching result share one expandable item, matched by tool call ID;
  results without an unambiguous match remain separate.
  Matching execution, stream-preview and approval events appear inside the same call; the latest
  progress and stream preview are retained. Unmatched or ambiguous events remain separate.
- **Live updates**: assistant text, thinking and tool-call snapshots stream from omp events;
  completed messages and tool results are read from the session transcript.
- **Agent messages**: incoming IRC appears as `INPUT · IRC`, with live and saved copies matched by
  message ID. Outgoing `write agent://…` messages appear as expanded `OUTPUT · IRC → recipient`
  items; progress messages and broadcasts are labeled separately. Their status reflects the tool
  outcome, not whether the recipient has read them. Press `T` to inspect the associated request,
  execution events and receipt. The text viewer also identifies matching IRC receipts.
  Background completions appear as tool results, and advisor feedback as `ADVISOR`;
  other custom messages retain their JSON fallback. Plan review requests and resolutions share a card.
- **Nested subagents too**: each viewer's children appear to its right, recursively
  (e.g. `Outer · task` → `Outer.Inner · sonic`).
- **Outcome at a glance**: the viewer shows the subagent's status, and Herdr also prefixes the
  pane title with `✓` (completed) or `✗` (failed, aborted).
- **Configurable cleanup**: by default a pane closes ~3 s after completion or ~10 s after failure.
  You can adjust the delays or keep finished panes open; exiting omp still closes its panes.
- **Stays out of your way**: keyboard focus never leaves the omp pane, and you can keep typing
  while subagents run.
- **No effect outside a supported pane**: without a Herdr, Tern, or tmux pane context, the
  extension does nothing.

The panes are read-only observers. Their keyboard controls only affect the viewer, not the subagent.

The transcript includes persisted user messages, assistant text and thinking, and tool calls and
results. Other session records, message roles, assistant blocks and live events use an expandable
JSON fallback. Live previews are bounded; oversized events show a truncation notice. If the viewer
connects late, the bridge buffers up to 512 KiB of events and reports any overflow.
Tool-approval and plan-review request/resolution hooks are shown when OMP emits them for the
subagent. The viewer is read-only: answer approval dialogs in OMP, not in a pane.

## Requirements

- [omp](https://github.com/oh-my-pi) ≥ 18.3.1
- Herdr, Tern, or tmux, with omp started inside a pane of that terminal
- [Bun](https://bun.sh) on the OMP process's `PATH` (used for the read-only pane viewer)

No `npm install` is needed at runtime. The viewer uses standalone Bun.

## Install

Link a local checkout:

```sh
omp plugin link /absolute/path/to/omp-panes
```

To expose the standalone CLI, create a symlink when `~/.local/bin/terminal-pane` is not already
in use:

```sh
ln -s ~/.omp/plugins/node_modules/omp-panes/bin/terminal-pane ~/.local/bin/terminal-pane
```

Restart omp inside a supported pane to activate it. To try it once without installing:

```sh
omp -e /absolute/path/to/omp-panes/src/index.ts
```

## Usage

Use omp normally. Whenever it runs the task tool, a pane opens for each subagent. Focus the
pane to select items with `↑`/`↓` or `j`/`k`, toggle with Enter or Space, and collapse/expand
with `h`/`l`. `Ctrl+U`/`Ctrl+D` scroll half a page and move the selection with the viewport;
`PgUp`/`PgDn` scroll a full page, and `gg`/`G` jump to the beginning/end. `f` follows the
latest output, `a` toggles all items, `t` toggles all THINK blocks, and `T` toggles all tool
groups, calls and results. The THINK and tool settings also apply to future items. The viewer
shows the session file path on the status line when space permits; status, stream, agent and model
take priority. Press `p` to copy the full path using OSC 52. The terminal must permit OSC 52
clipboard writes. The viewer reflows when its pane is resized.
You can also click an item header to toggle it or use the mouse wheel to scroll. Press
**Ctrl+C** to close the viewer.

The viewer can also open an existing OMP session independently, by ID or ID prefix:

```sh
bun /absolute/path/to/omp-panes/src/viewer.ts 01a1dfc5
```

For a custom session root, add `--session-dir /path/to/sessions`. A JSONL file path is also
accepted directly. Ambiguous or missing IDs are reported rather than silently choosing a session.
In an interactive Herdr, Tern or tmux pane, an independently started viewer opens existing and
new child sessions beside their corresponding parent viewers, recursively. It follows persisted
file updates; it cannot receive unpersisted live events without the plugin's private connection.
Closing the viewer closes the descendant panes it created. Without a supported pane or a TTY,
it still displays the transcript but does not create panes. `OMP_HERDR_PANES=0` also disables
automatic child panes for an independent viewer.

## Standalone terminal command

The package includes `bin/terminal-pane`. It opens a command in a Herdr, Tern or tmux pane
and prints a JSON object containing the backend and pane ID. Add the command to your `PATH`,
or invoke it by its absolute path.

```sh
# Split the calling pane to the right, detecting its terminal.
terminal-pane -- htop

# Create a tab in a named session/workspace, suitable for cron.
terminal-pane --backend tern --session alerts --tab incident --mode tab -- tail -f /tmp/log

# Split an existing named tab, or create the session/tab if absent.
terminal-pane --backend herdr --session daily --tab 2026-11-18 --mode right -- omp
```

Set `TERMINAL_PANE_BACKEND=tern|herdr|tmux` to choose a default backend. Without a current
terminal, select a backend and a named session explicitly. `--cwd` selects the working
directory; `--wait-output TEXT --wait-timeout SECONDS` waits for text from the new pane and
reports a timeout instead of treating pane creation as application readiness. Run
`terminal-pane --help` for all options.

## Configuration

In an OMP session running inside a supported terminal, use `/herdr-panes` to inspect and change the current
process's settings without restarting. Type `/herdr-panes ` and use the completion menu to
discover the available options; press Tab to select one. Run `/herdr-panes` without arguments to
see the current settings and a usage hint.

```text
/herdr-panes                         # show current settings
/herdr-panes disabled                # stop opening new panes
/herdr-panes enabled                 # allow new panes again
/herdr-panes auto-close disabled     # keep completed panes open
/herdr-panes auto-close enabled      # re-enable the current delays
/herdr-panes auto-close 5            # close after 5 seconds for either outcome
```

Numeric delays are in seconds and also enable auto-close. Changes are process-local: after an
OMP restart, environment variables determine the initial values again. Disabling pane creation
leaves existing panes open and drops queued pane requests. After re-enabling, subagents still active
are eligible for panes again. Changing auto-close applies to already finished panes too, counting
from when each subagent finished; an expired delay closes immediately.

### Startup environment

Set these environment variables before starting omp or an independent viewer. They are read at startup.

| Variable | Default | Meaning |
| --- | --- | --- |
| `OMP_HERDR_PANES` | `1` | `0` starts with pane creation disabled; `/herdr-panes enabled` can turn it on |
| `OMP_HERDR_PANES_AUTO_CLOSE` | `1` | `0` keeps finished panes open until manually closed or omp exits |
| `OMP_HERDR_PANES_RATIO` | `0.6` | width share kept by a parent pane (`0.2`–`0.9`); Tern uses its native split ratio |
| `OMP_HERDR_PANES_CLOSE_DELAY_MS` | `3000` | how long a pane stays open after its subagent completes |
| `OMP_HERDR_PANES_FAIL_DELAY_MS` | `10000` | how long a pane stays open after its subagent fails or is aborted |
| `OMP_HERDR_PANES_MAX` | `6` | maximum descendant panes in one tree; extra subagents wait for a slot |

An invalid value falls back to that variable's default.
The pane limit includes intermediate parents, so it must accommodate the desired nesting depth.
Closing a parent viewer also closes its descendants. Historical viewers without lifecycle events
stay open until manually closed or their parent exits.

```sh
OMP_HERDR_PANES_AUTO_CLOSE=0 omp
# Or keep successful panes for 30 seconds and failed panes for 60 seconds:
OMP_HERDR_PANES_CLOSE_DELAY_MS=30000 OMP_HERDR_PANES_FAIL_DELAY_MS=60000 omp
```

## Uninstall

- Turn it off for now: start omp with `OMP_HERDR_PANES=0`.

- Remove the link with `omp plugin uninstall omp-panes`. If configured manually, remove its
  `extensions:` entry instead. The checked-out source directory is not deleted automatically.

## Performance

- The extension adds no model calls or tokens and does not change subagent behaviour. It reads
  session headers and forwards subagent event snapshots over a private local socket.
- Pane operations run through the selected terminal's CLI, one after another, without blocking omp.
- One owner per view tree scans for child session files every second. Each open viewer tails its
  transcript, polling every 250 ms while the subagent runs and every 2 s after it ended.
  `OMP_HERDR_PANES_MAX` caps the descendant panes in that tree.

## How it works

```
omp session ── lifecycle and subagent events ──▶ src/index.ts
                                                   │
                        pane manager ── terminal CLI ──▶ pane: src/viewer.ts
                                                   │           │
                        private live-event socket ──┘           └─ follows session JSONL
```

- The extension opens sessions with task lifecycle events observed in the current omp process,
  including a completed task whose JSONL appears late; it does not reopen old subagent transcripts
  when a session is resumed. A child's `parentSession` identifies its parent even when the task
  result contains no path. An independent history viewer looks for JSONL files in each parent's
  filename-stem directory, without following symlinks; a same-directory `/branch` is not a subagent.
- The first child is split to the right of its own parent pane. Additional children stack downwards
  only when the split preserves parent-child vertical overlap; otherwise they split from the parent.
  Tern does not expose pane positions, so nested children there split from the parent. One owner
  manages the tree, preventing duplicate recursive viewers.
- Each pane runs `src/viewer.ts`. Plugin-created viewers receive temporary live snapshots over
  an authenticated Unix socket in a private directory. The file remains the source of truth;
  terminal control sequences in transcript content are stripped. Finished lifecycle events apply
  the configured close policy; closing a parent removes its descendants and pending requests.
- Pane commands are queued and run one at a time, so simultaneous subagents never race each other's
  splits. A terminal failure is logged instead of taking down the omp session.

## Troubleshooting

- **No panes appear**: check the pane identity (`TMUX_PANE`, `HERDR_PANE_ID`, or `TERN_PANE`) and
  that `OMP_HERDR_PANES` is not `0`. Also check that omp loaded the extension, or use
  `omp -e <path>/src/index.ts`.
- **I closed a pane by hand**: that's fine. The next subagent starts a fresh column.
- **Replay an old transcript** to see what a pane would show:

  ```sh
  bun /absolute/path/to/omp-panes/src/viewer.ts path/to/Subagent.jsonl --title demo
  ```

## Development

```sh
npm install                 # optional dev dependencies: typescript, @types/bun
npx tsc --noEmit            # typecheck
bun test                    # run the tests
```

| File | Role |
| --- | --- |
| `src/index.ts` | extension entry: connects lifecycle and streaming events |
| `src/config.ts` | env-var config, lifecycle payload parsing, shell quoting |
| `src/command.ts` | runtime `/herdr-panes` command parsing and status |
| `src/pane-manager.ts` | per-parent pane layout, serialized terminal calls, delayed close |
| `src/herdr.ts` | thin, typed wrapper around the `herdr` CLI |
| `src/viewer.ts` | viewer process, standalone tree ownership, transcript tailing and live socket client |
| `src/tui.ts`, `src/tui-model.ts` | interactive display, folding and transcript model |
| `src/session-file.ts`, `src/session-tree.ts` | session resolution and recursive child discovery |
| `src/live-bridge.ts`, `src/live-events.ts` | private socket and coalesced live snapshots |
| `src/render.ts` | plain output fallback and shared sanitization |
| `src/line-splitter.ts` | UTF-8-safe incremental line splitting |
| `src/omp-types.ts` | the small subset of omp's extension API this project uses |

## License

[MIT](LICENSE)

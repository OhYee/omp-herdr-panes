# omp-herdr-panes

Watch your [omp](https://github.com/oh-my-pi) subagents work live, each in its own
[Herdr](https://herdr.dev) pane.

When omp spawns subagents, their work normally happens out of sight: you get a progress line and,
at the end, a result. This extension gives every subagent a **read-only pane** next to your omp
pane that streams its task, thinking, tool calls, and results as they happen. A pane closes by
itself by default a few seconds after its subagent finishes, and your omp pane goes back to full width.

## What you get

- **One pane per subagent**, stacked in a single column to the right of omp and titled
  `<name> · <agent>`. The status line color-codes state, stream, name and model; long names are
  abbreviated in narrow panes.
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
  message ID. Background completions appear as tool results, and advisor feedback as `ADVISOR`;
  other custom messages retain their JSON fallback. Plan review requests and resolutions share a card.
- **Nested subagents too**: a subagent that spawns its own subagents gets panes for them as well
  (e.g. `Outer · task` and `Outer.Inner · sonic`).
- **Outcome at a glance**: when a subagent ends, its pane title gets a `✓` (completed) or `✗`
  (failed, aborted) prefix.
- **Configurable cleanup**: by default a pane closes ~3 s after completion or ~10 s after failure.
  You can adjust the delays or keep finished panes open; exiting omp still closes its panes.
- **Stays out of your way**: keyboard focus never leaves the omp pane, and you can keep typing
  while subagents run.
- **No effect outside Herdr**: if omp is not running inside a Herdr pane, the extension does
  nothing at all.

The panes are read-only observers. Their keyboard controls only affect the viewer, not the subagent.

The transcript includes persisted user messages, assistant text and thinking, and tool calls and
results. Other session records, message roles, assistant blocks and live events use an expandable
JSON fallback. Live previews are bounded; oversized events show a truncation notice. If the viewer
connects late, the bridge buffers up to 512 KiB of events and reports any overflow.
Tool-approval and plan-review request/resolution hooks are shown when OMP emits them for the
subagent. The viewer is read-only: answer approval dialogs in OMP, not in a pane.

## Requirements

- [omp](https://github.com/oh-my-pi) ≥ 18.3.1
- [Herdr](https://herdr.dev) ≥ 0.9.1
- omp started **inside a Herdr pane** (`echo $HERDR_PANE_ID` prints a pane id)
- [Bun](https://bun.sh) on the OMP process's `PATH` (used for the read-only pane viewer)

No `npm install` is needed. The pane viewer runs with standalone Bun so Herdr does not list it as an OMP agent.

## Install

Install directly from the maintained GitHub repository:

```sh
omp plugin install github:OhYee/omp-herdr-panes
```

For local development, link a checkout instead:

```sh
omp plugin link /absolute/path/to/omp-herdr-panes
```

Restart omp inside a Herdr pane to activate it. To try it once without installing:

```sh
omp -e /absolute/path/to/omp-herdr-panes/src/index.ts
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
bun /absolute/path/to/omp-herdr-panes/src/viewer.ts 01a1dfc5
```

For a custom session root, add `--session-dir /path/to/sessions`. A JSONL file path is also
accepted directly. Ambiguous or missing IDs are reported rather than silently choosing a session.
When opened independently, the viewer follows persisted file updates; it cannot receive
unpersisted live events unless launched by the plugin with its private event connection.

## Configuration

In an OMP session running inside Herdr, use `/herdr-panes` to inspect and change the current
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
leaves existing panes open and drops queued pane requests. Changing auto-close applies to already
finished panes too, counting from when each subagent finished; an expired delay closes immediately.

### Startup environment

Set these environment variables before starting omp. They are read once, when the extension loads.

| Variable | Default | Meaning |
| --- | --- | --- |
| `OMP_HERDR_PANES` | `1` | `0` starts with pane creation disabled; `/herdr-panes enabled` can turn it on |
| `OMP_HERDR_PANES_AUTO_CLOSE` | `1` | `0` keeps finished panes open until manually closed or omp exits |
| `OMP_HERDR_PANES_RATIO` | `0.6` | share of the width kept by the omp pane when the column opens (`0.2`–`0.9`) |
| `OMP_HERDR_PANES_CLOSE_DELAY_MS` | `3000` | how long a pane stays open after its subagent completes |
| `OMP_HERDR_PANES_FAIL_DELAY_MS` | `10000` | how long a pane stays open after its subagent fails or is aborted |
| `OMP_HERDR_PANES_MAX` | `6` | max panes open at once; extra subagents wait until a pane closes |

An invalid value falls back to that variable's default.

```sh
OMP_HERDR_PANES_AUTO_CLOSE=0 omp
# Or keep successful panes for 30 seconds and failed panes for 60 seconds:
OMP_HERDR_PANES_CLOSE_DELAY_MS=30000 OMP_HERDR_PANES_FAIL_DELAY_MS=60000 omp
```

## Uninstall

- Turn it off for now: start omp with `OMP_HERDR_PANES=0`.

- Remove the link with `omp plugin uninstall omp-herdr-panes`. If configured manually, remove its
  `extensions:` entry instead. The checked-out source directory is not deleted automatically.

## Performance

- The extension adds no model calls or tokens and does not change subagent behaviour. It reads
  the existing transcript and forwards subagent event snapshots over a private local socket.
- Opening or closing a pane runs a few short `herdr` CLI commands, one after another, without
  blocking omp. A herdr call that hangs is killed after 5 s.
- Each open pane runs one small viewer process that tails a file, polling every 250 ms while the
  subagent runs and every 2 s after it ended. `OMP_HERDR_PANES_MAX` caps how many run at once.

## How it works

```
omp session ── lifecycle and subagent events ──▶ src/index.ts
                                                   │
                        pane manager ── herdr ──▶ Herdr pane: src/viewer.ts
                                                   │           │
                        private live-event socket ──┘           └─ follows session JSONL
```

- The extension listens for omp's `task:subagent:lifecycle` events. `started` opens a pane; any
  other status (completed, failed, aborted) marks the title and schedules the close.
- The first pane is split off the omp pane to the right. Each later pane is split downwards off
  the tallest pane in the column.
- Each pane runs `src/viewer.ts`. The viewer follows the transcript and receives temporary live
  snapshots over an authenticated Unix socket in a private directory. The file remains the source
  of truth; if live events are unavailable, the viewer continues following saved entries.
  Terminal control sequences in transcript content are stripped. The viewer exits when omp exits.
- All herdr commands are queued and run one at a time, so subagents started together never race
  each other's splits. Any herdr failure is caught and skipped, so it can't take down your omp
  session.

## Troubleshooting

- **No panes appear**: in the omp pane, check that `echo $HERDR_PANE_ID` prints something and that
  `OMP_HERDR_PANES` is not `0`. Also check that omp picked up the config entry, or use
  `omp -e <path>/src/index.ts`.
- **I closed a pane by hand**: that's fine. The next subagent starts a fresh column.
- **Replay an old transcript** to see what a pane would show:

  ```sh
  bun /absolute/path/to/omp-herdr-panes/src/viewer.ts path/to/Subagent.jsonl --title demo
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
| `src/pane-manager.ts` | stacked-pane layout, serialized herdr calls, delayed close |
| `src/herdr.ts` | thin, typed wrapper around the `herdr` CLI |
| `src/viewer.ts` | viewer process, transcript tailing and live socket client |
| `src/tui.ts`, `src/tui-model.ts` | interactive display, folding and transcript model |
| `src/session-file.ts` | resolve a session ID or prefix to its transcript |
| `src/live-bridge.ts`, `src/live-events.ts` | private socket and coalesced live snapshots |
| `src/render.ts` | plain output fallback and shared sanitization |
| `src/line-splitter.ts` | UTF-8-safe incremental line splitting |
| `src/omp-types.ts` | the small subset of omp's extension API this project uses |

## License

[MIT](LICENSE)

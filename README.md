# pi-herdr-btw

A [Pi](https://pi.dev/) extension inspired by [Claude Code's `/btw`](https://code.claude.com/docs/en/interactive-mode#side-questions-with-/btw). It opens a tool-enabled side conversation in a focused [Herdr](https://github.com/ogulcancelik/herdr) pane without changing the parent transcript.

Unlike Claude Code's one-shot, tool-free overlay, this side thread runs in a separate Pi process and supports editing the initial question, tools, and follow-ups.

## Behavior

- snapshots the parent's current, compaction-aware context
- inherits its cwd, model, and thinking level
- prefills the question for review rather than submitting it
- leaves the parent session unchanged
- remains usable while the parent is working

## Requirements

- [Pi](https://pi.dev/) and [Herdr](https://herdr.dev) installed.
- Pi running in a Herdr-managed pane

## Install

```bash
pi install npm:pi-herdr-btw
```

From a checkout:

```bash
pi install /absolute/path/to/pi-herdr-btw
```

Remove any existing `~/.pi/agent/extensions/btw.ts` to avoid duplicate `/btw` commands, then restart Pi or run `/reload`.

## Usage

```text
/btw what was the most important decision in this session?
```

The new pane opens with the question ready to edit or submit. Use `/btw` alone for an empty editor.

## Caveats

The child receives a static context snapshot and does not see later parent activity. It has normal tools in the same working directory, so it can modify shared files. Very large parent contexts may exceed the child's context limit. Each side thread is a separate process and does not share the parent's prompt cache.

Launch data is stored in a private temporary directory, removed when the child exits normally, and cleaned up after 24 hours if left stale.

## Development

```bash
npm install
npm run check
npm run pack:check
```

## License

MIT

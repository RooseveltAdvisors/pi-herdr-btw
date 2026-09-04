# Vision

This is a house fork of oscabriel/pi-herdr-btw, the Pi extension that opens a tool-enabled `/btw` side conversation in a focused Herdr pane without changing the parent transcript.
Upstream owns the product; this fork owns only keeping `/btw` working on the Herdr release the fleet actually runs, for exactly as long as upstream has not.

## Why the fork exists

The fleet runs Pi inside Herdr-managed panes, so every `/btw` here goes through the launch path this extension drives: `herdr pane split` followed by `herdr agent start --kind pi --pane`.
Herdr 0.7.5 introduced a race in that path: an agent start issued immediately after the split fails with agent_pane_busy, "not an available shell", even though the same pane accepts the start about half a second later.
Upstream has tracked this as its issue 2 since July 2026, and until a fix lands there, every `/btw` on the fleet's Herdr fails at random.
The fork exists so side conversations open reliably today, and so the fix exists in a reviewed, regression-tested shape that can go upstream the moment a path opens.
It serves the operators who run Pi in Herdr-managed panes and need to ask a side question mid-task without disturbing the session they left running; it does not serve anyone running Pi outside a Herdr pane, and winning users is upstream's concern, not this fork's.

## What the fork carries beyond upstream

One fix: a classifier that recognizes the shell-not-ready failure class, and a retry of the same pane with 500ms backoff inside the existing 45-second launch budget, so the race costs a beat instead of the launch.
One proof: regression coverage that pins both the unit boundary of that decision and the exact `pane split --cwd` and `agent start` argv handed to the Herdr CLI, so a Herdr CLI change surfaces as a failing test before it surfaces as a broken `/btw`.
Nothing else: no fork-local features, no renamed commands, no divergent defaults, nothing upstream could not adopt as-is.
A fork fix must meet the same bar as an upstream fix, because for the fleet that runs it, a temporary fork is still production.

## What the fork must never diverge on

Upstream's semantics are the product and are not renegotiable here: the parent session and its transcript stay untouched, the child inherits the parent's cwd, model, tools, and thinking level by default, and merge stays a versioned, acknowledged, size-bounded handoff over the private launch directory.
The prompt-cache contract stays exactly as upstream defines it: inheriting defaults replays the parent's native message prefix so warm provider caches survive the side pane, and every override is an explicit cache-breaking choice.
The fork tracks upstream releases promptly and stays small: the moment upstream ships or merges a launch fix, this fork's reason to exist ends, and its delta must always stay small enough to retire in one rebase.

## Non-goals

- Live sync of later parent activity into the child; the child gets a static, compaction-aware snapshot by design.
- Prompt-cache guarantees across providers beyond the inherited native prefix.
- Pane or session management; Herdr owns pane lifecycle and this extension stays a guest of it.
- Any feature upstream could not merge unchanged.

## Done well in one year

The launch race is fixed in an upstream release, this fork is retired or empty, and the fleet's `/btw` works straight from the published package.
Until then, every upstream release is picked up quickly, every `/btw` launch succeeds without a manual retry, and the diff against upstream never grows beyond the fix and its tests.

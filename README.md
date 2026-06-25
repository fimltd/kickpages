# KickPages for Claude Code

Build KickPages funnels — and more — straight from a prompt, inside Claude Code.

`kickpages` is a Claude Code **plugin**. It bundles an MCP server (the KickPages
tools) plus skills that drive them. Today it ships **FunnelAI**; more tools are
added as skills under the same plugin over time.

---

## Install

In Claude Code:

```
/plugin marketplace add https://github.com/fimltd/kickpages.git
/plugin install kickpages
```

Then restart / reload, and verify:

```
/mcp        →  kickpages should show as connected
```

## Requirements

- **Claude Code** (current version).
- **Node.js 18+** on your machine (the plugin's MCP server runs on Node).
- A **KickPages account** — you sign in with your own login (below).

## First use — sign in

The first time you build something, Claude will sign you in: it asks for your
KickPages email + password once, then stores **only the resulting login tokens**
locally in `~/.claude/kickpages-auth.json`. Your password is never written to disk.

## Usage

Just ask for what you want — no special syntax needed:

```
create a kickpages sales funnel with 3 pages for a $97 fitness course
```

Or use the command explicitly:

```
/kickpages:funnelai a 3-page funnel for a $97 fitness coaching program
/kickpages:funnelai --review selling a Notion template bundle
/kickpages:funnelai --offer
```

Options:
- `--review` — see the funnel plan and approve it before pages are generated.
- `--offer` — build from one of your saved offers (pick from a list).

When it finishes you get the project link plus an Edit and Preview link for every
page.

## Support

Questions or issues: https://kickpages.com

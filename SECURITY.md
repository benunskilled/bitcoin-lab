# Security

## Reporting a vulnerability

Please report privately, not as a public issue: use **Report a vulnerability**
under this repository's Security tab. That opens a private advisory only the
maintainer can see.

This is a one-person project, not a company with a rota. Expect a first reply
within a week. If a week passes with no answer, opening a public issue that
says only *"awaiting a reply on a private report"* — with no details — is a
reasonable nudge.

If a fix is warranted, the release notes say plainly what was wrong and what an
affected node was exposed to. There is no embargo policy to negotiate: this app
has no users it could coordinate with, so a fix ships as soon as it is ready.

## Supported versions

The latest release only. Older versions get nothing, including the one you are
running — updating is the fix.

## What is worth attacking

Bitcoin Lab holds no keys, no wallet, and no funds. What it does hold is access
to a node, so the interesting targets are these:

**Bitcoin Core's RPC interface.** The app is given RPC credentials by Umbrel and
uses them for a small, fixed set of calls: `getpeerinfo`, `getaddednodeinfo`,
`getblockcount`, `getblockheader`, `addnode` and `disconnectnode`. Two of those
change your node's state. A flaw that let someone choose the argument to `addnode` could
attach your node to a peer of their choosing; one that reached `disconnectnode`
could drop your connections. Neither steals anything, and both are recoverable —
but on a mining node, who you are connected to is not a cosmetic detail.

**The dashboard's HTTP API.** It has no authentication of its own. It relies
entirely on Umbrel's app proxy sitting in front of it, which is what asks for
your Umbrel password. Reaching port 8788 directly — from another container, from
the LAN if the port is published, from a browser tricked into requesting it —
means reaching every action the dashboard offers. The widget endpoint
(`/api/widget/stats`) is deliberately unauthenticated and read-only, because
Umbrel's home screen fetches it without credentials.

**Outbound TCP to mining pools.** Stratum Race opens a persistent connection to
each enabled pool and parses whatever comes back. Eight public pools are enabled
by default, so a fresh install talks to eight external servers straight away.
The parser is the attack surface: it reads JSON from a socket a stranger
controls. It never submits a share, and it authorises with a well-known burn
address.

**The block-timing path.** `relay-profiler` subscribes to Core's ZMQ socket
inside the app's own network. It is not exposed outside it, and a flaw there
would corrupt measurements rather than the node.

## What is not in scope

- Anything that requires already having your Umbrel password.
- Bitcoin Core itself, Umbrel itself, or a mining pool's own behaviour —
  report those to the people who maintain them.
- The peer ranking being wrong. That is a bug, sometimes an interesting one,
  but it is not a vulnerability. Open an issue.

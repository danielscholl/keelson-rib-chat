# Security Policy

## Supported versions

The Chat rib is pre-1.0 (`0.x`) software. Security fixes land on the latest
minor release line only.

| Version                         | Supported          |
|---------------------------------|--------------------|
| Latest `0.x` minor release line | :white_check_mark: |
| Any older release               | :x:                |

## Reporting a vulnerability

**Please do not file public GitHub issues for security reports.**

Report privately via one of these channels:

- Email: **degnome@gmail.com** with subject line `[chat rib security]`
- GitHub private vulnerability report:
  <https://github.com/danielscholl/keelson-rib-chat/security/advisories/new>

A useful report includes:

- A description of the issue and the impact you observed or believe is possible
- The rib version, your Keelson version (`keelson version --json`), your
  ClickClack version, Bun version (`bun --version`), and OS
- A minimal proof-of-concept or reproduction steps
- Any mitigations or workarounds you've found

I'll acknowledge new reports within **3 business days** and aim to have a fix or
mitigation plan within **14 days** of acknowledgement.

## Scope and threat model

The Chat rib is a Keelson rib: a capability package installed into the Keelson
harness and discovered at boot. It runs agent swarms whose agents are ClickClack
bots. It holds one secret of its own, the ClickClack owner session used to mint
and revoke bots, and it mints one bot token per agent, held in memory and revoked
when the swarm ends. The token has no expiry of its own, so one the rib fails to
revoke stays valid until an owner revokes it in ClickClack.

### In scope

- An agent posting, replying, or concluding as another agent, or any way to
  forge the `turnContext` that identifies the calling agent
- A `chat_*` agent tool that runs for a caller outside a swarm turn
- Leaks of the owner session or a bot token into a channel, a log, an op
  progress frame, or a tool result
- Bot tokens that outlive their swarm
- An agent reading or writing outside its swarm's channel, or outside the
  project directory its read tools are confined to
- A guardrail bypass that lets a swarm exceed its agent, turn, or wall-clock
  limits

### Out of scope

- Vulnerabilities in ClickClack or in the Keelson harness itself. Report those
  to their own projects.
- What a model chooses to say in a channel. Anyone who can post in a swarm's
  channel can direct its lead; that is the design, so treat channel membership
  as the trust boundary.
- A malicious rib installed beside this one. Ribs are not sandboxed from the
  harness.

## Disclosure

Once a fix ships I'll credit the reporter in the release notes unless they ask
otherwise, and publish a GitHub security advisory for anything with real impact.

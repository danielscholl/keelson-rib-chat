# Contributing to @keelson/rib-chat

This rib is a standalone package the [Keelson](https://github.com/danielscholl/keelson)
harness discovers at runtime, so its contribution flow is lighter than the
keelson monorepo's. Where this file is silent, the
[keelson CONTRIBUTING guide](https://github.com/danielscholl/keelson/blob/main/CONTRIBUTING.md)
is the parent.

## Development environment

You need [Bun](https://bun.sh/) on PATH.

```bash
git clone https://github.com/danielscholl/keelson-rib-chat.git
cd keelson-rib-chat
bun install
```

`@keelson/shared`, the rib contract, installs from the keelson release tarball
pinned in `package.json`, so typechecking works with no keelson checkout. Bump
that pin by hand when the rib needs a newer contract; Dependabot does not track
tarball URLs.

To exercise the rib inside a running harness, link it into a local keelson and
launch the dev server. The README covers the ClickClack side.

```bash
bun run link:keelson   # defaults to ../keelson; override with KEELSON_DIR
cd ../keelson && KEELSON_RIBS=chat bun dev
```

## Required checks before opening a PR

Every PR must keep these green. CI runs the same commands.

```bash
bun run check       # Biome lint + format check
bun run typecheck   # tsc --noEmit
bun test            # unit tests against an in-memory ClickClack
```

Run `bun run check:fix` to auto-fix the safe lint and format issues.

CI never talks to a ClickClack server. When a change touches the ClickClack
client, the event handling, or bot and token lifecycle, run the live smoke
against a real server and record the result in the PR. It uses scripted agents,
so it spends no model tokens.

```bash
CLICKCLACK_TOKEN=<owner session> bun dev/live-smoke.ts
```

## What CI runs

| Workflow | Does |
| --- | --- |
| CI / Typecheck and test | Lint, typecheck, and tests against the pinned `@keelson/shared`. Required. |
| CI / Harness main canary | The same typecheck and tests against keelson `main`. Informational: red means the harness contract moved and the rib needs to follow before the next harness release. |
| PR Title | The title must be a conventional commit. Required. |
| Security | CodeQL over the source and the workflow files, plus dependency review on PRs. Both stand down while the repo is private. |
| Release | release-please keeps a release PR open on `main`; merging it tags the release. |

Dependabot opens weekly PRs for npm packages (through its `bun` ecosystem, so
`bun.lock` moves with `package.json`) and for the pinned GitHub Actions.

## Commit messages and releases

Conventional commit format (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`,
`test:`). One sentence in the subject, under 70 characters. The body, when
needed, explains why; the diff already shows the what.

PRs are squash-merged and the PR title becomes the commit release-please reads,
so the title is what decides the changelog entry and the version bump. A rib
installs from source (`keelson rib add <repo>` takes the newest release tag), so
the tag and its notes are the whole release. There is nothing to build or
publish.

## Pull request hygiene

- Keep PRs scoped to one thing. Split refactors out of feature work.
- The PR description should answer: what changed, why now, how it was tested.
- Don't add new abstractions ahead of a concrete second caller.
- Don't add comments that narrate the change. That belongs in the PR
  description. Add a comment only when it captures a non-obvious why a future
  reader would need.

## Architecture rules

[docs/design.md](docs/design.md) records the decisions. The ones a PR is most
likely to trip over:

- `route()` stays pure: no I/O, no clock, no provider. The swarm engine owns
  every side effect.
- The calling agent comes from `turnContext`, never from tool input, so no agent
  can speak as another.
- The rib talks to ClickClack only over its public HTTP and WebSocket API.
- Bot tokens live in memory only. The swarm revokes them when it ends; a
  harness restart mid-swarm loses them unrevoked (see Deferred in the design
  doc).

## License and attribution

Apache-2.0. New files under `src/` carry the license header the existing ones do.

## Security

See [SECURITY.md](SECURITY.md). Do not open a public issue for a vulnerability.

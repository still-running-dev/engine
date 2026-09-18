# Changelog

## 2.1.0

**Added:** a command-line interface, shipped in this same package as the
`still-running` bin (not a separate package):

- `still-running <file.json>` analyses one file; `still-running <directory>`
  analyses every `.json` file in it, recursively.
- Human output is grouped by severity and, for every finding, includes the
  route through the graph that skips the write — the thing that makes a
  finding checkable instead of just asserted.
- `--json` emits a documented, stable `{ schemaVersion, cliVersion, results }`
  shape. A directory run reports a file that failed to parse as its own
  result, with the reason, rather than aborting the whole run.
- `--min-severity=LEVEL` filters what's shown; `--fail-on=LEVEL` is the only
  thing that makes the exit code non-zero — it is otherwise always `0`, so
  this can sit in CI without breaking a pipeline.
- `still-running --version --verify` prints the package version,
  `SCHEMA_VERSION`, and the sha256 of the compiled engine — the same three
  values the footer at stillrunning.dev prints, so the CLI and the hosted
  tool can be checked against each other.

The CLI has zero runtime dependencies (argument parsing is `node:util`'s
`parseArgs`; colour is a handful of ANSI codes), and CI now fails the build
if anything under `src/` imports `node:http`, `node:https`, `node:net`, or
`node:dns` — enforcing the "no network" claim above instead of just stating it.

Repository renamed from `Workflow-Health-Check` to `engine` (still under the
`still-running-dev` organisation). **The npm package name is unchanged** —
it is still, and will remain, `@still-running/health-check`. If you depend on
this package, there is nothing to migrate.

## 2.0.0

First release from this repo — moved out of the `stillrunning` monorepo
(`packages/health-check`) so it can be the shared engine behind the CLI, the
n8n node, and the free tools without dragging that monorepo along.

**Breaking: the public API is now frozen to exactly what the package name
promises.** `index.ts` exports only:

- `analyze()`
- `Finding`, `Severity`, `Platform` (types)
- `SCHEMA_VERSION`

Everything else that `1.0.x` exported is removed from the public surface:

- `UnknownFormatError` — still thrown by `analyze()` on unrecognized input,
  still has `.name === 'UnknownFormatError'`, just no longer an exported
  class. Check the name, not `instanceof`.
- `parseWorkflow` — internal now; `analyze()` is the only public entry point.
- `AnalysisResult`, `Protection`, `Workflow`, `WorkflowNode`, `CredentialRef`
  (types) — derive what you need from `ReturnType<typeof analyze>` if you
  were importing these for typing a consumer.
- `PROVIDERS` — the credential-expiry provider table is now purely internal.

After this release, removing an export is a breaking change forever. Nothing
in this list is coming back without a new major version.

**Added:** every `analyze()` result now carries `schemaVersion` (currently
`1`, exported as `SCHEMA_VERSION`), so a consumer that stores findings can
tell which shape they were produced under instead of assuming today's.

No analysis logic changed in this release — every check's behavior and every
finding's content is identical to `1.0.1`.

## 1.0.1 / 1.0.0

Published from inside the `stillrunning` monorepo, under the
`AliAlsamraay` GitHub account. See git history there for anything predating
the move.

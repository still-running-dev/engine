# Changelog

## Unreleased

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

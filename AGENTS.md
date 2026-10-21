# Contributing to this eve agent

An agent is a directory of authored files under `agent/`; eve compiles and runs
it. Preserve the selected models and existing dependencies unless the task asks
to change them.

## Read the installed documentation

For an instructions-only change, edit the existing `agent/instructions.md`
(or its authored TypeScript/directory equivalent). Framework discovery is
unnecessary for that change.

Before authoring tools, connections, channels, skills, subagents, schedules, or
deployment, read `node_modules/eve/docs/README.md`, then the task's routed page.
Resolve the installed package location first if package-manager links hide it.
Use https://eve.dev/docs if the installed package documentation is unavailable.

Keep discovery bounded: read the routed guide and the files needed for the
change, implement the smallest complete behavior, then run a narrow check.
Expand investigation only when a check fails or project details require it.
Do not recursively scan framework internals or the full documentation tree.

When a task names an external service, check eve's registry before building a
new integration:

```sh
bunx eve registry search <query> --json
bunx eve registry view <item>
bunx eve add <item> --non-interactive
```

Prefer native integrations; use Chat SDK adapters when no native channel fits.
Exit code 2 means a question or prerequisite remains: follow the final event's
`next.command`. Never pass secrets in an `--answer` argument. Read the installed
`docs/install-integrations.mdx` for setup prerequisites.

Use eve for Vercel linking and deployment:

```sh
bunx eve link --project <name-or-id> --non-interactive [--team <team>]
bunx eve deploy --project <name-or-id> --non-interactive --yes
```

Deployment requires the task's authorization. Follow integration setup events
that report a linking prerequisite or `deploymentRequired: true` within that
scope.

## Keep changes small and organized

- Keep `agent/lib/registry.ts` the trusted configuration entry point.
- Keep eve tool definitions in `agent/tools/` thin; put repair coordination and
  stages under `agent/lib/repair/`.
- Organize incidents, GitHub operations, and telemetry under their respective
  `agent/lib/` directories. Split by responsibility, not arbitrary line counts.
- Reuse existing functions and direct imports. Avoid forwarding modules,
  compatibility reexports, generic service layers, dependency injection, and
  speculative options. Add dependencies only when existing code and platform
  capabilities cannot reasonably solve the requested behavior.
- Preserve validation and error handling when moving code. Update every caller,
  import, fixture, and relevant test; remove obsolete files.
- Put library tests in `agent/lib/tests/<area>/`, shared synthetic fixtures in
  `agent/lib/tests/fixtures/`, channel tests in `agent/channels/tests/`, and
  script tests in `scripts/tests/`. Test behavior and failure paths; avoid adding
  production abstractions solely to make tests easier.

## Preserve workflow and security invariants

- Preserve eve workflow/step directives, serializable boundaries, durable replay
  behavior, bounded retries, deduplication, publication recovery, and cleanup.
- Keep monitoring disabled until explicit activation evidence exists. Never mark
  readiness gates verified or relax browser checks to make a test/deploy pass.
- Retain raw-body signature validation, bounded/redacted telemetry, scoped
  installation tokens, signed report/state checks, and sandbox isolation.
- Keep publisher credentials outside coding/verification sandboxes. Use safe
  synthetic fixtures; never commit tokens, pulled environment files, PEM keys,
  production application credentials, or private operational evidence.
- Preserve permanent report reservations and signed state. Never steal leases,
  remove reservations, reset attempts, auto-merge, or deploy application changes
  as a workaround for uncertainty.
- Require independent expected-failure-on-base/pass-with-patch verification and
  every trusted repository gate before publishing a fix PR.

## Validate

Use Node 24.x and Bun 1.3.14. Run the narrowest meaningful check while iterating;
for a complete change, run:

```sh
bun install --frozen-lockfile --ignore-scripts
bun run typecheck
bun run test
bun run build --skip-sandbox-prewarm
bun run preflight
```

Offline preflight reports missing credentials until setup is complete. CI's
prewarm-skipped build proves compilation, not live deployment acceptance.
`bun run preflight --live` uses read-only service requests. `bun run smoke`
spends Gateway/Sandbox usage and requires an explicitly configured monitor
project/team and fresh OIDC; run live checks only within the task's scope.

# Sentry Repair Agent Template

An eve agent that investigates Sentry incidents, writes GitHub investigation
reports, and opens independently verified fix PRs for human review. Signed
webhooks and five-minute reconciliation feed durable per-repository queues.
Sentry issues and signed GitHub state support recovery without an extra database.
The agent never merges PRs or deploys application changes.

This template starts with **monitoring disabled**, one placeholder repository,
pending readiness gates, and browser repairs restricted to reports. Configure
and validate your own accounts before enabling it. No credentials or operational
acceptance evidence is included.

## Get started

Choose **Use this template** on GitHub to create your own repository, then clone
it. Use Node.js **24.x** and Bun **1.3.14**, matching `package.json` and the
sandbox runtime. The installed eve documentation requires Node 24 or newer;
this project pins the supported major to 24.

```sh
bun install --frozen-lockfile --ignore-scripts
cp .env.example .env.local
bun run typecheck
bun run test
bun run build --skip-sandbox-prewarm
bun run preflight
```

Populate `.env.local` using your secret manager; keep it out of Git. Offline
preflight is expected to fail until the required values are configured. It
prints status messages without credential values. `bun run dev` starts eve's
local development interface.

The build above skips sandbox prewarming so local checks and CI need no project
credentials. Normal builds and deployments retain prewarming; compilation alone
does not verify a live deployment.

## Configure your repositories

Edit `agent/lib/registry.ts`. Replace the example entry with your repository and
add another entry for each repository you want to monitor:

- GitHub owner, repository, stable internal ID, and default branch.
- Sentry organization, project slug and numeric project ID; `projectId` is the
  primary Sentry project ID and must match an entry in `projects`.
- Target application's Vercel project/team IDs and allowed environments. These
  identify the monitored application, separate from the agent's own deployment.
- Main and secondary user flows, trusted setup commands, and every required
  verification command. The example Bun commands are placeholders for your app.
- Safe synthetic test environment values and browser fixtures, when available.
- Clean-baseline and source-map readiness evidence, including the verified SHA.

Keep `repairReadiness` gates pending until you have the evidence they describe.
Keep `browserVerification: 'report-only'` until an actual affected browser flow
can be verified with safe fixtures. Repository commands and fixtures are trusted
configuration; never substitute production application credentials.

Repairs require a production event with a full GitHub commit SHA, verified
baseline/source-map gates, and the exact matching default-branch base. An
advanced branch or missing evidence produces a report. Independent verification
must reproduce the expected failure on the base, pass with the patch, and pass
all configured repository gates before publication. Missing browser fixtures or
failed gates also produce reports without fix PRs.

## Connect your accounts

Create dedicated integrations for your deployment. Store secrets as protected
Vercel environment variables; do not commit them or pass them to the coding
sandbox.

1. **GitHub:** create your own private GitHub App using the settings printed by
   `bun run github-app https://your-agent.example.com`. An explicit HTTPS origin
   is required. Choose a globally unique App name in the registration form.
   Register the private App under the account or organization owning your
   monitored repositories. The printed link opens personal-account registration;
   for organization repositories, use that organization's **Settings → Developer
   settings → GitHub Apps → New GitHub App** with the same printed settings.
   Private Apps install only on their owner's account, and this deployment uses
   one `GITHUB_INSTALLATION_ID`: all registry repositories must belong to that
   installation. Install only on your configured repositories and set
   `GITHUB_APP_ID`, `GITHUB_INSTALLATION_ID`, and `GITHUB_APP_PRIVATE_KEY`.
   Permissions are Contents, Issues, and Pull requests read/write; Checks and
   Metadata read-only. Inbound GitHub webhooks and workflow writes are disabled.
   The publisher mints short-lived, repository-scoped installation tokens;
   credentials remain outside coding and verification sandboxes.
2. **Sentry:** create an internal integration with Organization, Project, and
   Issue & Event read access (`org:read`, `project:read`, `event:read`). Set its
   token as `SENTRY_AUTH_TOKEN` and its Client Secret as `SENTRY_WEBHOOK_SECRET`.
   Set the webhook URL to `https://your-agent.example.com/webhooks/sentry`,
   subscribe to issue events, and select the integration in each monitored
   project's production issue alert rule. Raw-body HMAC-SHA256 validates delivery.
   A source-map upload token is not a replacement for this integration.
3. **Signing:** generate separate random 32-byte values for `CRON_SECRET` and
   `STATE_SIGNING_SECRET`. Vercel sends Cron authentication as a bearer header;
   never put it in a URL. Preserve the state-signing secret across Cron rotation:
   changing it requires manual reconciliation of existing reports and leases.
4. **Vercel evidence (optional):** set a dedicated read credential as
   `VERCEL_READ_TOKEN` for target deployment metadata and bounded runtime logs.
   Without it, reports mark that evidence unavailable. When returned, deployment
   evidence must match a READY production deployment and the Sentry release SHA.
   Do not copy a local CLI login credential into the service.
5. **Models and sandboxes:** the deployed project supplies `VERCEL_OIDC_TOKEN`.
   Existing models use AI Gateway (`openai/gpt-6.1-sol`); no provider API key is
   needed for project OIDC. Local development tokens expire and must remain local.

## Deploy and validate

Link a dedicated Vercel project using the installed eve CLI. Replace the example
project/team names with your own:

```sh
bunx eve link --project your-repair-agent --team your-team --non-interactive
bunx eve deploy --project your-repair-agent --non-interactive --yes
```

`eve link` creates or links the named project and pulls its environment. Set
protected environment values in that project before deployment. Keep
`MONITOR_ENABLED=false` in every environment during setup; preview should stay
disabled. eve manages the build, Sandbox prewarming, Workflow, and Cron setup.

Configure an AI Gateway project budget before activation. Gateway, Sandbox,
Workflow, Functions, and storage can have separate usage charges and limits;
there is no included credit allowance or promised spending cap. Confirm your
Vercel plan supports the five-minute schedule and managed services you use.
Budget exhaustion pauses model work until its reset.

The custom channel exposes `GET /health`, signed `POST /webhooks/sentry`, and
`GET /cron/reconcile` authenticated by `CRON_SECRET`. eve owns its internal
transport. Production operator transport requires project OIDC. Configure
Deployment Protection so legitimate Sentry delivery reaches only the intended
route; do not put protection bypass credentials in the webhook URL.

```sh
bun run preflight
bun run preflight --live
```

Live preflight performs read-only GitHub, Sentry, Gateway model-catalog, and
optional Vercel checks. It creates no model request, sandbox, issue, or PR.

An optional infrastructure smoke **incurs Gateway and Sandbox usage charges**:

```sh
bun run smoke
```

Before running it, set `VERCEL_PROJECT_ID` and `VERCEL_TEAM_ID` to the agent's
own deployment, and pull that project's fresh development OIDC token. The smoke
rejects project/team mismatches, expired tokens, and API-key/access-token
fallbacks. It makes a bounded model request and checks generation metadata,
creates one ephemeral Sandbox, checks Node/Bun, exercises synthetic
fail-before/pass-after fixtures, and stops the VM in `finally`. Synthetic
fixtures do not establish acceptance for your application or create target
issues or PRs.

Before enabling monitoring:

1. Pass offline and live preflight for your integrations and target repositories.
2. Run each target's clean baseline with registry commands in isolation. Verify
   source maps, release metadata, and embedded source match its deployed commit.
   Record the evidence and SHA in the registry gates.
3. Verify signed delivery, duplicate handling, interrupted-run recovery, project
   budget behavior, and a controlled reproducible incident for each repository.
   Confirm exactly one fail-before/pass-after PR; an unreproducible incident
   must produce an honest report without a PR. These trials create real GitHub
   reports/PRs and require your own test incidents and accounts.
4. Set production `MONITOR_ENABLED=true`, deploy, check `/health`, then review
   Agent Runs, Workflow, and GitHub reports. Browser repairs remain report-only
   until their separate fixtures and gates are ready.

## Reports and recovery

Reports include cause and confidence, priority, affected user flows, observed
events/users over rolling windows, trend, release/deployment evidence,
reproduction, verification commands, and the next action. Missing counts stay
unknown; exception counts are not failure percentages. Bounded, redacted Sentry
span/log samples add context without claiming incident volume or full coverage.

Priority follows confirmed impact first: P0 for complete main-flow outage or
data loss, P1 for blocked cohorts or high-volume unknown impact, P2 for degraded
main flows or broken secondary features, and P3 for minor/nonblocking impact.
Escalation is immediate; downgrades require sustained recovery evidence.

To pause, set `MONITOR_ENABLED=false`, redeploy, and confirm `/health` reports
`monitoringEnabled: false`. Already accepted runs continue: cancel their
Workflows and stop their Sandboxes before treating the agent as stopped. Review
existing reports, branches, and PRs separately. Suspend the dedicated GitHub App
installation for immediate publisher containment.

Preserve signed GitHub report markers, publication state, permanent
`incident-agent-report-<identity hash>` reservation tags, and the state-signing
secret. These prevent duplicate issues and preserve attempts across restarts.
An uncertain creation or abandoned `incident-agent-lock` requires human
reconciliation after proving its owner stopped; the agent never steals leases
or removes creation reservations based on age. Inspect unreadable or stranded
eve sessions in Agent Runs and Workflow before resetting them. Do not delete
state to force retries. Cancel active runs before rolling back this agent's
deployment, and revalidate the restored deployment while disabled.

## Development layout

- `agent/tools/`: thin eve tool definitions.
- `agent/lib/registry.ts`: trusted repository configuration.
- `agent/lib/incidents/`, `github/`, `telemetry/`, `repair/`: focused implementation.
- `agent/lib/tests/<area>/`: behavioral suites; shared fixtures in `tests/fixtures/`.
- `agent/channels/tests/` and `scripts/tests/`: channel and setup checks.
- `AGENTS.md`: portable contributor instructions and security/workflow invariants.

Use the existing functions and platform capabilities before adding abstractions.
Preserve durable replay boundaries and test externally visible behavior. MIT
licensed; see [LICENSE](LICENSE).

Setup references: [eve deployment](https://eve.dev/docs/guides/deployment/vercel),
[GitHub App permissions](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app),
[Sentry scopes](https://docs.sentry.io/api/permissions/), and
[Sentry webhooks](https://docs.sentry.io/organization/integrations/integration-platform/webhooks/).

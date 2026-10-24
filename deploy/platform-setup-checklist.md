# n8n platform setup checklist

Fork document (not in upstream n8n). These steps set up n8n for the users of the organisation: the
server, the sign-in, the tiers of builders, the connectors, the visibility and the checks.

## Before you start

The platform team does these steps once, on the n8n server that runs `deploy/` of the fork. Builders
see none of it: they sign in, build, and meet a control only when the risk is real.

On Google Cloud Run, Amazon ECS, Azure Container Apps or Kubernetes, set the same values in
`settings` of the Terraform module or of the Helm chart, with their n8n names. The table [Settings
of the other options](README.md#settings-of-the-other-options) of deploy/README.md gives the n8n
name of each value of `.env`.

You need:

- SSH and sudo on the n8n server, and the owner account of n8n.
- An Entra ID admin who can register an app and make groups.
- The internal hosts and IP ranges that workflows may call (the SSRF allow-list).
- The IP ranges that may call webhooks and forms, where you can limit them.
- The address and the token of your SIEM (a webhook or syslog endpoint).

Decide these four questions first, because they change the steps below. Write the answer of the
owner in the table.

| Question | Suggested answer | Changes |
| --- | --- | --- |
| Who builds? | Everyone explores in a personal space. The Team tier comes after a short onboarding. | Sign-in, Team tier |
| Are the Code and HTTP Request nodes allowed in Explore? | Yes, after SSRF protection is on. | Server, Connectors |
| Where are public endpoints (webhooks, forms, chats) allowed? | In the Team tier with authentication. Without authentication, only in Critical, with an approval. | Connectors, Critical tier |
| Which data may enter n8n? | Public and internal data. Confidential data only in Critical projects. No restricted data. | Connectors, Critical tier |

## Enterprise features for all users

The fork gives every user the features of the n8n Enterprise Edition, with no licence key, no
registration and no limits. The switch is `FORK_FEATURES_ENABLED` in `.env`
(`N8N_FORK_FEATURES_ENABLED`), and it is on by default.

n8n checks a licence before each enterprise feature. The fork keeps these checks, and the switch
answers "licensed" for each feature that the fork turns on. Where n8n has enterprise code, the fork
runs its own version, and golden tests compare it with the original. So the [n8n
documentation](https://docs.n8n.io) applies.

| Feature | Set up in |
| --- | --- |
| Sign-in with OIDC, SAML or LDAP, and roles from the groups | [Sign-in](#sign-in) |
| Two-factor sign-in, rules for personal spaces, workflow reviews, data redaction | [Server](#server) |
| Team projects without a limit, project roles, custom roles, sharing | [Team tier](#team-tier), [Critical tier](#critical-tier) |
| External secrets, end-user credentials, node type policies, community nodes from your own registry, Gateway credits | [Connectors](#connectors) |
| Log streaming, the audit log, insights without a limit of history | [Visibility](#visibility) |
| Git connections, the banner of a non-production instance | [Later: a production instance](#later-a-production-instance) |
| Folders, variables, the workflow history with the comparison and the names of versions, debug in editor, execution annotations, evaluations | Nothing to set up: show them in the onboarding ([Team tier](#team-tier)) |
| Source control with a Git branch, files in S3, Azure Blob or Google Cloud Storage, queue mode with workers, token exchange | Not in this checklist |

[FORK-ADOPTION.md](../FORK-ADOPTION.md) tells who sets up each feature, where, and which settings it
needs. The fork does not have the chat of the AI assistant and of the AI builder, or AI credits,
because they need a service of n8n.

- [ ] After the first start, open **Settings > Usage and plan**. It says "Fork features are on". The
  plan name stays "Community".
- [ ] Keep the switch on. An instance that keeps files or execution data in S3, Azure Blob or Google
  Cloud Storage does not start with the switch off.

## Server

The new `deploy/` starts with safer defaults, and an existing server gets them with its next update.
Do these steps in the folder of `deploy/` on the server, for example `/opt/n8n`. The section "Safer
defaults" of [deploy/README.md](README.md#safer-defaults) describes each default.

| Default | What users notice | Setting in `.env` |
| --- | --- | --- |
| SSRF protection | A node cannot call private, loopback or link-local addresses. The error tells the user to ask an admin. | `SSRF_ALLOWED_HOSTNAMES`, `SSRF_ALLOWED_IP_RANGES` |
| Sessions that renew while users work | Active users stay signed in. A session without use ends after 12 hours at most. | `SESSION_HOURS`, `SESSION_RENEWAL_HOURS` |
| Two-factor sign-in for passwords | Email and LDAP users set up two-factor authentication first. OIDC and SAML users do not see it. | `MFA_ENFORCED` |
| No publishing or sharing from personal spaces | Members build and run workflows in their personal spaces, with their own credentials. They publish, share and use team credentials in team projects. | `PERSONAL_SPACE_PUBLISHING`, `PERSONAL_SPACE_SHARING` |
| Workflow reviews on | A builder can send a version to a reviewer. The approval publishes it. | `WORKFLOW_REVIEWS` |
| IP limits for webhooks and forms | Nothing until you set the ranges. | `WEBHOOK_ALLOWED_RANGES`, `FORM_ALLOWED_RANGES` |

`deploy/` also turns off the telemetry, the "What's new" notes and the update notices of n8n
(`TELEMETRY`, `UPDATE_NOTICES`). The platform team updates n8n with `deploy/`, so users do not see
notices about new versions.

- [ ] Update `deploy/` on the server, then run `sudo docker compose up -d`.
- [ ] Before users start, put the internal hosts that workflows may call in `SSRF_ALLOWED_HOSTNAMES`
  (names, `*.corp.internal` for subdomains) or `SSRF_ALLOWED_IP_RANGES` (for example
  `10.20.0.5/32`).
- [ ] Where you can, set `FORM_ALLOWED_RANGES` to the ranges of your network and VPN, and
  `WEBHOOK_ALLOWED_RANGES` to the ranges of the systems that call your webhooks.
- [ ] Set `REDACTION_FLOOR`: `off` to start, `production` when executions can hold confidential
  data.
- [ ] Run `sudo docker compose up -d` again. Settings > Security & policies now shows the values
  read-only.
- [ ] Check SSRF protection: an HTTP Request node to `http://169.254.169.254/` fails with "The
  target 169.254.169.254 is not allowed".

## Sign-in

Users sign in with Entra ID through OIDC, and their Entra groups give their roles. When OIDC is on,
n8n refuses password sign-ins of everyone except the owner. The owner keeps a password with
two-factor sign-in as the emergency access.

The owner account:

- [ ] Make the owner account. n8n asks for two-factor authentication at once (`MFA_ENFORCED`).
- [ ] Save the password and the recovery codes of the owner in the password manager of the platform
  team.

In Entra ID:

- [ ] Register an app of the type Web. Its redirect URI is the **Redirect URL** that n8n shows in
  **Settings > Single Sign-On**: `https://<DOMAIN>/rest/sso/oidc/callback`.
- [ ] Make a client secret, and note its expiry date.
- [ ] In the token configuration, add the groups claim (groups assigned to the application, as group
  IDs, in the ID token. This keeps the token under the limit of groups).
- [ ] Make the groups: `n8n-admins` (platform team), `n8n-builders` (Team tier), and one group for
  each team project.
- [ ] In the enterprise app, turn on **Assignment required**, and assign the groups. Only assigned
  people can then sign in.

In n8n, **Settings > Single Sign-On**:

- [ ] **Authentication protocol**: OIDC. Discovery endpoint:
  `https://login.microsoftonline.com/<tenant ID>/v2.0/.well-known/openid-configuration`, with the
  client ID and the secret. With deploy/, set them in `.env` instead (`SSO_FROM_ENV=true`,
  `OIDC_DISCOVERY_URL`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`): n8n sets the sign-in at each start,
  and this page shows it read-only.
- [ ] **Role assignment**: **Instance roles via SSO**, with **Map rules inside n8n** (with deploy/,
  `.env` sets the rules as the method). Project admins then keep project membership in n8n. Add
  project roles only when the teams are stable: when one project rule exists, n8n sets the members
  of all team projects at each sign-in.
- [ ] **Instance role rules**, in this order: `n8n-admins` gives Admin, `n8n-builders` gives Member,
  and everyone else gets Chat user. Make them with `deploy/platform/setup.mjs` from `platform.json`:
  `instanceRoles` with the object IDs of the two groups, and `defaultInstanceRole: global:chatUser`.
  Run `plan`, then `apply`.
- [ ] Turn on OIDC sign-in. Then sign in with a test account of each group, and check the role on
  **Settings > Users**.

A new user who is in no builder group gets Chat user: they can chat in the Chat hub and fill in the
published forms, but they cannot see or build workflows.

## Explore tier

Each member builds and tests in a personal space, and the server defaults remove two things there:
publishing (workflows and agents) and sharing (workflows and credentials). Everything else still
works: build, run by hand, test webhooks and forms, and move a workflow to a team project.

- [ ] Check with a test member: a personal workflow runs by hand, and cannot be published or shared.
- [ ] Open **Settings > Security & policies**. It counts the personal workflows that are still
  published or shared from before the change. Unpublish them, or move them to a team project.
- [ ] Tell builders the path to production: move the workflow to a team project with the button Move
  to a team project next to Publish, then publish it there (Team tier). The button shows only when
  the user is in a team project that can take the workflow. Without one, the tooltip of Publish
  tells the user to ask an admin. Build a workflow that needs team credentials in the team project
  from the start.
- [ ] Say in the onboarding which data may go into a personal space: test data and public data only.
  n8n cannot check this.
- [ ] Decide the nodes of Explore with the baseline node policy (Connectors).

## Team tier

Workflows go live in team projects. A builder joins a team project after a short onboarding, and the
project admin decides who publishes.

| Project role | Can do |
| --- | --- |
| Admin | Everything in the project: members, credentials, sharing, publishing |
| Editor | Build, run, publish and unpublish, and make the credentials of the project |
| Viewer | Read workflows and executions only |

- [ ] Write a 30-minute onboarding: the tiers, test data in personal spaces, moving and publishing,
  team credentials, webhooks with authentication, the features that need no setup (folders,
  variables, the workflow history, debug in editor, execution annotations and evaluations), and who
  to ask. Make a Drafts folder in each team project, and tell builders to experiment there with the
  team credentials: a workflow there runs only by hand until someone publishes it.
- [ ] Make one team project for each team: list the projects in `platform.json`, and
  `setup.mjs apply` makes them. By default only the owner and the admins can make team projects.
- [ ] Give each project one or two admins (team leads), Editor to the onboarded builders, and Viewer
  to the readers.
- [ ] Make the credentials of the team inside the project, with team accounts, not personal
  accounts: list them under the project in `platform.json`. Keep their secrets in the vault
  (Connectors) and write them as `={{ $secrets.<vault>.<key> }}`, or pass them as environment
  variables (`{ "env": "NAME" }`). The tool never shows a secret.
- [ ] Public endpoints: allow them in this tier only with authentication (the open decision in
  "Before you start"). The publish check does this: with `OPEN_TRIGGERS_NEED_APPROVAL=true` (the
  default of deploy/), a new webhook, form, public chat or MCP server without authentication does
  not publish. The editor offers a one-click fix (a token for webhooks and MCP servers, n8n sign-in
  for forms and chats) and Request approval, which sends the version to a reviewer. The test URL of
  such a trigger takes calls only from n8n users who may run the workflow, so nobody without an n8n
  account can run a draft through it. The trigger panel of the editor tells the builder this.
- [ ] Before the pilot, open Settings > Open triggers. It lists the open triggers of the published
  workflows: they keep running, and each one shows whether a review approved it. Add authentication
  to each one that does not need to be public. The weekly governance report lists the open triggers
  without an approval.
- [ ] Later, when the teams are stable: give project roles from Entra groups. Add the `roles` of all
  team projects to `platform.json` at once, then run `apply`. When one project rule exists, n8n sets
  the members of all team projects at each sign-in, and `plan` warns about projects without a rule.

## Critical tier

Critical workflows live in locked team projects: builders there cannot publish, and one of two
approvers publishes after checking the version.

- [ ] Make a custom project role "Critical builder" in **Settings > Roles > Project roles**: the
  permissions of Editor without publish and unpublish.
- [ ] Make a team project for each critical area. Give its builders "Critical builder", and two
  approvers the role Admin.
- [ ] Use only the credentials of the project, with their secrets in the vault. Builders then never
  see a secret.
- [ ] Hide execution data: set `REDACTION_FLOOR=production` on the server, or set the redaction of
  each critical workflow in its settings.
- [ ] Agree on the approval steps: the builder saves a named version and tells an approver. The
  approver compares it with the published version in the workflow history, then publishes it.
- [ ] For a second opinion, an approver sends the version to the other approver as a workflow
  review. The approval publishes it.

Today a builder without publish rights cannot send a review: only users who can publish can. The
**Request approval** button of the publish check (Team tier) is for those users too. A review
request from builders without publish rights is the "mandatory reviews" work that waits for evidence
from the pilot.

## Connectors

The connectors decide what a workflow can reach. Set a baseline for the whole instance, then
restrict critical projects further.

- [ ] **Baseline node policy.** Write an instance policy with the node types that nobody may use,
  for example SSH and FTP, and a project policy for each critical project. Today the policies change
  through the public API only: `/api/v1/node-type-policies` and `/api/v1/credential-type-policies`
  ([README of the module](../packages/cli/src/modules/type-availability-policies/README.md)). The
  fork adds no settings page for them, because of the feature freeze. The editor shows a lock on a
  blocked node type.
- [ ] **Code and HTTP Request in Explore.** Follow the decision of "Before you start". With SSRF
  protection on, the suggestion allows them.
- [ ] **Domain limits on credentials.** For each team credential that the HTTP Request node can use,
  set **Allowed HTTP Request Domains** to the domains of that service.
- [ ] **Vault for secrets.** Connect your secrets manager in **Settings > External secrets**, then
  refer to its secrets in the credentials of the teams. n8n masks the secrets in the editor.
- [ ] **End-user credentials.** For a tool that each user signs in to, use an end-user credential,
  so that each run acts as the user. The section "End-user credentials" of
  [deploy/README.md](README.md#end-user-credentials) tells how.
- [ ] **AI.** Set up Gateway credits with budgets on Settings > Gateway credits admin, as [AI
  gateway checks on your server](ai-gateway-checks.md) tells.
- [ ] **Community nodes.** Only the owner and the admins can install them, so keep the admin group
  small. To install from your own registry only, set `COMMUNITY_PACKAGES_REGISTRY` in `.env`.

## Visibility

The platform team sees what everyone builds and runs: in the audit log of n8n, in your SIEM through
log streaming, and in a weekly report.

- [ ] **SIEM.** In **Settings > Log streaming**, add a syslog or webhook destination for your SIEM,
  with the event group `n8n.audit`. Send a test event, and find it in the SIEM.
- [ ] Or keep the destinations in the configuration: `N8N_LOG_STREAMING_MANAGED_BY_ENV=true` and
  `N8N_LOG_STREAMING_DESTINATIONS` in a `docker-compose.override.yml`. The page is then read-only.
- [ ] **Audit log.** **Settings > Audit log** keeps the events for 90 days. The filter **Project:
  Personal spaces** shows the work in personal spaces.
- [ ] **Weekly report.** Import `deploy/workflows/governance-report.json` into a team project of the
  platform team. Follow the note on the workflow: an API key with the scopes it names, and the mail
  address of the team.
- [ ] Read the report each Monday: published workflows in personal spaces (with these defaults,
  none), failed and unpublished changes, unused API keys and inactive users.
- [ ] **Insights.** The Overview page shows the executions, failures and time saved of each
  workflow. Use it to find the workflows that matter, and move them to the Critical tier.

## Checks

Make one test account for each tier in Entra ID, and run these checks before the pilot and after
each update of n8n.

| Test account | Must work | Must fail |
| --- | --- | --- |
| Chat user (in no builder group) | Sign in with SSO, chat in the Chat hub, fill in a published form | Open or build a workflow |
| Explore (in `n8n-builders`) | Build and run a workflow by hand in the personal space | Publish or share a personal workflow, call a private address with HTTP Request |
| Team editor (Editor of a team project) | Publish in the team project, use the team credentials | See the projects of other teams |
| Critical builder | Build and run by hand in the critical project | Publish |
| Approver (Admin of the critical project) | Publish, send a version to the other approver as a review |  |
| Admin (in `n8n-admins`) | All settings, the audit log, all workflows | Change Settings > Security & policies |
| Any user except the owner, with a password |  | Sign in with a password while OIDC is on |

- [ ] Run each row, and note the date and the version of n8n here.
- [ ] Run `node platform/setup.mjs check` each week. It fails when a team project, an SSO group rule
  or a team credential of `platform.json` is missing, or when personal spaces can publish or share.
- [ ] After each update of n8n, open **Settings > Usage and plan**. It still says "Fork features are
  on".

## Later: a production instance

The pilot runs on one instance. When you add a production instance, Git carries the work between the
two instances, and builders still do not touch Git.

- [ ] Run Forgejo on its own VM, as [deploy/forgejo/README.md](forgejo/README.md) tells.
- [ ] Give the development instance write access and the production instance read access
  (`add-n8n-instance.sh`).
- [ ] Connect both with Git connections (**Settings > Environments v2**). The development instance
  promotes, and the production instance applies.
- [ ] Turn on `NON_PRODUCTION_BANNER=true` on the development instance.

Not built yet: an automatic promotion, in which an approved or published workflow reaches production
by itself. Until then, a platform admin promotes and applies in **Settings > Environments v2**, or
through `/api/v1/promotions`.

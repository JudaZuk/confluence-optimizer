# Contributing

Thanks for helping! Bug reports, docs fixes and features from the [roadmap](README.md#roadmap) are all welcome.

## Setup

```bash
npm install
npm test                      # no Atlassian account needed
forge register                # once, for your own dev copy
forge deploy -e development
forge install -e development --product confluence --site <dev-site>.atlassian.net
forge tunnel                  # live reload while you work
```

A free Confluence Cloud developer site is available from Atlassian (search for "Atlassian developer site").

## Guidelines

- **Safety first.** Anything that changes Confluence content must go through the review queue and the audit log. Prefer reversible actions.
- **Keep logic pure and tested.** Put parsing, scoring and SQL building in `src/backend/lib/` and add tests in `test/`.
- **Bind every SQL value.** Never interpolate user input into SQL. Column names and sort orders come from whitelists.
- **Migrations are append-only.** Never edit a shipped migration in `src/backend/db/schema.js`; add a new one.
- **Minimal scopes.** Explain any new scope in `SECURITY.md` and the pull request.
- **Plain language in the UI.** Short sentences; say what will happen and whether it can be undone.

## Pull requests

1. Fork, create a branch, make your change with tests.
2. `npm test` and `forge lint` must pass.
3. Describe what changed and how you tested it on a real site.

By contributing you agree that your contribution is licensed under the Apache License 2.0.

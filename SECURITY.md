# Security

## Reporting a vulnerability

Please do **not** open a public issue. Use GitHub's *Report a vulnerability* (private security advisory) on this repository. We aim to respond within 7 days.

## Permissions the app requests

| Scope | Why |
|---|---|
| `storage:app` | Settings and scan state in the Forge key-value store |
| `read:space:confluence` | List spaces |
| `read:page:confluence` | List pages and blog posts, read page bodies to find attachment references (bodies are not stored) |
| `read:attachment:confluence` | List attachment metadata |
| `delete:attachment:confluence` | Approved requests: move attachments to trash, purge from trash |
| `delete:page:confluence`, `delete:blogpost:confluence` | Approved requests: purge trashed pages and blog posts |
| `delete:content:confluence` | Approved requests: delete historical attachment versions (REST v1) |
| `read:confluence-user` | Check whether the signed-in user is a Confluence administrator |
| `read:confluence-space.summary` | Check whether the signed-in user administers a space |

The app has no egress permissions: it cannot send data anywhere outside Atlassian.

## Design

- **Approval gate.** Delete scopes are only used by `exec-worker`, which only processes requests whose status is `approved`. Only Confluence administrators can approve (`decideRequest` exists only in the admin resolver, and it re-checks admin rights).
- **Server-side authorization.** Every admin resolver call checks `GET /wiki/rest/api/user/current?expand=operations` as the user (`administer` on `application`). Every space resolver call checks `GET /wiki/api/v2/spaces/{id}/operations` as the user (`administer` on `space`), falling back to `GET /wiki/rest/api/space/{key}?expand=operations` and takes the space from the Forge module context, never from the request payload.
- **Scoped queries.** Space-level requests and lists are filtered by space id on the server, including when items are chosen by id.
- **SQL injection.** All values are bound parameters; sort orders and columns come from whitelists. `test/lib.test.js` checks this.
- **CSV injection.** Text cells starting with `= + - @` are prefixed with `'`.
- **Data minimisation.** Only metadata and links are stored. Page bodies are read in memory during scans and discarded. File contents are never downloaded.
- **Audit.** Requests, decisions, every changed item, failures, exports and settings changes are logged with the acting account.

## Known trade-offs

- Approved jobs run as the app, not as the approver, because Forge async consumers do not run as a user. The approval gate and per-item re-checks compensate.
- The app can only see content the app user can read; restricted content is skipped.

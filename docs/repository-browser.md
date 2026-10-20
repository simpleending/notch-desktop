# Local repository browser

Open the browser from **Clone from GitHub** on the welcome screen or **GitHub** in the sidebar. Choose GitHub or Origin in the repository service selector. Local projects appear above both services.

## GitHub clones

The IDE remembers a successful clone before you open its workspace. Known workspace roots are registered when browsing repositories, including projects from earlier IDE versions. A matching GitHub row shows **Open** and its local folder instead of **Clone**. Pasted repository URLs use the same check, and the backend independently prevents duplicate clones.

History is stored in `github-clones.json` in the IDE's local profile. It contains folder paths only. Repository identity comes from each folder's actual Git `origin`; HTTPS and SSH GitHub URLs match the same repository. Missing folders, changed origins and unrelated hosts are checked again before opening. The IDE does not scan your disks: use **Open local repository…** once for a clone it has never seen. Worktrees and subfolder selections resolve to their Git root.

## Cursor Origin

Origin is Cursor's code-hosting service, distinct from the Git remote conventionally named `origin`. The panel accepts the official HTTPS and SSH clone URL formats and remembers local clones in a separate `origin-clones.json` profile file. Git commands run on the user's device. Existing pull/push operations use that project's configured Git remote and local credentials. The integration does not rewrite remotes, configure SSH trust or use any FreeSyntax backend.

On Windows, choose **Sign in to Cursor Origin**, then **Continue sign-in in your browser**. The official Cursor SDK runs the browser login natively. The IDE and CLI share a current-user DPAPI-protected login on this device, and obtain short-lived Origin tokens through Cursor's documented token exchange. Repository namespaces load after sign-in; choose one to browse a scrollable, filterable list. Previously cloned repositories show **Open**. HTTPS is the default; native Windows Git receives a host-scoped credential helper for clone, pull and push. WSL is not required. Sign out removes the saved login; environment credentials and SSH keys remain managed separately.

SSH uses your registered native keys. For a first SSH connection, verify the host fingerprint in Cursor's official Git documentation in a terminal.

On macOS/Linux, install the official `origin` CLI and run `origin auth login` in a terminal. Then **Load Origin repositories**, choose a namespace and browse the scrollable list. The panel uses the documented `origin api /namespaces` and `/repos/{owner}` endpoints with opaque pagination tokens. Origin CLI owns credential exchange and refresh; Cursor API keys are never sent directly as Origin bearer tokens. A pasted URL keeps its protocol; the protocol selector applies to owner/repo inputs and list selections.

Origin mirrors follow Cursor's upstream and forge-local branch rules. Ordinary pull/push operations here follow the configured remote; the IDE does not create an `origin-local` remote or change mirror settings.

Official references checked 2026-10-20:

- [Origin overview and account availability](https://cursor.com/docs/origin)
- [Clone, push, pull, SSH fingerprints and mirror behavior](https://cursor.com/docs/origin/git)
- [Origin CLI installation and authentication](https://cursor.com/docs/origin/cli)
- [CLI command and environment reference](https://cursor.com/docs/origin/cli/reference/commands)
- [Origin REST API, token exchange and pagination](https://cursor.com/docs/api/origin)

Validation includes real local Git clone/pull/push, restart persistence, URL validation, IPC boundaries, namespace and repository pagination, and packaged IDE interaction. Live Origin sign-in and Cursor-hosted clone/pull/push require an Origin-enabled account and have not been verified.

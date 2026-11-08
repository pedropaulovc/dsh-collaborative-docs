# DSH Collaborative Docs

Edit local documents with your DeepSeek Harness agent. The browser editor uses BlockNote for rich text and threaded comments, with Yjs sharing document state between the editor and agent tools.

## Build

Requires Node.js 22 or newer. The DSH integration targets **0.2.1-rc.3**; other runtime versions must be checked before installation.

```sh
npm ci
npm run build
npm run check
npm test
npm pack
```

The package contains the DSH adapter and compiled editor assets. No CDN or hosted editor service is required.

## Install in DeepSeek Harness Desktop

Enable the desktop app's CLI with **Manage dsh Command**, then open a new terminal. The desktop executable itself does not accept plugin-management commands.

Fully quit Desktop, then install the tarball produced by `npm pack`:

```sh
dsh plugin --profile desktop add /absolute/path/to/pedropaulovc-dsh-collaborative-docs-0.1.0.tgz
```

Reopen Desktop. Open the Collaborative Docs panel, or ask the agent to call `docs_open`. Do not grant a compatibility exemption to get past an unsupported runtime version.

For the CLI web profile, use `--profile web` instead of `--profile desktop`.

## Run without DSH

```sh
npm run build
npm run dev
```

Open the local URL printed by the server. Treat that URL as a capability: anyone who has it and can reach the local listener can access the document workspace.

For an isolated data directory or a fixed port:

```sh
npm run dev -- --data-dir /absolute/path/to/documents --port 3081
```

## Editing and comments

Create a document or import a Markdown file. Select text to add a comment, reply in a thread, or resolve a discussion. Changes synchronize between open browser tabs and agent operations. The save indicator distinguishes persisted changes from pending work; keep the tab open while changes are unsaved.

The agent reads a snapshot containing block IDs and a revision. An edit must include that revision and target specific blocks. Stale revisions are rejected so the agent can read the current document before trying again. This check covers changes already received by the server; edits still in flight can subsequently merge through Yjs.

Markdown import creates a new document. Export produces a Markdown copy; comment threads and rich formatting that Markdown cannot represent remain in the local Yjs document. Editing an exported file does not update the shared document.

### Agent tools

| Tool | Action |
| --- | --- |
| `docs_open` | Start the local editor and return its URL |
| `docs_list`, `docs_read` | List documents or read blocks, revision, and comments |
| `docs_create` | Create a document, optionally from Markdown |
| `docs_edit` | Apply revision-checked text replacement, block insertion, or deletion |
| `docs_comments`, `docs_reply`, `docs_resolve` | Read threads, reply, and resolve or reopen discussions |
| `docs_export` | Return a Markdown copy |

## Local data and security

The server listens on `127.0.0.1`. A random startup capability establishes a local session cookie. Document APIs and WebSocket upgrades require authentication and validate the host and browser origin. This is a trusted, single-user local workspace, not a multi-user authorization service.

Documents persist as Yjs state under `~/.dsh/collaborative-docs` by default. Keep that directory when upgrading or uninstalling the plugin. The document API accepts Markdown text rather than arbitrary filesystem paths. The standalone server accepts `DSH_DOCS_DATA_DIR` or `--data-dir`; the plugin accepts `dataDir` and `port` configuration.

Only one process may open a data directory. A `.writer-lock` records its PID and start time. Clean shutdown removes the lock. After a crash, first verify that the recorded process has stopped, then remove only `.writer-lock` before reopening the workspace. Do not delete a live process's lock or its document files.

Saves flush the file before an atomic rename; supported platforms also flush the containing directory. Windows does not expose that directory-flush guarantee through Node, so the plugin supports process-restart recovery without promising power-loss durability on Windows.

## Development

```sh
npm run check
npm test
npm run build
```

The engine owns document state and persistence. The transport provides the local HTTP/WebSocket service. The DSH adapter registers agent tools and manages the service lifetime; the browser UI edits the same Yjs documents.

## License

Plugin code is MIT licensed. BlockNote is MPL-2.0 licensed. Its unmodified source is available in the pinned `@blocknote/*` npm packages and at [TypeCellOS/BlockNote](https://github.com/TypeCellOS/BlockNote). The build includes dependency licenses in `dist/THIRD_PARTY_NOTICES.txt`. This project does not use BlockNote XL or Tiptap's paid Comments extension.

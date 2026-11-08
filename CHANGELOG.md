# Changelog

## 0.1.0

- Local BlockNote editor with shared Yjs documents and threaded comments.
- Agent operations for document creation, revision-checked edits, comment replies, resolution, and Markdown export.
- Local HTTP and WebSocket authentication with persistent document state.
- DeepSeek Harness 0.2.1-rc.3 plugin integration and standalone development server.
- Isolated document-service process keeps BlockNote dependencies and DOM globals out of the DSH host.
- Initial synchronization retains edits committed while a browser connection is being established.

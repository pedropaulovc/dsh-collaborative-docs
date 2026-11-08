import React, { Component, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { CommentsExtension, DefaultThreadStoreAuth } from '@blocknote/core/comments';
import { withCollaboration, YjsThreadStore } from '@blocknote/core/yjs';
import { BlockNoteView } from '@blocknote/mantine';
import { BlockNoteViewEditor, ThreadsSidebar, useCreateBlockNote } from '@blocknote/react';
import { DocumentSync } from './sync.js';
import '@blocknote/mantine/style.css';
import './app.css';

type DocumentInfo = { id: string; title: string; updatedAt: string };
type Session = { info: DocumentInfo; sync: DocumentSync };

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, credentials: 'same-origin' });
  if (!response.ok) {
    let message = `Request failed (${response.status}).`;
    try {
      const body = await response.json();
      if (typeof body.message === 'string') message = body.message;
      else if (typeof body.error === 'string') message = body.error;
    } catch { /* Keep the HTTP status when an intermediary returns non-JSON. */ }
    if (response.status === 401 || response.status === 403) message += ' Reopen Documents from DSH to authorize this browser.';
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}

class EditorBoundary extends Component<{ children: React.ReactNode }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(error: Error) { return { error: error.message }; }
  render() {
    if (this.state.error) return <section className="state-panel" role="alert"><h2>The editor could not load</h2><p>{this.state.error}</p><p>Any unsaved synchronized state remains in this tab and in local recovery storage when available.</p><button type="button" onClick={() => this.setState({ error: null })}>Try editor again</button></section>;
    return this.props.children;
  }
}

function RichEditor({ session, userId }: { session: Session; userId: string }) {
  const [filter, setFilter] = useState<'open' | 'resolved' | 'all'>('open');
  const [commentsVisible, setCommentsVisible] = useState(true);
  const [hasSelection, setHasSelection] = useState(false);
  const [threadCount, setThreadCount] = useState(session.sync.doc.getMap('threads').size);
  const editor = useCreateBlockNote(withCollaboration({
    extensions: [CommentsExtension({
      threadStore: new YjsThreadStore(userId, session.sync.doc.getMap('threads'), new DefaultThreadStoreAuth(userId, 'editor')),
      resolveUsers: async (ids) => ids.map((id) => ({ id, username: id === 'agent' ? 'Agent' : id === userId ? 'You' : 'Collaborator', avatarUrl: '' })),
    })],
    collaboration: {
      fragment: session.sync.doc.getXmlFragment('blocknote'),
      user: { name: 'Collaborator', color: getComputedStyle(document.documentElement).getPropertyValue('--color-accent').trim() },
      provider: session.sync,
    },
  }), [session, userId]);
  useEffect(() => {
    const threads = session.sync.doc.getMap('threads');
    const onThreads = () => setThreadCount(threads.size);
    threads.observeDeep(onThreads);
    return () => threads.unobserveDeep(onThreads);
  }, [session]);
  return <>
    <div className="document-tools">
      <p>Select text to leave a comment. Type / for blocks.</p>
      <div className="tool-actions">
        <button type="button" disabled={!hasSelection} onMouseDown={(event) => event.preventDefault()} onClick={() => {
          setCommentsVisible(true);
          editor.getExtension(CommentsExtension)?.startPendingComment();
        }}>Add comment</button>
        <button type="button" aria-expanded={commentsVisible} aria-controls="comments-sidebar" onClick={() => setCommentsVisible(!commentsVisible)}>{commentsVisible ? 'Hide comments' : `Comments (${threadCount})`}</button>
      </div>
    </div>
    <BlockNoteView editor={editor} theme="light" renderEditor={false} onSelectionChange={() => setHasSelection(Boolean(editor.getSelectedText()))}>
      <div className={`editor-layout${commentsVisible ? '' : ' comments-hidden'}`}>
        <section className="document-paper" aria-label="Document editor"><BlockNoteViewEditor /></section>
        {commentsVisible && <aside id="comments-sidebar" className="comments-panel" aria-label="Document comments">
          <div className="comments-heading"><h2>Comments</h2><label><span className="visually-hidden">Filter comments</span><select value={filter} onChange={(event) => setFilter(event.target.value as typeof filter)}><option value="open">Open</option><option value="resolved">Resolved</option><option value="all">All comments</option></select></label></div>
          {threadCount === 0 && <p className="comments-empty">No comments yet. Select a passage and choose Add comment.</p>}
          <ThreadsSidebar filter={filter} sort="position" />
        </aside>}
      </div>
    </BlockNoteView>
  </>;
}

function OpenDocument({ session, userId }: { session: Session; userId: string }) {
  const sync = useSyncExternalStore(session.sync.subscribe, session.sync.getSnapshot);
  return <>
    <header className="document-heading"><div><h1>{session.info.title}</h1></div>
      <div className="save-state" role="status" aria-live="polite" data-warning={sync.connection !== 'connected' || sync.persistence === 'pending'}>
        {sync.connection !== 'connected' ? sync.persistence === 'pending' ? 'Offline: unsaved changes' : 'Connecting…' : sync.persistence === 'pending' ? 'Saving changes…' : 'All changes saved'}
        {sync.connection !== 'connected' && <button type="button" onClick={session.sync.reconnect}>Reconnect</button>}
      </div>
    </header>
    {sync.error && <div className="notice" role="alert"><p>{sync.error}</p><button type="button" onClick={session.sync.reconnect}>Retry connection</button></div>}
    {sync.readiness === 'loading' ? <section className="state-panel" role="status"><h2>Opening document</h2><p>Waiting for the server before starting the editor.</p></section> : <EditorBoundary><RichEditor session={session} userId={userId} /></EditorBoundary>}
  </>;
}

function App() {
  const [documents, setDocuments] = useState<DocumentInfo[]>([]);
  const [selected, setSelected] = useState<string | null>(new URL(location.href).searchParams.get('document'));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [dialog, setDialog] = useState(false);
  const [title, setTitle] = useState('');
  const [imported, setImported] = useState<{ name: string; markdown: string } | null>(null);
  const [exporting, setExporting] = useState(false);
  const [sessions, setSessions] = useState<Map<string, Session>>(() => new Map());
  const sessionsRef = useRef(sessions);
  const importInput = useRef<HTMLInputElement>(null);
  const titleInput = useRef<HTMLInputElement>(null);
  const [userId] = useState(() => {
    try {
      const existing = localStorage.getItem('shared-doc-user');
      if (existing) return existing;
      const id = `human:${crypto.randomUUID()}`;
      localStorage.setItem('shared-doc-user', id);
      return id;
    } catch { return `human:${crypto.randomUUID()}`; }
  });
  const loadDocuments = async () => {
    setLoading(true);
    setError(null);
    try { setDocuments(await request<DocumentInfo[]>('/api/documents')); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not load documents.'); }
    finally { setLoading(false); }
  };
  useEffect(() => { void loadDocuments(); }, []);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if ([...sessionsRef.current.values()].some((session) => session.sync.getSnapshot().persistence === 'pending')) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', beforeUnload);
    const onPopState = () => setSelected(new URL(location.href).searchParams.get('document'));
    window.addEventListener('popstate', onPopState);
    return () => {
      window.removeEventListener('beforeunload', beforeUnload);
      window.removeEventListener('popstate', onPopState);
      sessionsRef.current.forEach((session) => session.sync.destroy());
    };
  }, []);
  useEffect(() => {
    if (!selected || sessions.has(selected)) return;
    let cancelled = false;
    setError(null);
    request<DocumentInfo>(`/api/documents/${encodeURIComponent(selected)}`).then((info) => {
      if (cancelled) return;
      const next = new Map(sessionsRef.current);
      next.set(info.id, { info, sync: new DocumentSync(info.id) });
      sessionsRef.current = next;
      setSessions(next);
      setDocuments((current) => current.some((item) => item.id === info.id) ? current : [...current, info]);
    }).catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : 'Could not open document.'); });
    return () => { cancelled = true; };
  }, [selected, sessions]);
  useEffect(() => {
    if (!dialog) return;
    const previous = document.activeElement;
    titleInput.current?.focus();
    return () => { if (previous instanceof HTMLElement) previous.focus(); };
  }, [dialog]);
  const choose = (id: string) => {
    setError(null);
    setSelected(id || null);
    const url = new URL(location.href);
    if (id) url.searchParams.set('document', id); else url.searchParams.delete('document');
    history.pushState(null, '', url);
  };
  const selectedSession = selected ? sessions.get(selected) : undefined;
  return <div className="workspace">
    <header className="workspace-bar"><a className="workspace-name" href="/">Documents<span>Local collaborative workspace</span></a>
      <div className="workspace-actions"><label className="document-picker"><span className="visually-hidden">Select document</span><select value={selected ?? ''} onFocus={() => { if (!loading) void loadDocuments(); }} onChange={(event) => choose(event.target.value)}><option value="">Choose a document</option>{documents.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
      <button type="button" onClick={() => { setTitle(''); setImported(null); setDialog(true); }}>New document</button>
      <button type="button" onClick={() => importInput.current?.click()}>Import Markdown</button>
      <button type="button" disabled={!selectedSession || exporting} onClick={async () => {
        if (!selectedSession) return;
        if (selectedSession.sync.getSnapshot().persistence === 'pending') { setError('Wait for all changes to be saved before exporting. Reconnect to save offline edits.'); return; }
        setExporting(true); setError(null);
        try {
          const response = await fetch(`/api/documents/${encodeURIComponent(selectedSession.info.id)}/markdown`);
          if (!response.ok) throw new Error(`Export failed (${response.status}). Reopen from DSH if your session expired.`);
          const blob = new Blob([await response.text()], { type: 'text/markdown;charset=utf-8' });
          const url = URL.createObjectURL(blob);
          const link = document.createElement('a'); link.href = url;
          link.download = `${selectedSession.info.title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_') || 'document'}.md`;
          document.body.append(link); link.click(); link.remove();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not export document.'); }
        finally { setExporting(false); }
      }}>{exporting ? 'Exporting…' : 'Export'}</button></div>
    </header>
    <input className="visually-hidden" ref={importInput} type="file" accept=".md,.markdown,text/markdown,text/plain" tabIndex={-1} aria-label="Import Markdown file" onChange={async (event) => {
      const file = event.target.files?.[0]; event.target.value = '';
      if (!file) return;
      if (file.size > 700 * 1024) { setError('Choose a Markdown file smaller than 700 KB.'); return; }
      try {
        const markdown = await file.text();
        setImported({ name: file.name, markdown }); setTitle(file.name.replace(/\.(md|markdown)$/i, '')); setDialog(true);
      } catch { setError('This file could not be read. Choose the Markdown file again.'); }
    }} />
    <main>
      {error && <div className="notice" role="alert"><p>{error}</p><div className="tool-actions"><button type="button" onClick={() => { if (selected) { choose(''); } void loadDocuments(); }}>Reload document list</button><button type="button" onClick={() => setError(null)}>Dismiss</button></div></div>}
      {loading && documents.length === 0 && !selected ? <section className="state-panel" role="status"><h1>Loading your workspace</h1><p>Connecting to the local document server.</p></section> : !selected ? <section className="state-panel empty-state"><h1>{documents.length ? 'Pick up where you left off' : 'A place to work together'}</h1><p>{documents.length ? 'Choose a document above, or start something new.' : 'Write with your team and agents. Keep the conversation beside the text.'}</p><button type="button" className="primary" onClick={() => { setTitle(''); setImported(null); setDialog(true); }}>Create a document</button></section> : selectedSession ? <OpenDocument key={selected} session={selectedSession} userId={userId} /> : !error && <section className="state-panel" role="status"><h2>Loading document</h2><p>Fetching document details.</p></section>}
    </main>
    <footer className="workspace-footer"><span>Stored on your local server</span><span>Text and comments sync with connected agents</span></footer>
    {dialog && <div className="dialog-backdrop" onKeyDown={(event) => {
      if (event.key === 'Escape' && !creating) setDialog(false);
      if (event.key !== 'Tab') return;
      const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]')];
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (!first || !last) { event.preventDefault(); return; }
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }}><section className="create-dialog" role="dialog" aria-modal="true" aria-labelledby="create-heading"><h2 id="create-heading">{imported ? 'Import Markdown' : 'New document'}</h2><p>{imported ? `Create a document from ${imported.name}.` : 'Give this shared document a name.'}</p><form onSubmit={async (event) => {
      event.preventDefault(); if (!title.trim() || creating) return;
      setCreating(true); setError(null);
      try {
        const info = await request<DocumentInfo>('/api/documents', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: title.trim(), ...(imported ? { markdown: imported.markdown } : {}) }) });
        setDocuments((items) => [...items, info]); setDialog(false); setImported(null); choose(info.id);
      } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not create document.'); }
      finally { setCreating(false); }
    }}><label htmlFor="document-title">Document title</label><input ref={titleInput} id="document-title" value={title} maxLength={200} required disabled={creating} onChange={(event) => setTitle(event.target.value)} />
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-actions"><button type="button" disabled={creating} onClick={() => setDialog(false)}>Cancel</button><button className="primary" type="submit" disabled={creating || !title.trim()}>{creating ? 'Creating…' : imported ? 'Import document' : 'Create document'}</button></div>
    </form></section></div>}
  </div>;
}

const root = document.getElementById('root');
if (!root) throw new Error('Missing editor root.');
// Session objects are effect-owned; avoid destroying a shared Y.Doc during StrictMode effect replay.
createRoot(root).render(<App />);

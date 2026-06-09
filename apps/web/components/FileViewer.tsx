'use client';
import React, { useEffect, useState } from 'react';
import { API, api, type FileEditResult, type ApiError } from '@/lib/api';
import { ShikiCode } from '@/components/ShikiCode';
import { MarkdownView } from '@/components/MarkdownView';
import { Btn, Textarea } from '@/components/ui';

/**
 * Type-aware file viewer (v2 spec §4 #6 read-rendering + §4 #1 in-browser CRUD).
 *
 * READ view (default): rich rendering via Shiki + react-markdown:
 *   - code      → ShikiCode (plain-mono fallback while loading / on error)
 *   - markdown  → MarkdownView (react-markdown + remark-gfm; links sanitized, no raw HTML)
 *   - json      → ShikiCode (pretty-printed)
 *   - image     → <img …&raw=1>
 *   - binary / too-large → fallback descriptor
 *
 * EDIT mode (only when `editingEnabled` AND the blob is editable text): an "Edit" affordance swaps
 * the read view for a textarea seeded from `GET /files/edit` (working-tree bytes + the blob `oid`
 * held as the baseOid). "Commit" prompts for a message → `POST /files/commit {path,content,message,
 * baseOid}`. A 409 (stale/conflict) surfaces as an inline red box offering reload. A "Delete"
 * affordance commits `{path,delete:true,message}`. On success the new sha is shown and the parent
 * is told to refresh the tree/view via `onCommitted`. When `editingEnabled` is false NO edit/delete
 * affordance is shown (the server also 403s).
 *
 * Read view fetches `GET /api/projects/:id/files?path=<file>&content=1` → ShowFileResult.
 */

type ShowFileResult =
  | { binary: true; content?: undefined; truncated?: undefined; size: number | null; isImage: boolean; ext: string; error?: string }
  | { binary: false; content: string; truncated: boolean; size: number; isImage: false; ext: string; error?: string };

const MD_EXTS = new Set(['.md', '.markdown', '.mdx']);
const JSON_EXTS = new Set(['.json', '.jsonc', '.geojson']);

export function FileViewer({
  projectId,
  path,
  editingEnabled = false,
  newFile = false,
  onCommitted,
  onCancelNew,
}: {
  projectId: string;
  path: string | null;
  /** project.editingEnabled — gates all edit/delete affordances (server also 403s). */
  editingEnabled?: boolean;
  /** True when `path` is a brand-new file being created → open an empty buffer, skip the read fetch. */
  newFile?: boolean;
  /** Called after a successful commit so the page can refresh the tree (and clear a deleted path). */
  onCommitted?: (info: { path: string; deleted: boolean; sha: string }) => void;
  /** Called when the user cancels a never-committed new file (so the page can clear selection). */
  onCancelNew?: () => void;
}) {
  const [data, setData] = useState<ShowFileResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // ── edit-mode state (reset whenever the selected path changes) ──────────────
  const [editing, setEditing] = useState(false);
  const [editBuf, setEditBuf] = useState('');
  const [baseOid, setBaseOid] = useState<string | null>(null);
  const [editLoading, setEditLoading] = useState(false);
  const [editErr, setEditErr] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false); // 409 stale/worktree → offer reload
  const [busy, setBusy] = useState(false);
  const [okSha, setOkSha] = useState<string | null>(null);

  function resetEdit() {
    setEditing(false);
    setEditBuf('');
    setBaseOid(null);
    setEditLoading(false);
    setEditErr(null);
    setConflict(false);
    setBusy(false);
    setOkSha(null);
  }

  useEffect(() => {
    resetEdit();
    setData(null);
    setErr(null);
    if (!path) return;
    // Brand-new file: open an empty editable buffer (oid null → Commit sends no baseOid). Skip the
    // read fetch entirely — the file does not exist yet, so GET /files would just 200-with-error.
    if (newFile) {
      setLoading(false);
      setEditBuf('');
      setBaseOid(null);
      setEditing(true);
      return;
    }
    let alive = true;
    setLoading(true);
    fetch(`${API}/api/projects/${projectId}/files?path=${encodeURIComponent(path)}&content=1`)
      .then((r) => r.json())
      .then((d: ShowFileResult) => {
        if (!alive) return;
        if ((d as any).error) setErr((d as any).error);
        setData(d);
      })
      .catch((e) => alive && setErr(e?.message || 'failed to load file'))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [projectId, path, newFile]);

  /** Enter edit mode: pull the working-tree bytes + blob oid (the baseOid) from /files/edit. */
  async function enterEdit() {
    if (!path) return;
    setEditLoading(true);
    setEditErr(null);
    setConflict(false);
    setOkSha(null);
    try {
      const res: FileEditResult = await api.getFileForEdit(projectId, path);
      if (!res.editable || res.binary || res.tooLarge || res.content == null) {
        setEditErr(
          res.binary
            ? 'binary file — not editable'
            : res.tooLarge
              ? 'file too large to edit'
              : 'editing not available for this file',
        );
        setEditLoading(false);
        return;
      }
      setEditBuf(res.content);
      setBaseOid(res.oid);
      setEditing(true);
    } catch (e: any) {
      const ae = e as ApiError;
      setEditErr(ae?.message || 'failed to open file for editing');
      if (ae?.status === 409) setConflict(true);
    } finally {
      setEditLoading(false);
    }
  }

  /** Commit the current buffer (update existing → baseOid required; new path → no baseOid). */
  async function commit() {
    if (!path) return;
    const verb = baseOid == null ? 'Add' : 'Update';
    const message = window.prompt('Commit message', `${verb} ${path}`);
    if (message == null) return; // cancelled
    if (!message.trim()) {
      setEditErr('commit message is required');
      return;
    }
    setBusy(true);
    setEditErr(null);
    setConflict(false);
    try {
      const res = await api.commitFile(projectId, {
        path,
        content: editBuf,
        message: message.trim(),
        baseOid: baseOid ?? undefined,
      });
      if (!res.ok) {
        setEditErr(res.error); // git-command failure (HTTP 200 with ok:false)
        return;
      }
      setOkSha(res.sha);
      setEditing(false);
      // Reflect the just-committed bytes in the read view without a round-trip (and without re-running
      // the path effect, which would clear okSha). The freshly written content IS editBuf.
      setData((d) =>
        d && !d.binary ? { ...d, content: editBuf, size: new Blob([editBuf]).size, truncated: false } : d,
      );
      onCommitted?.({ path, deleted: false, sha: res.sha });
    } catch (e: any) {
      const ae = e as ApiError;
      setEditErr(ae?.message || 'commit failed');
      if (ae?.status === 409) setConflict(true);
    } finally {
      setBusy(false);
    }
  }

  /** Delete the current file: commit {path,delete:true,message}. */
  async function del() {
    if (!path) return;
    if (!window.confirm(`Delete "${path}"? This commits a deletion to the real git history.`)) return;
    const message = window.prompt('Commit message', `Delete ${path}`);
    if (message == null) return;
    if (!message.trim()) {
      setEditErr('commit message is required');
      return;
    }
    setBusy(true);
    setEditErr(null);
    setConflict(false);
    try {
      const res = await api.commitFile(projectId, { path, delete: true, message: message.trim() });
      if (!res.ok) {
        setEditErr(res.error);
        return;
      }
      onCommitted?.({ path, deleted: true, sha: res.sha });
    } catch (e: any) {
      const ae = e as ApiError;
      setEditErr(ae?.message || 'delete failed');
      if (ae?.status === 409) setConflict(true);
    } finally {
      setBusy(false);
    }
  }

  /** "Reload" after a 409: re-pull working-tree bytes + the fresh oid, replacing the buffer. */
  async function reload() {
    if (!path) return;
    setConflict(false);
    await enterEdit();
  }

  if (!path)
    return (
      <div className="font-mono text-[12px] text-faint border border-dashed border-line2 h-full flex items-center justify-center">
        Select a file from the tree.
      </div>
    );
  if (loading) return <div className="font-mono text-[12px] text-faint p-4">loading {path}…</div>;
  if (err)
    return (
      <div className="font-mono text-[12px] text-sig-failed border border-sig-failed/30 bg-sig-failed/5 px-3 py-2 m-2">
        {path} — {err}
      </div>
    );
  if (!data) return null;

  const ext = data.ext || extOf(path);
  // An Edit affordance only makes sense for displayable text (not images / other binary).
  const canShowEdit = editingEnabled && !data.binary;

  // ── EDIT MODE ───────────────────────────────────────────────────────────────
  if (editing) {
    return (
      <div className="flex flex-col h-full">
        <EditBar path={path} size={editBuf.length}>
          <Btn variant="solid" onClick={commit} disabled={busy}>
            {busy ? 'Committing…' : '✓ Commit'}
          </Btn>
          <Btn
            variant="ghost"
            onClick={() => (newFile ? onCancelNew?.() : resetEdit())}
            disabled={busy}
          >
            Cancel
          </Btn>
        </EditBar>
        {(editErr || conflict) && (
          <ConflictBox message={editErr ?? 'conflict'} conflict={conflict} onReload={reload} />
        )}
        <Textarea
          value={editBuf}
          onChange={(e) => setEditBuf(e.target.value)}
          spellCheck={false}
          className="flex-1 !text-[12px] leading-relaxed m-2 min-h-[420px]"
          style={{ fontFamily: 'var(--font-mono, ui-monospace, monospace)' }}
        />
        <div className="font-mono text-[10px] text-faint px-3 pb-2">
          committing writes to the real git history{baseOid ? ` · base ${baseOid.slice(0, 8)}` : ' · new file'}
        </div>
      </div>
    );
  }

  // ── READ VIEW ─────────────────────────────────────────────────────────────────
  const editAffordance = (
    <>
      {editLoading && <span className="text-faint">opening…</span>}
      {canShowEdit && !editLoading && (
        <button onClick={enterEdit} className="text-dim hover:text-amber underline">
          edit
        </button>
      )}
      {editingEnabled && (
        <button onClick={del} disabled={busy} className="text-dim hover:text-sig-failed underline">
          delete
        </button>
      )}
      {okSha && <span className="text-sig-completed">committed {okSha.slice(0, 8)}</span>}
    </>
  );

  // image
  if (data.binary && data.isImage) {
    return (
      <div className="overflow-auto h-full">
        <ReadBar path={path} size={data.size}>
          <span>image</span>
          {editAffordance}
        </ReadBar>
        {(editErr || conflict) && <ConflictBox message={editErr ?? 'conflict'} conflict={conflict} onReload={reload} />}
        <div className="p-4">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`${API}/api/projects/${projectId}/files?path=${encodeURIComponent(path)}&raw=1`}
            alt={path}
            style={{ maxWidth: '100%', height: 'auto', border: '1px solid rgba(255,255,255,0.08)' }}
          />
        </div>
      </div>
    );
  }
  // other binary
  if (data.binary) {
    return (
      <div className="overflow-auto h-full">
        <ReadBar path={path} size={data.size}>
          {editAffordance}
        </ReadBar>
        {(editErr || conflict) && <ConflictBox message={editErr ?? 'conflict'} conflict={conflict} onReload={reload} />}
        <div className="p-4">
          <div className="font-mono text-[12px] text-faint border border-line2 px-3 py-4">
            Binary file ({fmtBytes(data.size)}) — not displayed.
          </div>
        </div>
      </div>
    );
  }

  const isMd = MD_EXTS.has(ext);
  const isJson = JSON_EXTS.has(ext);

  return (
    <div className="overflow-auto h-full">
      <ReadBar path={path} size={data.size} truncated={data.truncated}>
        {editAffordance}
      </ReadBar>
      {(editErr || conflict) && <ConflictBox message={editErr ?? 'conflict'} conflict={conflict} onReload={reload} />}
      <div className="px-4 pb-6">
        {isMd ? (
          <MarkdownView source={data.content} />
        ) : isJson ? (
          <ShikiCode code={prettyJson(data.content)} lang="json" />
        ) : (
          <ShikiCode code={data.content} lang={ext || 'text'} />
        )}
      </div>
    </div>
  );
}

// ── chrome ─────────────────────────────────────────────────────────────────────

function ReadBar({
  path,
  size,
  truncated,
  children,
}: {
  path: string;
  size: number | null;
  truncated?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className="font-mono text-[10px] text-faint px-4 pt-3 pb-2 flex items-center gap-3 sticky top-0 bg-[#0d0f12]/90 backdrop-blur-sm z-10">
      <span className="text-dim truncate">{path}</span>
      <span>{fmtBytes(size)}</span>
      {truncated && <span className="text-amber">· truncated</span>}
      <span className="ml-auto flex items-center gap-3">{children}</span>
    </div>
  );
}

function EditBar({ path, size, children }: { path: string; size: number; children?: React.ReactNode }) {
  return (
    <div className="font-mono text-[10px] text-faint px-4 pt-3 pb-2 flex items-center gap-3 border-b hairline">
      <span className="text-amber uppercase tracking-wider">editing</span>
      <span className="text-dim truncate">{path}</span>
      <span>{fmtBytes(size)}</span>
      <span className="ml-auto flex items-center gap-2">{children}</span>
    </div>
  );
}

function ConflictBox({ message, conflict, onReload }: { message: string; conflict: boolean; onReload: () => void }) {
  return (
    <div className="font-mono text-[11px] text-sig-failed border border-sig-failed/30 bg-sig-failed/5 px-3 py-2 m-2 flex items-center gap-3">
      <span className="flex-1">
        {conflict ? '⚠ conflict: ' : ''}
        {message}
      </span>
      {conflict && (
        <button onClick={onReload} className="underline hover:text-amber shrink-0">
          reload latest
        </button>
      )}
    </div>
  );
}

// ── helpers ──────────────────────────────────────────────────────────────────

function prettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw; // not strictly valid (jsonc/comments) → show as-is
  }
}

function extOf(p: string): string {
  const dot = p.lastIndexOf('.');
  const slash = p.lastIndexOf('/');
  return dot > slash ? p.slice(dot).toLowerCase() : '';
}

function fmtBytes(n: number | null): string {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

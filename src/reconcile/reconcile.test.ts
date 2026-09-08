import { describe, expect, it } from 'vitest';

import { sha1, World } from '../testing/world.js';
import { classifyLocal, classifyRemote, findLocalCounterpart } from './classify.js';
import { orderOperations } from './order.js';
import { reconcile } from './reconcile.js';
import { allCells, SIDE_STATES } from './table.js';
import type { BaselineItem, LocalItem, Operation, RemoteItem } from './types.js';

const kinds = (plan: ReturnType<typeof reconcile>) => plan.operations.map((o) => o.kind);
const describeOp = (o: Operation): string => (o.kind === 'move_local' || o.kind === 'move_remote' ? `${o.kind}:${o.from}>${o.to}` : `${o.kind}:${o.relPath}`);

describe('side-state classifier', () => {
  const base: BaselineItem = {
    relPath: 'a.txt',
    kind: 'file',
    local: { dev: 1, ino: 10, size: 5, mtimeMs: 100, sha1: sha1('hello') },
    remote: { uid: 'n1', parentUid: 'root', name: 'a.txt', revisionUid: 'r1', sha1: sha1('hello') },
  };
  const local = (over: Partial<LocalItem>): LocalItem => ({ relPath: 'a.txt', kind: 'file', dev: 1, ino: 10, size: 5, mtimeMs: 100, sha1: sha1('hello'), ...over });
  const remote = (over: Partial<RemoteItem>): RemoteItem => ({ uid: 'n1', parentUid: 'root', name: 'a.txt', kind: 'file', nameStatus: 'ok', isTrashed: false, isProtonDocument: false, revisionUid: 'r1', sha1: sha1('hello'), ...over });

  it('classifies every local state', () => {
    expect(classifyLocal(base, local({})).state).toBe('unchanged');
    expect(classifyLocal(base, local({ sha1: sha1('other'), mtimeMs: 200 })).state).toBe('modified');
    expect(classifyLocal(base, local({ relPath: 'b.txt' })).state).toBe('moved');
    expect(classifyLocal(base, local({ relPath: 'b.txt', sha1: sha1('x'), size: 1 })).state).toBe('movedAndModified');
    expect(classifyLocal(base, undefined).state).toBe('deleted');
  });

  it('decides content by digest, not by time: same time different content is modified, different time same content is unchanged', () => {
    const sameTimeDifferentContent = classifyLocal(base, local({ sha1: sha1('different') }));
    expect(sameTimeDifferentContent.state).toBe('modified');
    const differentTimeSameContent = classifyLocal(base, local({ mtimeMs: 999, ino: 77 }));
    expect(differentTimeSameContent.state).toBe('unchanged');
    // Without a digest, a changed size/mtime is conservatively modified and flagged.
    const noDigest = classifyLocal(base, local({ sha1: undefined, mtimeMs: 999 }));
    expect(noDigest.state).toBe('modified');
    expect(noDigest.digestUnknown).toBe(true);
    // Without a digest but identical stat, unchanged.
    expect(classifyLocal(base, local({ sha1: undefined })).state).toBe('unchanged');
  });

  it('classifies every remote state, treating trash as deleted and using revision when no digest is claimed', () => {
    expect(classifyRemote(base, remote({}), 'a.txt').state).toBe('unchanged');
    expect(classifyRemote(base, remote({ sha1: sha1('new'), revisionUid: 'r2' }), 'a.txt').state).toBe('modified');
    expect(classifyRemote(base, remote({ name: 'b.txt' }), 'b.txt').state).toBe('moved');
    expect(classifyRemote(base, remote({ name: 'b.txt', sha1: sha1('new') }), 'b.txt').state).toBe('movedAndModified');
    expect(classifyRemote(base, remote({ isTrashed: true }), undefined).state).toBe('deleted');
    expect(classifyRemote(base, undefined, undefined).state).toBe('deleted');
    const noClaim: BaselineItem = { ...base, remote: { ...base.remote, sha1: null } };
    expect(classifyRemote(noClaim, remote({ sha1: undefined, revisionUid: 'r1' }), 'a.txt').state).toBe('unchanged');
    expect(classifyRemote(noClaim, remote({ sha1: undefined, revisionUid: 'r9' }), 'a.txt').state).toBe('modified');
  });

  it('finds a moved local counterpart by identity, and reports content changes on it as movedAndModified', () => {
    const items = new Map<string, LocalItem>([['moved/a.txt', local({ relPath: 'moved/a.txt' })]]);
    const byIdentity = new Map([['file:1:10', [...items.values()]]]);
    expect(findLocalCounterpart(base, items, byIdentity)?.relPath).toBe('moved/a.txt');
    const edited = new Map<string, LocalItem>([['other.txt', local({ relPath: 'other.txt', size: 99, sha1: sha1('zzz') })]]);
    const counterpart = findLocalCounterpart(base, edited, new Map([['file:1:10', [...edited.values()]]]));
    expect(classifyLocal(base, counterpart).state).toBe('movedAndModified');
    // Two candidates with the same inode (hard links) are ambiguous: no counterpart.
    const two = new Map<string, LocalItem>([['p.txt', local({ relPath: 'p.txt' })], ['q.txt', local({ relPath: 'q.txt' })]]);
    expect(findLocalCounterpart(base, two, new Map([['file:1:10', [...two.values()]]]))).toBeUndefined();
  });
});

describe('decision table', () => {
  it('defines every (local x remote) cell', () => {
    const cells = allCells();
    expect(cells).toHaveLength(SIDE_STATES.length * SIDE_STATES.length);
    for (const c of cells) {
      expect(c.action, `${c.local} x ${c.remote}`).toBeDefined();
      expect(typeof c.action.type).toBe('string');
    }
    // Spot-check the safety-critical cells.
    const find = (l: string, r: string) => cells.find((c) => c.local === l && c.remote === r)?.action;
    expect(find('unchanged', 'deleted')).toEqual({ type: 'recycle_local' });
    expect(find('modified', 'deleted')).toEqual({ type: 'conflict_delete_vs_edit', deletedOn: 'remote' });
    expect(find('deleted', 'modified')).toEqual({ type: 'conflict_delete_vs_edit', deletedOn: 'local' });
    expect(find('deleted', 'unchanged')).toEqual({ type: 'trash_remote' });
    expect(find('deleted', 'deleted')).toEqual({ type: 'remove_baseline' });
    expect(find('modified', 'modified')).toEqual({ type: 'compare_content' });
  });
});

describe('reconcile', () => {
  function synced(): World {
    const w = new World();
    w.localMkdir('docs');
    w.localWrite('docs/a.txt', 'A');
    w.localWrite('docs/b.txt', 'B');
    w.localWrite('top.txt', 'T');
    w.remoteMkdir('docs');
    w.remoteWrite('docs/a.txt', 'A');
    w.remoteWrite('docs/b.txt', 'B');
    w.remoteWrite('top.txt', 'T');
    w.markAllSynced();
    return w;
  }

  it('produces identical plans for identical inputs and no operations when nothing changed', () => {
    const w = synced();
    const p1 = reconcile(w.input());
    const p2 = reconcile(w.input());
    expect(p1).toEqual(p2);
    expect(p1.operations).toEqual([]);
    expect(p1.conflicts).toEqual([]);
  });

  it('propagates a one-sided change and records evidence', () => {
    const w = synced();
    w.localWrite('docs/a.txt', 'A2');
    const plan = reconcile(w.input());
    expect(kinds(plan)).toEqual(['upload']);
    const up = plan.operations[0];
    expect(up?.kind === 'upload' && up.mode).toBe('revision');
    expect(up?.evidence.join(' ')).toMatch(/local: digest/);
    w.apply(plan);
    w.remoteWrite('top.txt', 'T2');
    expect(kinds(reconcile(w.input()))).toEqual(['download']);
  });

  it('identical change on both sides updates the baseline without transferring; different change is a conflict', () => {
    const w = synced();
    w.localWrite('docs/a.txt', 'SAME');
    w.remoteWrite('docs/a.txt', 'SAME');
    expect(kinds(reconcile(w.input()))).toEqual(['update_baseline']);
    w.apply(reconcile(w.input()));
    w.localWrite('docs/a.txt', 'L');
    w.remoteWrite('docs/a.txt', 'R');
    const plan = reconcile(w.input());
    expect(plan.operations).toEqual([]);
    expect(plan.conflicts).toEqual([expect.objectContaining({ kind: 'content', relPath: 'docs/a.txt' })]);
  });

  describe('moves', () => {
    it('remote move becomes a local move, keeping the node and content', () => {
      const w = synced();
      w.remoteMove('docs/a.txt', 'docs/renamed.txt');
      const plan = reconcile(w.input());
      expect(plan.operations.map(describeOp)).toEqual(['move_local:docs/a.txt>docs/renamed.txt']);
    });

    it('local move becomes a remote move', () => {
      const w = synced();
      w.localMkdir('archive');
      w.remoteMkdir('archive');
      w.markSynced('archive');
      w.localMove('top.txt', 'archive/top.txt');
      const plan = reconcile(w.input());
      expect(plan.operations.map(describeOp)).toEqual(['move_remote:top.txt>archive/top.txt']);
    });

    it('move plus edit orders the move before the content update', () => {
      const w = synced();
      w.localMove('top.txt', 'renamed.txt');
      w.localWrite('renamed.txt', 'T-edited');
      const plan = reconcile(w.input());
      expect(plan.operations.map(describeOp)).toEqual(['move_remote:top.txt>renamed.txt', 'upload:renamed.txt']);
    });

    it('folder move is a single move without re-transferring descendants', () => {
      const w = synced();
      w.localMove('docs', 'documents');
      const plan = reconcile(w.input());
      expect(plan.operations.map(describeOp)).toEqual(['move_remote:docs>documents']);
      w.apply(plan);
      expect(reconcile(w.input()).operations).toEqual([]);
      expect([...w.remoteFiles().keys()].sort()).toEqual(['documents/a.txt', 'documents/b.txt', 'top.txt']);
    });

    it('divergent moves are a conflict, same-destination moves converge', () => {
      const w = synced();
      w.localMove('top.txt', 'x.txt');
      w.remoteMove('top.txt', 'y.txt');
      const plan = reconcile(w.input());
      expect(plan.operations).toEqual([]);
      expect(plan.conflicts).toEqual([expect.objectContaining({ kind: 'divergent_move', localPath: 'x.txt', remotePath: 'y.txt' })]);
      const w2 = synced();
      w2.localMove('top.txt', 'same.txt');
      w2.remoteMove('top.txt', 'same.txt');
      expect(kinds(reconcile(w2.input()))).toEqual(['update_baseline']);
    });
  });

  describe('deletion rules', () => {
    it('deleted remotely and unchanged locally: recycle the local copy', () => {
      const w = synced();
      w.remoteTrash('docs/b.txt');
      const plan = reconcile(w.input());
      expect(plan.operations.map(describeOp)).toEqual(['recycle_local:docs/b.txt']);
      w.apply(plan);
      expect(w.recycled.map((r) => r.content)).toEqual(['B']);
    });

    it('deleted remotely but modified locally: conflict, nothing deleted', () => {
      const w = synced();
      w.remoteTrash('docs/b.txt');
      w.localWrite('docs/b.txt', 'B-edited');
      const plan = reconcile(w.input());
      expect(plan.operations).toEqual([]);
      expect(plan.conflicts).toEqual([expect.objectContaining({ kind: 'delete_vs_edit', deletedOn: 'remote', relPath: 'docs/b.txt' })]);
    });

    it('deleted locally and unchanged remotely: trash remote; deleted locally but edited remotely: conflict', () => {
      const w = synced();
      w.localDelete('top.txt');
      expect(reconcile(w.input()).operations.map(describeOp)).toEqual(['trash_remote:top.txt']);
      const w2 = synced();
      w2.localDelete('top.txt');
      w2.remoteWrite('top.txt', 'T2');
      const plan = reconcile(w2.input());
      expect(plan.operations).toEqual([]);
      expect(plan.conflicts[0]).toMatchObject({ kind: 'delete_vs_edit', deletedOn: 'local' });
    });

    it('present on one side without baseline is a create, never a delete', () => {
      const w = synced();
      w.localWrite('new-local.txt', 'NL');
      w.remoteWrite('new-remote.txt', 'NR');
      const plan = reconcile(w.input());
      expect(plan.operations.map(describeOp).sort()).toEqual(['download:new-remote.txt', 'upload:new-local.txt']);
      expect(plan.stats.deletes).toBe(0);
    });

    it('gone on both sides removes the baseline row only', () => {
      const w = synced();
      w.localDelete('top.txt');
      w.remoteTrash('top.txt');
      expect(kinds(reconcile(w.input()))).toEqual(['remove_baseline']);
    });
  });

  describe('ordering', () => {
    it('creates parent folders before children and deletes deepest first, moves before folder deletion', () => {
      const w = synced();
      w.localMkdir('new/deep');
      w.localWrite('new/deep/f.txt', 'F');
      w.remoteTrash('docs'); // whole folder gone remotely, local unchanged -> recycle docs and children
      const plan = reconcile(w.input());
      const ops = plan.operations.map(describeOp);
      expect(ops.indexOf('create_remote_folder:new')).toBeLessThan(ops.indexOf('create_remote_folder:new/deep'));
      expect(ops.indexOf('create_remote_folder:new/deep')).toBeLessThan(ops.indexOf('upload:new/deep/f.txt'));
      const recycleDocs = ops.indexOf('recycle_local:docs');
      expect(ops.indexOf('recycle_local:docs/a.txt')).toBeLessThan(recycleDocs);
      expect(ops.indexOf('recycle_local:docs/b.txt')).toBeLessThan(recycleDocs);
    });

    it('a child moved out of a folder is ordered before that folder is deleted', () => {
      const w = synced();
      w.remoteMove('docs/a.txt', 'a.txt');
      w.remoteTrash('docs/b.txt');
      w.remoteTrash('docs');
      const ops = reconcile(w.input()).operations.map(describeOp);
      expect(ops.indexOf('move_local:docs/a.txt>a.txt')).toBeLessThan(ops.indexOf('recycle_local:docs'));
    });

    it('blocks move cycles', () => {
      const ops: Operation[] = [
        { id: 'a', kind: 'move_local', from: 'x', to: 'y', remoteUid: 'n1', expectedLocal: { dev: 1, ino: 1, size: 1, mtimeMs: 1 }, evidence: [] },
        { id: 'b', kind: 'move_local', from: 'y', to: 'x', remoteUid: 'n2', expectedLocal: { dev: 1, ino: 2, size: 1, mtimeMs: 1 }, evidence: [] },
        { id: 'c', kind: 'move_local', from: 'p', to: 'q', remoteUid: 'n3', expectedLocal: { dev: 1, ino: 3, size: 1, mtimeMs: 1 }, evidence: [] },
      ];
      const { ordered, blocked } = orderOperations(ops);
      expect(ordered.map((o) => o.id)).toEqual(['c']);
      expect(blocked.map((b) => b.reason)).toEqual(['move_cycle', 'move_cycle']);
    });
  });

  describe('names', () => {
    it('blocks remote siblings differing only by case, downloading neither', () => {
      const w = new World();
      w.remoteWrite('Report.txt', 'a');
      w.remoteWrite('report.txt', 'b');
      w.remoteWrite('other.txt', 'c');
      const plan = reconcile(w.input());
      expect(plan.operations.map(describeOp)).toEqual(['download:other.txt']);
      expect(plan.blocked.filter((b) => b.reason === 'case_collision').map((b) => b.relPath).sort()).toEqual(['Report.txt', 'report.txt']);
    });

    it('blocks local siblings differing only by Unicode normalisation', () => {
      const w = new World();
      w.localWrite('café.txt', 'a'); // é
      w.localWrite('café.txt', 'b'); // e + combining acute
      const plan = reconcile(w.input());
      expect(plan.operations).toEqual([]);
      expect(plan.blocked).toHaveLength(2);
    });

    it('blocks undecryptable remote nodes and never deletes them', () => {
      const w = synced();
      const input = w.input();
      const items = new Map(input.remote.items);
      items.set('bad', { uid: 'bad', parentUid: 'root', name: '?', kind: 'file', nameStatus: 'undecryptable', isTrashed: false, isProtonDocument: false });
      const plan = reconcile({ ...input, remote: { ...input.remote, items } });
      expect(plan.operations).toEqual([]);
      expect(plan.blocked).toEqual([expect.objectContaining({ reason: 'undecryptable', remoteUid: 'bad' })]);
    });

    it('blocks a file on one side and a folder on the other', () => {
      const w = new World();
      w.localWrite('thing', 'file');
      w.remoteMkdir('thing');
      const plan = reconcile(w.input());
      expect(plan.operations).toEqual([]);
      expect(plan.blocked[0]?.reason).toBe('kind_mismatch');
    });
  });

  describe('completeness gate', () => {
    it('withholds local deletes and requires confirmation when the remote is empty but the baseline is not', () => {
      const w = synced();
      for (const p of ['docs/a.txt', 'docs/b.txt', 'docs', 'top.txt']) w.remoteTrash(p);
      const plan = reconcile(w.input());
      expect(plan.operations).toEqual([]);
      expect(plan.withheld.map((x) => x.operation.kind)).toEqual(['recycle_local', 'recycle_local', 'recycle_local', 'recycle_local']);
      expect(plan.requiresConfirmation).toMatch(/remote root is empty/);
    });

    it('plans no remote trash when the local root is unavailable, and no local recycle when the remote is unavailable', () => {
      const w = synced();
      const gone = reconcile(w.input({ local: { items: new Map(), complete: false, available: false } }));
      expect(gone.operations.filter((o) => o.kind === 'trash_remote')).toEqual([]);
      expect(gone.operations).toEqual([]);
      const w2 = synced();
      w2.remoteTrash('top.txt');
      const remoteDown = reconcile(w2.input({ remote: { ...w2.input().remote, available: false } }));
      expect(remoteDown.operations.filter((o) => o.kind === 'recycle_local')).toEqual([]);
      expect(remoteDown.withheld.some((x) => x.reason === 'remote unavailable')).toBe(true);
    });

    it('does not trust absence when a listing is incomplete', () => {
      const w = synced();
      const input = w.input();
      const items = new Map(input.local.items);
      items.delete('top.txt');
      const plan = reconcile({ ...input, local: { items, complete: false, available: true } });
      expect(plan.operations).toEqual([]);
      expect(plan.blocked.some((b) => b.relPath === 'top.txt')).toBe(true);
    });
  });

  describe('first sync', () => {
    it('never deletes and treats differing same-path files as conflicts', () => {
      const w = new World();
      w.localWrite('only-local.txt', 'L');
      w.localWrite('shared.txt', 'local version');
      w.localWrite('same.txt', 'identical');
      w.remoteWrite('only-remote.txt', 'R');
      w.remoteWrite('shared.txt', 'remote version');
      w.remoteWrite('same.txt', 'identical');
      const plan = reconcile(w.input());
      expect(plan.firstSync).toBe(true);
      expect(plan.stats.deletes).toBe(0);
      expect(plan.operations.map(describeOp).sort()).toEqual(['download:only-remote.txt', 'update_baseline:same.txt', 'upload:only-local.txt']);
      expect(plan.conflicts).toEqual([expect.objectContaining({ kind: 'create_create', relPath: 'shared.txt' })]);
    });
  });

  it('skips quarantined items entirely', () => {
    const w = synced();
    w.localWrite('top.txt', 'changed');
    const plan = reconcile(w.input({ quarantinedPaths: new Set(['top.txt']) }));
    expect(plan.operations).toEqual([]);
    expect(plan.blocked[0]?.reason).toBe('quarantined');
  });
});

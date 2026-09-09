import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SessionState, SessionStatus } from '../remote/proton/sessionState.js';
import { JournalRepo } from '../state/journal.js';
import { EngineHarness } from '../testing/engineHarness.js';

/**
 * Recovery and session journeys (spec: test-suite / Stop and restart; Session
 * dies while running). A restart recovers an in-progress journal row before it
 * plans anything, and a session rejected during a listing or a transfer takes
 * the engine to needs-login without deleting, then resumes after a new login.
 */

/** A minimal SessionState stand-in: the engine only uses current/onChange/handleRemoteError. */
class FakeSession {
  current: SessionStatus = 'logged_in';
  private readonly listeners = new Set<(s: SessionStatus) => void>();
  onChange(listener: (s: SessionStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  handleRemoteError(): Promise<void> {
    this.set('needs_login');
    return Promise.resolve();
  }
  login(): void {
    this.set('logged_in');
  }
  private set(s: SessionStatus): void {
    if (s === this.current) return;
    this.current = s;
    for (const l of this.listeners) l(s);
  }
}

const RESTING = ['idle', 'attention', 'needs_login', 'error', 'paused', 'offline'] as const;

let h: EngineHarness;
beforeEach(() => {
  h = EngineHarness.create();
});
afterEach(async () => {
  h.assertNoUserContentLost();
  await h.dispose();
});

describe('recovery and session', () => {
  it('Stop and restart: an in-progress journal row is recovered before the next plan, losing nothing', async () => {
    h.write('a.txt', 'A');
    await h.start();
    await h.waitForConvergence();

    // Simulate a crash mid-upload of b.txt: the bytes reached the remote, but the journal row
    // was never completed. Recovery on restart must reconcile it — never re-run or delete.
    h.write('b.txt', 'B');
    h.fake.seedFile(h.remoteRootUid, 'b.txt', 'B'); // the upload that "already happened"
    const journal = new JournalRepo(h.live.store);
    const planned = journal.plan({
      op: 'upload',
      relPath: 'b.txt',
      previousRelPath: null,
      nodeUid: null,
      intended: { id: 'j1', kind: 'upload', relPath: 'b.txt', mode: 'new', remoteUid: undefined, expectedLocal: { dev: 0, ino: 0, size: 1, mtimeMs: 0 }, expectedRemote: undefined, evidence: ['interrupted'] },
      preState: null,
    });
    journal.start(planned.id);
    expect(journal.unresolved()).toHaveLength(1);

    await h.restart();
    await h.waitForConvergence();

    // Recovery ran before the new plan: the row is resolved and both files are intact on both sides.
    expect(new JournalRepo(h.live.store).unresolved()).toEqual([]);
    expect(h.localFiles().get('b.txt')).toBe('B');
    expect(h.remoteFiles().get('b.txt')).toBe('B');
    expect(h.fake.trashedUids()).toEqual([]);
    const recovery = h.audit.readAll().entries.filter((e) => e.kind === 'recovery' && e.op === 'upload');
    expect(recovery.length, 'the in-progress upload was recovered').toBeGreaterThanOrEqual(1);
  });

  it('Session dies during a listing: needs-login, no delete, and a new login resumes', async () => {
    const session = new FakeSession();
    h.write('local.txt', 'L');
    h.fake.seedFile(h.remoteRootUid, 'remote.txt', 'R');
    // The first remote listing is rejected.
    h.fake.injectFault('list', { kind: 'auth' });
    await h.start({ session: session as unknown as SessionState });
    await h.waitFor([...RESTING]);

    expect(h.bundle?.engine.getStatus().state).toBe('needs_login');
    expect(session.current, 'a rejected listing clears the session').toBe('needs_login');
    expect(h.fake.trashedUids(), 'no trash on session loss').toEqual([]);

    // A new login in the same process resumes and converges.
    session.login();
    await h.waitForConvergence(15_000);
    expect(h.localFiles().get('remote.txt')).toBe('R');
    expect(h.remoteFiles().get('local.txt')).toBe('L');
  });

  it('Session dies during a transfer: upload-auth clears the session, does not delete, and resumes', async () => {
    const session = new FakeSession();
    h.write('up.txt', 'U');
    // The upload is rejected mid-cycle.
    h.fake.injectFault('upload', { kind: 'auth' });
    await h.start({ session: session as unknown as SessionState });
    await h.waitFor([...RESTING]);

    expect(h.bundle?.engine.getStatus().state).toBe('needs_login');
    expect(session.current, 'an upload that rejects the session must clear it (wire upload-auth to the session)').toBe('needs_login');
    expect(h.fake.trashedUids(), 'no trash on session loss').toEqual([]);

    // A new login in the same process resumes and the upload completes.
    session.login();
    await h.waitForConvergence(15_000);
    expect(h.remoteFiles().get('up.txt')).toBe('U');
  });
});

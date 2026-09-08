/**
 * The decision table: (local state x remote state) -> action, for items that
 * exist in the baseline. Every cell is filled; the test suite enumerates them.
 *
 *  L \ R        | unchanged        | modified          | moved                 | movedAndModified        | deleted
 *  -------------+------------------+-------------------+-----------------------+-------------------------+------------------------
 *  unchanged    | none             | download          | move_local            | move_local + download   | recycle_local
 *  modified     | upload           | same? sync : C    | move_local + upload   | move_local + same?:C    | C delete_vs_edit (R)
 *  moved        | move_remote      | move_remote + dl  | dest= ? sync : C dm   | dest= ? download : C dm | C delete_vs_edit (R)
 *  movedAndMod  | move_remote + up | move_remote+same?C| dest= ? upload : C dm | dest= ? same?:C : C dm  | C delete_vs_edit (R)
 *  deleted      | trash_remote     | C delete_vs_edit L| C delete_vs_edit (L)  | C delete_vs_edit (L)    | remove_baseline
 *
 *  "same?" = content digests equal -> update_baseline only; otherwise C (content conflict).
 *  "dest=" = both sides moved to the same relative path.
 *  "C dm"  = divergent_move conflict. "(R)"/"(L)" = which side deleted.
 */
import type { SideState } from './types.js';

export type Action =
  | { type: 'none' }
  | { type: 'download' }
  | { type: 'upload' }
  | { type: 'move_local' }
  | { type: 'move_remote' }
  | { type: 'move_local_then_download' }
  | { type: 'move_local_then_upload' }
  | { type: 'move_remote_then_download' }
  | { type: 'move_remote_then_upload' }
  | { type: 'recycle_local' }
  | { type: 'trash_remote' }
  | { type: 'remove_baseline' }
  /** Both edited: compare digests; equal -> update_baseline, else content conflict. */
  | { type: 'compare_content'; after?: 'move_local' | 'move_remote' }
  /** Both moved: compare destinations; equal -> `whenSame`, else divergent_move conflict. */
  | { type: 'compare_destination'; whenSame: 'none' | 'download' | 'upload' | 'compare_content' }
  | { type: 'conflict_delete_vs_edit'; deletedOn: 'local' | 'remote' };

export const SIDE_STATES: readonly SideState[] = ['unchanged', 'modified', 'moved', 'movedAndModified', 'deleted'];

const TABLE: Record<SideState, Record<SideState, Action>> = {
  unchanged: {
    unchanged: { type: 'none' },
    modified: { type: 'download' },
    moved: { type: 'move_local' },
    movedAndModified: { type: 'move_local_then_download' },
    deleted: { type: 'recycle_local' },
  },
  modified: {
    unchanged: { type: 'upload' },
    modified: { type: 'compare_content' },
    moved: { type: 'move_local_then_upload' },
    movedAndModified: { type: 'compare_content', after: 'move_local' },
    deleted: { type: 'conflict_delete_vs_edit', deletedOn: 'remote' },
  },
  moved: {
    unchanged: { type: 'move_remote' },
    modified: { type: 'move_remote_then_download' },
    moved: { type: 'compare_destination', whenSame: 'none' },
    movedAndModified: { type: 'compare_destination', whenSame: 'download' },
    deleted: { type: 'conflict_delete_vs_edit', deletedOn: 'remote' },
  },
  movedAndModified: {
    unchanged: { type: 'move_remote_then_upload' },
    modified: { type: 'compare_content', after: 'move_remote' },
    moved: { type: 'compare_destination', whenSame: 'upload' },
    movedAndModified: { type: 'compare_destination', whenSame: 'compare_content' },
    deleted: { type: 'conflict_delete_vs_edit', deletedOn: 'remote' },
  },
  deleted: {
    unchanged: { type: 'trash_remote' },
    modified: { type: 'conflict_delete_vs_edit', deletedOn: 'local' },
    moved: { type: 'conflict_delete_vs_edit', deletedOn: 'local' },
    movedAndModified: { type: 'conflict_delete_vs_edit', deletedOn: 'local' },
    deleted: { type: 'remove_baseline' },
  },
};

export function decide(local: SideState, remote: SideState): Action {
  return TABLE[local][remote];
}

/** For tests: every cell, so they can assert none is missing. */
export function allCells(): { local: SideState; remote: SideState; action: Action }[] {
  const out: { local: SideState; remote: SideState; action: Action }[] = [];
  for (const l of SIDE_STATES) for (const r of SIDE_STATES) out.push({ local: l, remote: r, action: TABLE[l][r] });
  return out;
}

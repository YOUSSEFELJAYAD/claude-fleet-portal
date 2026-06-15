/**
 * cov-adddirs — buildArgs/buildResumeArgs emit one `--add-dir <dir>` per req.addDirs entry,
 * in addition to the cwd add-dir, and never duplicate the cwd. Covers @-folder attachments (§6.2).
 */
import { describe, it, expect } from 'vitest';
import { buildArgs, buildResumeArgs } from '../src/processManager.js';
import type { LaunchRequest } from '@fleet/shared';

const base: LaunchRequest = {
  prompt: 'hi', cwd: '/repo', model: 'claude-opus-4-8',
  effort: 'high', permissionMode: 'default',
} as LaunchRequest;

// collect the value after each `--add-dir` occurrence
function addDirs(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) if (args[i] === '--add-dir') out.push(args[i + 1]);
  return out;
}

describe('buildArgs --add-dir', () => {
  it('emits cwd plus each extra addDirs entry', () => {
    const args = buildArgs({ ...base, addDirs: ['/repo/src', '/repo/docs'] }, 'sess-1', false);
    expect(addDirs(args)).toEqual(['/repo', '/repo/src', '/repo/docs']);
  });
  it('does not duplicate the cwd if it appears in addDirs', () => {
    const args = buildArgs({ ...base, addDirs: ['/repo', '/repo/src'] }, 'sess-1', false);
    expect(addDirs(args)).toEqual(['/repo', '/repo/src']);
  });
  it('resume args inherit the extra add-dirs (delegates to buildArgs)', () => {
    const args = buildResumeArgs({ ...base, addDirs: ['/repo/src'] }, 'sess-1', false);
    expect(addDirs(args)).toEqual(['/repo', '/repo/src']);
  });
});

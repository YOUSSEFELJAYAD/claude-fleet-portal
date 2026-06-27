import { describe, it, expect } from 'vitest';
import { chatRepo } from '../src/chat.js';

// The chat agent runs in the user's real cwd and is meant to be unblocked by default:
// new sessions default to bypassPermissions (all tools, no prompt). The human-gate
// (ask_human) backstop stays wired elsewhere; the blocking PreToolUse hook is NOT forced.
describe('chat permissions default', () => {
  it('defaults a new session to bypassPermissions (all tools)', () => {
    const s = chatRepo.createSession({ cwd: '/tmp/perm-default' });
    expect(s.permissionMode).toBe('bypassPermissions');
  });

  it('still honors an explicit permissionMode', () => {
    const s = chatRepo.createSession({ cwd: '/tmp/perm-explicit', permissionMode: 'default' });
    expect(s.permissionMode).toBe('default');
  });
});

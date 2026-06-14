import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PermissionCard } from '../components/PermissionCard';
import { api } from '../lib/api';

describe('PermissionCard', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('renders the requested tool and posts allow on approve', async () => {
    const spy = vi.spyOn(api, 'chatInput').mockResolvedValue({} as any);
    render(<PermissionCard sessionId="s1" requestId="r9" toolName="Bash" input={{ command: 'rm -rf x' }} />);
    expect(screen.getByText('Bash')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /allow/i }));
    await waitFor(() => expect(spy).toHaveBeenCalledWith('s1', { type: 'permission', requestId: 'r9', decision: 'allow' }));
  });

  it('posts deny on deny and then disables the controls', async () => {
    const spy = vi.spyOn(api, 'chatInput').mockResolvedValue({} as any);
    render(<PermissionCard sessionId="s1" requestId="r9" toolName="Write" input={{}} />);
    fireEvent.click(screen.getByRole('button', { name: /deny/i }));
    await waitFor(() => expect(spy).toHaveBeenCalledWith('s1', { type: 'permission', requestId: 'r9', decision: 'deny' }));
    await waitFor(() => expect((screen.getByRole('button', { name: /deny/i }) as HTMLButtonElement).disabled).toBe(true));
  });
});

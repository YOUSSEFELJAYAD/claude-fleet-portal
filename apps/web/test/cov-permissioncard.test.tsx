import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PermissionCard } from '../components/PermissionCard';
import { api } from '../lib/api';

describe('PermissionCard', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('renders the requested tool and calls api.chatPermission on approve', async () => {
    const spy = vi.spyOn(api, 'chatPermission').mockResolvedValue({} as any);
    render(<PermissionCard sessionId="s1" requestId="r9" toolName="Bash" input={{ command: 'rm -rf x' }} />);
    expect(screen.getByText('Bash')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /allow/i }));
    // Fix 06 — must hit the dedicated permission route with (id, requestId, decision), NOT chatInput.
    await waitFor(() => expect(spy).toHaveBeenCalledWith('s1', 'r9', 'allow'));
  });

  it('calls api.chatPermission on deny and then disables the controls', async () => {
    const spy = vi.spyOn(api, 'chatPermission').mockResolvedValue({} as any);
    const inputSpy = vi.spyOn(api, 'chatInput').mockResolvedValue({} as any);
    render(<PermissionCard sessionId="s1" requestId="r9" toolName="Write" input={{}} />);
    fireEvent.click(screen.getByRole('button', { name: /deny/i }));
    await waitFor(() => expect(spy).toHaveBeenCalledWith('s1', 'r9', 'deny'));
    expect(inputSpy).not.toHaveBeenCalled();
    await waitFor(() => expect((screen.getByRole('button', { name: /deny/i }) as HTMLButtonElement).disabled).toBe(true));
  });
});

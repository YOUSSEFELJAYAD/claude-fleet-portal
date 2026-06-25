import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SubagentChip } from '../components/SubagentChip';

describe('SubagentChip', () => {
  it('renders the label and links to the child run', () => {
    render(<SubagentChip label="research-bot" childId="abc12345xyz" />);
    const link = screen.getByRole('link');
    expect(link.getAttribute('href')).toBe('/agents/abc12345xyz');
    expect(screen.getByText(/research-bot/)).toBeTruthy();
  });
});

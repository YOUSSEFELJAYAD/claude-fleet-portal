import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SubagentChip } from '../components/SubagentChip';
import { SearchResultCard } from '../components/SearchResultCard';

describe('SubagentChip', () => {
  it('renders the label and links to the child run', () => {
    render(<SubagentChip label="research-bot" childId="abc12345xyz" />);
    const link = screen.getByRole('link');
    expect(link.getAttribute('href')).toBe('/agents/abc12345xyz');
    expect(screen.getByText(/research-bot/)).toBeTruthy();
  });
});

describe('SearchResultCard', () => {
  it('renders title, url and snippet', () => {
    render(<SearchResultCard title="MDN" url="https://mdn.dev/x" snippet="docs here" />);
    expect(screen.getByText('MDN')).toBeTruthy();
    expect(screen.getByText(/docs here/)).toBeTruthy();
    expect(screen.getByText(/mdn\.dev/)).toBeTruthy();
  });
});

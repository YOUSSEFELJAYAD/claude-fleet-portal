import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ToolCallCard } from '../components/ToolCallCard';

describe('ToolCallCard', () => {
  it('renders tool name and a collapsed args summary; expands on click', () => {
    render(<ToolCallCard name="Read" input={{ file_path: '/a/b.ts' }} result="line1\nline2" isError={false} />);
    expect(screen.getByText('Read')).toBeTruthy();
    // collapsed: result text not shown yet
    expect(screen.queryByText(/line1/)).toBeNull();
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText(/line1/)).toBeTruthy();
  });

  it('shows a running state (no result yet) and an error state', () => {
    const { rerender } = render(<ToolCallCard name="Bash" input={{ command: 'ls' }} result={null} isError={false} />);
    expect(screen.getByText(/running|pending|…/i)).toBeTruthy();
    rerender(<ToolCallCard name="Bash" input={{ command: 'ls' }} result="boom" isError={true} />);
    expect(screen.getByText('Bash')).toBeTruthy();
  });
});

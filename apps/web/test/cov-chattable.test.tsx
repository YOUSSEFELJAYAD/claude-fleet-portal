import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ChatTable } from '../components/ChatTable';

describe('ChatTable', () => {
  it('renders headers and rows', () => {
    render(<ChatTable columns={['id', 'status']} rows={[['run-1', 'running'], ['run-2', 'done']]} />);
    expect(screen.getByText('id')).toBeTruthy();
    expect(screen.getByText('run-1')).toBeTruthy();
    expect(screen.getByText('done')).toBeTruthy();
    // it is a real <table>
    expect(document.querySelector('table')).toBeTruthy();
    expect(document.querySelectorAll('tbody tr').length).toBe(2);
  });

  it('renders an empty-state note when there are no rows', () => {
    render(<ChatTable columns={['id']} rows={[]} />);
    expect(screen.getByText(/no rows/i)).toBeTruthy();
  });
});

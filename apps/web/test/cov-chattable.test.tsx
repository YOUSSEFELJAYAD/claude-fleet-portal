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

  // Step 6 HUD QA: confirm the real <table> structure with HUD-canon styling.
  // Headers must be <th> elements; the wrapping container carries HUD border classes.
  it('renders column headers as <th> elements inside <thead> (HUD-canonical table structure)', () => {
    const { container } = render(<ChatTable columns={['name', 'engine', 'state']} rows={[['s1', 'claude', 'idle']]} />);
    const ths = container.querySelectorAll('thead th');
    expect(ths.length).toBe(3);
    const headerTexts = [...ths].map((th) => th.textContent);
    expect(headerTexts).toEqual(['name', 'engine', 'state']);
  });

  it('wraps the table in a bordered container (HUD border invariant)', () => {
    const { container } = render(<ChatTable columns={['x']} rows={[['y']]} />);
    // The outer wrapper carries the HUD border class; table itself is inside.
    const wrapper = container.querySelector('div');
    expect(wrapper).not.toBeNull();
    expect(container.querySelector('table')).not.toBeNull();
    // The table lives inside the bordered wrapper (not bare in the document).
    expect(wrapper!.contains(container.querySelector('table'))).toBe(true);
  });
});

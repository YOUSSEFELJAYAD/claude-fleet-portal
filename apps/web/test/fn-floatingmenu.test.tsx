/**
 * FloatingMenu — the new HUD-canon caret-anchored popover reused by the `/` and `@`
 * menus. These tests render the real component (no user-event lib: we drive with fireEvent
 * and assert on the DOM directly, since jest-dom matchers are not installed).
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { FloatingMenu, type FloatingItem } from '../components/ui';

const items: FloatingItem[] = [
  { id: 'launch', label: '/launch', hint: 'start a run', group: 'control' },
  { id: 'stop', label: '/stop', hint: 'stop a run', group: 'control' },
  { id: 'mem', label: '/memory', hint: 'fleet memory', group: 'knowledge' },
];

describe('FloatingMenu — rendering', () => {
  it('renders nothing when closed', () => {
    const { container } = render(
      <FloatingMenu open={false} items={items} activeIndex={0} onPick={() => {}} onClose={() => {}} />,
    );
    expect(container.querySelector('[data-floating-menu]')).toBeNull();
  });

  it('renders grouped items under uppercase group headers when open', () => {
    const { container, getByText } = render(
      <FloatingMenu open items={items} activeIndex={0} onPick={() => {}} onClose={() => {}} />,
    );
    expect(container.querySelector('[data-floating-menu]')).not.toBeNull();
    // group headers in first-appearance order
    const headers = [...container.querySelectorAll('[data-group-header]')].map((h) => h.textContent);
    expect(headers).toEqual(['control', 'knowledge']);
    // all three item rows present
    expect(container.querySelectorAll('[data-menu-item]').length).toBe(3);
    expect(getByText('/launch')).toBeTruthy();
  });

  it('renders the empty text when there are no items', () => {
    const { getByText } = render(
      <FloatingMenu open items={[]} activeIndex={0} onPick={() => {}} onClose={() => {}} emptyText="no matches" />,
    );
    expect(getByText('no matches')).toBeTruthy();
  });
});

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

describe('FloatingMenu — ARIA (listbox semantics)', () => {
  it('marks the container role=listbox and each row role=option with a stable id', () => {
    const { container } = render(
      <FloatingMenu open items={items} activeIndex={0} onPick={() => {}} onClose={() => {}} />,
    );
    const listbox = container.querySelector('[data-floating-menu]') as HTMLElement;
    expect(listbox.getAttribute('role')).toBe('listbox');
    const options = [...container.querySelectorAll('[data-menu-item]')] as HTMLElement[];
    expect(options.length).toBe(3);
    for (const o of options) {
      expect(o.getAttribute('role')).toBe('option');
      expect(o.id).toBeTruthy();
    }
  });

  it('sets aria-selected only on the active row', () => {
    const { container } = render(
      <FloatingMenu open items={items} activeIndex={1} onPick={() => {}} onClose={() => {}} />,
    );
    const options = [...container.querySelectorAll('[data-menu-item]')] as HTMLElement[];
    expect(options[1].getAttribute('aria-selected')).toBe('true');
    expect(options[0].getAttribute('aria-selected')).toBe('false');
    expect(options[2].getAttribute('aria-selected')).toBe('false');
  });
});

describe('FloatingMenu — interaction', () => {
  const items: FloatingItem[] = [
    { id: 'a', label: 'alpha', group: 'g1' },
    { id: 'b', label: 'beta', group: 'g1' },
    { id: 'c', label: 'gamma', group: 'g2' },
  ];

  it('paints the active row amber and others default', () => {
    const { container } = render(
      <FloatingMenu open items={items} activeIndex={1} onPick={() => {}} onClose={() => {}} />,
    );
    const rows = [...container.querySelectorAll('[data-menu-item]')] as HTMLElement[];
    expect(rows[1].style.color).toBe('rgb(255, 176, 0)'); // #ffb000 active
    expect(rows[0].style.color).not.toBe('rgb(255, 176, 0)');
  });

  it('fires onPick with the item and its flat index on mousedown', () => {
    const onPick = vi.fn();
    const { container } = render(
      <FloatingMenu open items={items} activeIndex={0} onPick={onPick} onClose={() => {}} />,
    );
    const rows = [...container.querySelectorAll('[data-menu-item]')] as HTMLElement[];
    fireEvent.mouseDown(rows[2]);
    expect(onPick).toHaveBeenCalledWith(items[2], 2);
  });

  it('calls onClose on an outside mousedown', () => {
    const onClose = vi.fn();
    render(<FloatingMenu open items={items} activeIndex={0} onPick={() => {}} onClose={onClose} />);
    fireEvent.mouseDown(document.body);
    expect(onClose).toHaveBeenCalled();
  });
});

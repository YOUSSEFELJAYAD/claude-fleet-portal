import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MarkdownView } from '../components/MarkdownView';

describe('MarkdownView — copy code block', () => {
  it('renders a copy button on a fenced code block that copies the code', () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    render(<MarkdownView source={'```js\nconst x = 1;\n```'} />);
    const btn = screen.getByLabelText(/copy code/i);
    fireEvent.click(btn);
    expect(writeText).toHaveBeenCalledWith('const x = 1;');
  });
});

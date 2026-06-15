import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ThinkingBlock } from '../components/ThinkingBlock';

describe('ThinkingBlock', () => {
  it('is collapsed by default and reveals the reasoning on click', () => {
    render(<ThinkingBlock text="step one then step two" />);
    expect(screen.queryByText(/step one then step two/)).toBeNull();
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText(/step one then step two/)).toBeTruthy();
  });

  it('labels itself as thinking', () => {
    render(<ThinkingBlock text="x" />);
    expect(screen.getByText(/thinking/i)).toBeTruthy();
  });
});

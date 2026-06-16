import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QuestionCard } from '../components/QuestionCard';
import { api } from '../lib/api';

describe('QuestionCard', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('renders the question prompt and option buttons', () => {
    vi.spyOn(api, 'answerQuestion').mockResolvedValue({} as any);
    render(
      <QuestionCard
        item={{
          kind: 'question',
          question: {
            id: 'g1',
            sessionId: 's1',
            question: 'Scope?',
            options: ['narrow', 'wide'],
            multiSelect: false,
            allowFreeText: false,
            createdAt: 0,
          },
        }}
        onAction={() => {}}
      />,
    );
    expect(screen.getByText('Scope?')).toBeTruthy();
    expect(screen.getByRole('button', { name: /narrow/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /wide/i })).toBeTruthy();
  });

  it('calls api.answerQuestion with the selected option on click (single select)', async () => {
    const spy = vi.spyOn(api, 'answerQuestion').mockResolvedValue({} as any);
    render(
      <QuestionCard
        item={{
          kind: 'question',
          question: {
            id: 'g1',
            sessionId: 's1',
            question: 'Scope?',
            options: ['narrow', 'wide'],
            multiSelect: false,
            allowFreeText: false,
            createdAt: 0,
          },
        }}
        onAction={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /wide/i }));
    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith('g1', { selection: ['wide'] }),
    );
  });
});

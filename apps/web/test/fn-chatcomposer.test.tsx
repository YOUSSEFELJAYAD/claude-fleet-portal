/**
 * ChatComposer — multiline auto-grow input. Enter sends; Shift+Enter inserts a newline.
 * `/...` at start routes to onCommand; plain text routes to onSend (with attachments).
 * Stop is shown while running and calls onStop. No user-event lib — fireEvent only.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { ChatComposer } from '../components/ChatComposer';

function setup(props: Partial<Parameters<typeof ChatComposer>[0]> = {}) {
  const onSend = vi.fn();
  const onCommand = vi.fn();
  const onStop = vi.fn();
  const utils = render(
    <ChatComposer
      disabled={false}
      running={false}
      cwd="/work"
      onSend={onSend}
      onCommand={onCommand}
      onStop={onStop}
      {...props}
    />,
  );
  const ta = utils.container.querySelector('textarea') as HTMLTextAreaElement;
  return { ...utils, ta, onSend, onCommand, onStop };
}

describe('ChatComposer — send semantics', () => {
  it('Enter sends plain text via onSend with no attachments and clears the field', () => {
    const { ta, onSend } = setup();
    fireEvent.change(ta, { target: { value: 'hello world' } });
    fireEvent.keyDown(ta, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('hello world', []);
    expect(ta.value).toBe('');
  });

  it('Shift+Enter does NOT send (newline behavior)', () => {
    const { ta, onSend } = setup();
    fireEvent.change(ta, { target: { value: 'line1' } });
    fireEvent.keyDown(ta, { key: 'Enter', shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('a /command line routes to onCommand, not onSend', () => {
    const { ta, onSend, onCommand } = setup();
    fireEvent.change(ta, { target: { value: '/sessions' } });
    fireEvent.keyDown(ta, { key: 'Enter' });
    expect(onCommand).toHaveBeenCalledWith('/sessions');
    expect(onSend).not.toHaveBeenCalled();
  });

  it('does not send when the trimmed text is empty', () => {
    const { ta, onSend } = setup();
    fireEvent.change(ta, { target: { value: '   ' } });
    fireEvent.keyDown(ta, { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();
  });
});

describe('ChatComposer — Stop button', () => {
  it('shows Stop while running and calls onStop', () => {
    const { container, onStop, getByText } = setup({ running: true });
    const stop = getByText(/stop/i);
    expect(stop).toBeTruthy();
    fireEvent.click(stop);
    expect(onStop).toHaveBeenCalled();
  });

  it('shows the send affordance (not Stop) while idle', () => {
    const { container } = setup({ running: false });
    expect(container.querySelector('[data-stop]')).toBeNull();
    expect(container.querySelector('[data-send]')).not.toBeNull();
  });
});

import type { ChatTurn } from '@fleet/shared';

/**
 * Serialize a conversation's settled turns to Markdown: each text message becomes a
 * `**You:**` / `**Assistant:**` block, turns separated by a horizontal rule. Non-text
 * messages (commands, command-results, errors) are skipped — they aren't conversation prose.
 */
export function turnsToMarkdown(turns: ChatTurn[]): string {
  return turns
    .map((t) =>
      t.messages
        .filter((m) => m.kind === 'text' && m.content.trim())
        .map((m) => `**${m.role === 'user' ? 'You' : 'Assistant'}:**\n\n${m.content.trim()}`)
        .join('\n\n'),
    )
    .filter(Boolean)
    .join('\n\n---\n\n');
}

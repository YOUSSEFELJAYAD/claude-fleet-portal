```markdown
# claude-fleet-portal Development Patterns

> Auto-generated skill from repository analysis

## Overview
This skill provides guidance on the development patterns, coding conventions, and workflows used in the `claude-fleet-portal` TypeScript codebase. It covers file organization, commit practices, feature planning, and iterative development, ensuring consistency and efficiency for contributors.

## Coding Conventions

- **Language:** TypeScript
- **Framework:** None detected (vanilla TypeScript/HTML)
- **File Naming:** Use kebab-case for all file names.

  **Example:**
  ```
  user-profile.ts
  landing-page-motion.ts
  ```

- **Import Style:** Use relative imports.

  **Example:**
  ```typescript
  import { fetchData } from './api-utils';
  ```

- **Export Style:** Use named exports.

  **Example:**
  ```typescript
  // In utils.ts
  export function formatDate(date: Date): string { ... }

  // In another file
  import { formatDate } from './utils';
  ```

- **Commit Messages:** Follow [Conventional Commits](https://www.conventionalcommits.org/) with prefixes such as `feat`, `fix`, and `docs`. Keep messages concise and descriptive (average ~71 characters).

  **Examples:**
  ```
  feat: add animation to landing page hero section
  fix: correct typo in user-profile component
  docs: update README with setup instructions
  ```

## Workflows

### spec-plan-implement-feature
**Trigger:** When introducing a significant new feature or redesign (e.g., landing page overhaul).
**Command:** `/new-feature-spec-plan-implement`

1. **Write a specification document** describing the feature or redesign.
   - Location: `docs/superpowers/specs/`
   - Format: Markdown (`.md`)
   - Example: `docs/superpowers/specs/landing-page-motion.md`
2. **Write an implementation plan** outlining steps and considerations.
   - Location: `docs/superpowers/plans/`
   - Example: `docs/superpowers/plans/landing-page-motion-plan.md`
3. **Iteratively implement the feature** in `site/index.html`.
   - Make multiple commits for each feature addition or bug fix.
   - Use conventional commit messages.

   **Example commit sequence:**
   ```
   feat: add initial hero animation structure
   feat: implement scroll-based fade-in effect
   fix: adjust animation timing for smoother entry
   ```

### iterative-feature-implementation-in-index-html
**Trigger:** When incrementally building or refining a major feature directly in `site/index.html`.
**Command:** `/feature-iteration-index-html`

1. **Implement a sub-feature or design token** in `site/index.html`.
2. **Commit the change** with a descriptive, conventional commit message.
3. **Repeat** for each additional sub-feature, animation, or bug fix.

   **Example:**
   ```
   feat: add CTA button hover animation
   fix: resolve layout shift on mobile
   feat: introduce background gradient transition
   ```

## Testing Patterns

- **Testing Framework:** Not explicitly detected.
- **Test File Pattern:** Files named with `*.test.*` (e.g., `utils.test.ts`).
- **Location:** Tests are typically placed alongside the code they test.

  **Example:**
  ```
  utils.test.ts
  ```

  **Sample Test File:**
  ```typescript
  import { formatDate } from './utils';

  test('formats date correctly', () => {
    expect(formatDate(new Date('2024-01-01'))).toBe('2024-01-01');
  });
  ```

## Commands

| Command                          | Purpose                                                      |
|-----------------------------------|--------------------------------------------------------------|
| /new-feature-spec-plan-implement  | Start the spec/plan/implement workflow for a major feature   |
| /feature-iteration-index-html     | Begin or continue iterative feature work in site/index.html  |
```

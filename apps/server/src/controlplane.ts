// PLACEHOLDER — replaced by Slice 03 (controlplane-board)
// Exports the minimal signatures that loops.ts calls via dynamic import.
// NOTE: functions are exported as named re-exports from a mutable object so test suites can
// property-reassign them on the module namespace (e.g. `(controlplane as any).controlPlaneFor = ...`).
// Vitest with { deps: { interopDefault: true } } or CJS interop allows this for placeholder stubs.

export interface WorkItem {
  id: string;
  title: string;
  body: string;
  labels: string[];
}

export interface IntendedAction {
  kind: string;
  itemId: string;
  detail: Record<string, unknown>;
}

export interface ControlPlane {
  listBacklog(): Promise<WorkItem[]>;
  listReady(): Promise<WorkItem[]>;
  classify(id: string, verdict: any): Promise<void>;
  postAssessment(id: string, markdown: string): Promise<void>;
  attachQuestions(id: string, questions: string[]): Promise<void>;
}

export function controlPlaneFor(
  loop: any,
  project: any,
): { cp: ControlPlane; intended: IntendedAction[] } {
  const intended: IntendedAction[] = [];
  const cp: ControlPlane = {
    listBacklog: async () => [],
    listReady: async () => [],
    classify: async () => {},
    postAssessment: async () => {},
    attachQuestions: async () => {},
  };
  return { cp, intended };
}

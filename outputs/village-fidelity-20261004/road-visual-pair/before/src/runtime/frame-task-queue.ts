/** Cooperative queue for work that may span several rendered frames. */
export interface FrameTask {
  readonly priority: number;
  /** Approximate total cost, used to choose smaller work first at equal priority. */
  readonly estimatedCostMs: number;
  /** Perform one bounded unit of work; return true when the task is complete. */
  step(): boolean;
  cancel?(): void;
  onError?(error: unknown): void;
}

export interface FrameTaskRunStats {
  readonly executedSteps: number;
  readonly completedTasks: number;
  readonly pendingTasks: number;
  readonly spentMs: number;
  readonly overshotBudget: boolean;
}

export interface FrameTaskHandle {
  cancel(): void;
  readonly cancelled: boolean;
}

interface QueuedTask {
  readonly id: number;
  readonly task: FrameTask;
  cancelled: boolean;
}

/**
 * Runs cooperative steps in priority order until the frame budget is spent.
 * The highest-priority unfinished task gets the remaining budget first; steps
 * cannot be interrupted, so callers should keep each unit small and inspect
 * overshoot.
 */
export class FrameTaskQueue {
  private readonly tasks: QueuedTask[] = [];
  private nextId = 1;
  private disposed = false;

  enqueue(task: FrameTask): FrameTaskHandle {
    if (this.disposed) throw new Error('FrameTaskQueue is disposed');
    if (!Number.isFinite(task.priority) || !Number.isFinite(task.estimatedCostMs) || task.estimatedCostMs < 0) {
      throw new Error('FrameTaskQueue task priority/cost must be finite and cost non-negative');
    }
    const entry: QueuedTask = { id: this.nextId++, task, cancelled: false };
    this.tasks.push(entry);
    return {
      get cancelled() { return entry.cancelled; },
      cancel: () => this.cancelEntry(entry),
    };
  }

  runFrame(budgetMs: number): FrameTaskRunStats {
    if (this.disposed) return { executedSteps: 0, completedTasks: 0, pendingTasks: 0, spentMs: 0, overshotBudget: false };
    if (!Number.isFinite(budgetMs) || budgetMs < 0) throw new Error('FrameTaskQueue budget must be finite and non-negative');
    this.tasks.sort((a, b) => b.task.priority - a.task.priority || a.task.estimatedCostMs - b.task.estimatedCostMs || a.id - b.id);
    const start = performance.now();
    const deadline = start + budgetMs;
    let executedSteps = 0;
    let completedTasks = 0;
    while (this.tasks.length > 0 && performance.now() < deadline) {
      const entry = this.tasks[0]!;
      if (entry.cancelled) {
        this.removeEntry(entry);
        continue;
      }
      try {
        executedSteps++;
        if (entry.task.step()) {
          this.removeEntry(entry);
          completedTasks++;
        }
      } catch (error) {
        this.removeEntry(entry);
        entry.task.onError?.(error);
        throw error;
      }
    }
    const spentMs = performance.now() - start;
    this.compact();
    return {
      executedSteps,
      completedTasks,
      pendingTasks: this.tasks.length,
      spentMs,
      overshotBudget: spentMs > budgetMs,
    };
  }

  cancelAll(): void {
    for (const entry of [...this.tasks]) this.cancelEntry(entry);
  }

  dispose(): void {
    if (this.disposed) return;
    this.cancelAll();
    this.disposed = true;
  }

  get pendingTasks(): number {
    return this.tasks.length;
  }

  private cancelEntry(entry: QueuedTask): void {
    if (entry.cancelled) return;
    entry.cancelled = true;
    entry.task.cancel?.();
    this.removeEntry(entry);
  }

  private removeEntry(entry: QueuedTask): void {
    const index = this.tasks.indexOf(entry);
    if (index >= 0) this.tasks.splice(index, 1);
  }

  private compact(): void {
    for (let i = this.tasks.length - 1; i >= 0; i--) {
      if (this.tasks[i]!.cancelled) this.tasks.splice(i, 1);
    }
  }
}

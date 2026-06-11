import * as vscode from "vscode";

export type NotificationPriority = "user" | "system";
export type NotificationId = number;

interface NotificationEntry {
  id: NotificationId;
  priority: NotificationPriority;
  title: string;
}

/**
 * Priority-aware VS Code progress notification queue.
 *
 * Maintains two FIFO queues (user / system). User entries always outrank system
 * entries — when a user entry is pushed while a system notification is visible,
 * the system notification is immediately replaced. When the displayed entry is
 * cleared, the next highest-priority entry is shown automatically.
 *
 * Usage:
 *   const id = queue.push("user", "Extracting game assets…");
 *   try { await doWork(); } finally { queue.clear(id); }
 *
 * A generation counter ensures stale withProgress callbacks (delivered after the
 * queue has already moved on) resolve immediately rather than stomping the new one.
 */
export class NotificationQueue {
  private nextId = 1;
  private userQueue: NotificationEntry[] = [];
  private systemQueue: NotificationEntry[] = [];
  private currentId: NotificationId | null = null;
  private currentPriority: NotificationPriority | null = null;
  private resolveNotification: (() => void) | null = null;
  private generation = 0;

  /** Append a user-priority entry. Returns an id to pass to clear(). */
  pushUser(title: string): NotificationId {
    return this._push("user", title, false);
  }

  /** Append a system-priority entry. Returns an id to pass to clear(). */
  pushSystem(title: string): NotificationId {
    return this._push("system", title, false);
  }

  /** Prepend a user-priority entry, bypassing any waiting user entries. */
  emergencyPushUser(title: string): NotificationId {
    return this._push("user", title, true);
  }

  /** Prepend a system-priority entry, bypassing any waiting system entries. */
  emergencyPushSystem(title: string): NotificationId {
    return this._push("system", title, true);
  }

  private _push(priority: NotificationPriority, title: string, front: boolean): NotificationId {
    const id = this.nextId++;
    this._enqueue({ id, priority, title }, front);
    this._advance();
    return id;
  }

  /** Remove an entry. If it is currently displayed, advance to the next entry. */
  clear(id: NotificationId): void {
    this.userQueue = this.userQueue.filter((e) => e.id !== id);
    this.systemQueue = this.systemQueue.filter((e) => e.id !== id);
    if (this.currentId === id) {
      this.currentId = null;
      this.currentPriority = null;
      this._closeNotification();
      this._advance();
    }
  }

  /** True if `priority` would immediately preempt the currently displayed entry. */
  isHigher(priority: NotificationPriority): boolean {
    if (this.currentPriority === null) return false;
    return priority === "user" && this.currentPriority === "system";
  }

  /** True if a notification is currently visible. */
  isDisplaying(): boolean {
    return this.currentId !== null;
  }

  /** True if any entries are present (visible or waiting). */
  isActive(): boolean {
    return this.userQueue.length > 0 || this.systemQueue.length > 0 || this.currentId !== null;
  }

  private _enqueue(entry: NotificationEntry, front: boolean): void {
    const queue = entry.priority === "user" ? this.userQueue : this.systemQueue;
    if (front) {
      queue.unshift(entry);
    } else {
      queue.push(entry);
    }
  }

  private _nextEntry(): NotificationEntry | null {
    return this.userQueue[0] ?? this.systemQueue[0] ?? null;
  }

  private _advance(): void {
    const next = this._nextEntry();
    if (!next) {
      if (this.currentId !== null) {
        this.currentId = null;
        this.currentPriority = null;
        this._closeNotification();
      }
      return;
    }
    if (next.id === this.currentId) return;
    if (this.currentId !== null) this._closeNotification();
    this.currentId = next.id;
    this.currentPriority = next.priority;
    this._openNotification(next.title);
  }

  private _openNotification(title: string): void {
    const gen = ++this.generation;
    void vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title, cancellable: false },
      () =>
        new Promise<void>((resolve) => {
          if (this.generation === gen) {
            this.resolveNotification = resolve;
          } else {
            resolve(); // Superseded before callback ran — close immediately.
          }
        }),
    );
  }

  private _closeNotification(): void {
    this.generation++; // Invalidate any in-flight _openNotification callback.
    this.resolveNotification?.();
    this.resolveNotification = null;
  }
}

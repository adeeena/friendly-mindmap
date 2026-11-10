import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DialogRef } from '@angular/cdk/dialog';
import { Command, CommandRegistry, formatKeys } from '../editor/commands';

/** Subsequence match score; lower is better, -1 = no match. */
export function fuzzyScore(query: string, text: string): number {
  const q = query.toLowerCase().trim();
  if (!q) return 0;
  const t = text.toLowerCase();
  const direct = t.indexOf(q);
  if (direct >= 0) return direct;
  let ti = 0;
  let gaps = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found < 0) return -1;
    gaps += found - ti;
    ti = found + 1;
  }
  return 100 + gaps;
}

@Component({
  selector: 'bm-command-palette',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'bm-palette bm-panel' },
  template: `
    <h2 class="visually-hidden" id="bm-palette-title">Command palette</h2>
    <input
      class="bm-palette-input"
      type="text"
      role="combobox"
      aria-labelledby="bm-palette-title"
      aria-controls="bm-palette-list"
      aria-expanded="true"
      aria-autocomplete="list"
      placeholder="Type a command…"
      cdkFocusInitial
      [attr.aria-activedescendant]="results().length ? 'bm-cmd-' + active() : null"
      [value]="query()"
      (input)="onInput($event)"
      (keydown)="onKey($event)"
    />
    <ul id="bm-palette-list" role="listbox" aria-label="Commands" class="bm-palette-list">
      @for (c of results(); track c.id; let i = $index) {
        <li
          role="option"
          [id]="'bm-cmd-' + i"
          [attr.aria-selected]="i === active()"
          [class.active]="i === active()"
          (pointerenter)="active.set(i)"
          (click)="run(c)"
        >
          <span class="bm-cmd-group">{{ c.group }}</span>
          <span class="bm-cmd-label">{{ c.label }}</span>
          @if (c.keys?.length) {
            <kbd>{{ fmt(c.keys![0]) }}</kbd>
          }
        </li>
      } @empty {
        <li class="bm-palette-empty" role="option" aria-disabled="true" aria-selected="false">No matching commands</li>
      }
    </ul>
  `,
})
export class CommandPalette {
  private readonly registry = inject(CommandRegistry);
  private readonly ref = inject(DialogRef);
  protected readonly query = signal('');
  protected readonly active = signal(0);

  protected readonly results = computed(() => {
    const q = this.query();
    return this.registry
      .commands()
      .filter((c) => !c.hidden && (!c.enabled || c.enabled()))
      .map((c) => ({ c, s: fuzzyScore(q, `${c.group} ${c.label}`) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => a.s - b.s)
      .slice(0, 50)
      .map((x) => x.c);
  });

  protected fmt(k: string): string {
    return formatKeys(k);
  }

  protected onInput(e: Event): void {
    this.query.set((e.target as HTMLInputElement).value);
    this.active.set(0);
  }

  protected onKey(e: KeyboardEvent): void {
    const n = this.results().length;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      this.active.update((i) => (n ? (i + 1) % n : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      this.active.update((i) => (n ? (i - 1 + n) % n : 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const c = this.results()[this.active()];
      if (c) this.run(c);
    }
  }

  protected run(c: Command): void {
    this.ref.close();
    // Run after the dialog restores focus so commands can move focus themselves.
    setTimeout(() => c.run());
  }
}

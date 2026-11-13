import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { DIALOG_DATA, Dialog, DialogRef } from '@angular/cdk/dialog';
import { t } from '../i18n';
import { Icon } from './icon';

export interface ImagePreviewData {
  name: string;
  url: string;
  /** Shown under the image, for example the file size. */
  detail: string;
}

@Component({
  selector: 'bm-image-preview',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  host: { class: 'bm-dialog bm-panel bm-preview' },
  template: `
    <div class="bm-dialog-head">
      <h2 id="bm-preview-title" class="bm-preview-title">{{ data.name }}</h2>
      <button type="button" class="bm-button" cdkFocusInitial [attr.aria-label]="t('common.close')" (click)="ref.close()">
        <bm-icon name="close" />
      </button>
    </div>
    <div class="bm-preview-stage">
      <img [src]="data.url" [alt]="data.name" (load)="onLoad($event)" />
    </div>
    <p class="bm-muted">{{ dimensions() }}{{ data.detail }}</p>
  `,
})
export class ImagePreviewDialog {
  protected readonly t = t;
  protected readonly data = inject<ImagePreviewData>(DIALOG_DATA);
  protected readonly ref = inject<DialogRef<void>>(DialogRef);
  protected readonly dimensions = signal('');

  protected onLoad(event: Event): void {
    const image = event.target as HTMLImageElement;
    this.dimensions.set(`${image.naturalWidth} × ${image.naturalHeight} px · `);
  }
}

export function previewImage(dialog: Dialog, data: ImagePreviewData): Promise<void> {
  const ref = dialog.open<void>(ImagePreviewDialog, {
    data,
    ariaLabelledBy: 'bm-preview-title',
    autoFocus: 'first-tabbable',
    restoreFocus: true,
    maxWidth: 'calc(100vw - 16px)',
  });
  return new Promise((resolve) => ref.closed.subscribe(() => resolve()));
}

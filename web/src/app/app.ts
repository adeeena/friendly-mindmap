import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { SettingsService } from './settings.service';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: '<router-outlet />',
  styles: ':host { display: block; height: 100dvh; }',
})
export class App {
  // Created up front so the saved theme and language apply on every route.
  private readonly settings = inject(SettingsService);
}

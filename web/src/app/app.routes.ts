import { Routes } from '@angular/router';
import { APP_INFO } from './app-info';
import { t } from './i18n';

export const routes: Routes = [
  { path: '', loadComponent: () => import('./ui/editor-shell').then((m) => m.EditorShell), title: () => APP_INFO.name },
  {
    path: 'print/:boardId/:nodeId',
    loadComponent: () => import('./ui/checklist-print').then((m) => m.ChecklistPrint),
    title: () => t('node.checklist'),
  },
  { path: '**', redirectTo: '' },
];

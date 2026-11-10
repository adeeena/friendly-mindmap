import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: '', loadComponent: () => import('./ui/editor-shell').then((m) => m.EditorShell), title: 'Better Mindmap' },
  {
    path: 'print/:boardId/:nodeId',
    loadComponent: () => import('./ui/checklist-print').then((m) => m.ChecklistPrint),
    title: 'Checklist',
  },
  { path: '**', redirectTo: '' },
];

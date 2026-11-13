# Spec Delta

## MODIFIED Requirements

### Requirement: Theme follows OS
The system SHALL offer System, Light, Dark, Pale Rose, Windows 98 and CS3 Gray through one labeled dropdown in Settings > Appearance. System SHALL follow OS light/dark preference live; explicit choices SHALL remain stable when the OS changes. All choices SHALL maintain WCAG AA contrast and visible focus indicators.

#### Scenario: OS switches to dark
- **WHEN** the OS color scheme changes from light to dark while System is selected
- **THEN** the app switches to the dark theme without reload

#### Scenario: Explicit choice remains selected
- **WHEN** a user selects Pale Rose and the OS changes to dark
- **THEN** Pale Rose remains applied and selected in the dropdown

#### Scenario: Accessible dropdown
- **WHEN** a keyboard user opens Settings > Appearance
- **THEN** one labeled theme dropdown exposes exactly the six choices and supports normal keyboard selection

## ADDED Requirements

### Requirement: Persistent complete theme treatments
Theme choice SHALL persist across reloads and apply before first paint to the app shell, canvas background, toolbars, controls, dialogs, popovers and toasts. Guest choices SHALL be local and authenticated choices SHALL synchronize as account configuration. Changing theme SHALL NOT modify board content, stored node colors, layout coordinates or editor commands.

#### Scenario: Reload chosen theme
- **WHEN** the application reloads with a locally cached Windows 98 preference
- **THEN** Windows 98 styling is applied before the first rendered application frame

#### Scenario: Board data unchanged
- **WHEN** a user cycles through all six themes
- **THEN** board content and stored node/tag/edge color values remain unchanged

### Requirement: Pale Rose appearance
Pale Rose SHALL use softly tinted pale rose surfaces and canvas treatment, dark readable text and coordinated accents across the application rather than changing the board's node palette.

#### Scenario: Rose settings and editor
- **WHEN** Pale Rose is selected with a dialog and notes panel open
- **THEN** the shell and both surfaces use the coordinated pale rose treatment with readable text

### Requirement: Windows 98 appearance
Windows 98 SHALL provide a classic gray, square-cornered, beveled-control treatment with clear pressed/focused states while preserving current editor interactions, accessibility and responsive action availability.

#### Scenario: Classic controls
- **WHEN** Windows 98 is selected and toolbar buttons or dialogs are used
- **THEN** controls have square beveled styling with distinguishable pressed and focused states and retain their existing actions

### Requirement: CS3 Gray appearance
CS3 Gray SHALL provide a compact gray workspace with restrained gradients, clearly delineated panels and tool groups, inspired by older desktop creative tools. It SHALL preserve responsive layout, readable text and accessible hit targets rather than replicate proprietary artwork.

#### Scenario: Compact gray workspace
- **WHEN** CS3 Gray is selected on desktop or a narrow screen
- **THEN** toolbars, menus and panels use coordinated compact gray styling without clipping actions or reducing controls below accessible target sizes

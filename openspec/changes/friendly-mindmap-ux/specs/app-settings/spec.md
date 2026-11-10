# Spec Delta

## Purpose

Provides application-wide preferences and identity metadata for the editor, independent of any individual board.

## ADDED Requirements

### Requirement: Settings popup
The system SHALL provide a Settings action that opens an accessible popup with Appearance and Language tabs, the application version, and a footer crediting the author.

#### Scenario: Open settings
- **WHEN** the user activates Settings
- **THEN** a dialog opens with Appearance and Language tabs, the application version, and a "Made by" footer

### Requirement: Application theme preference
The system SHALL offer System, Light, and Dark theme choices and persist the choice app-wide, independently of board settings.

#### Scenario: Choose a fixed theme
- **WHEN** the user chooses Light or Dark
- **THEN** the application uses that theme across boards and after reload

#### Scenario: Follow system theme
- **WHEN** the user chooses System and the operating system theme changes
- **THEN** the application updates to match without reloading

### Requirement: Application language preference
The system SHALL offer English, French, and Hungarian, translate all application interface text for the selected language, and persist the choice app-wide.

#### Scenario: Change language
- **WHEN** the user chooses French
- **THEN** the application interface changes to French and remains French after reload

### Requirement: Configurable application identity
The default application name SHALL be "Friendly Mindmap" and SHALL come from one configurable metadata value; the settings popup SHALL display the application version and end with a footer "Made by Muráncsik Adéna Auróra" whose name links to `https://adena.dev`.

#### Scenario: View application information
- **WHEN** the user opens Settings
- **THEN** the package version is shown and the footer credits the author with a link to `https://adena.dev` that opens in a new tab
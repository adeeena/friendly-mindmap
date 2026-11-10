# Spec Delta

## MODIFIED Requirements

### Requirement: Theme follows OS
The system SHALL offer System, Light, and Dark theme choices; System SHALL match and update with the operating system preference, while an explicit Light or Dark choice SHALL override it, and all themes SHALL meet WCAG AA contrast.

#### Scenario: OS switches to dark
- **WHEN** the OS color scheme changes from light to dark while the app is open and System is selected
- **THEN** the app switches to the dark theme without reload

#### Scenario: User theme overrides OS
- **WHEN** the user selects Light while the OS is using Dark
- **THEN** the app remains in Light theme across boards and after reload
# Project Switcher Pill (`project-switcher-pill`)

A Hermes Desktop UI plugin that displays the current project/workspace above or inside the chat composer, with a cross-profile dropdown menu to switch projects or move the current session's workspace.

## Features

- **Cross-Profile Project Discovery:** Resolves projects and their owning profiles across all profiles via `profiles.list`, `projects.list`, and `projects.tree`.
- **Automatic Profile Pairing:** Matches the focused session's workspace (`host.state.cwd`) or active project pointer, and automatically switches to the owning profile when starting a new session in a project owned by another profile.
- **In-Place Move or New Chat:** Choose whether selecting a project during an active chat moves the current session's workspace (`session.workspace.move`, including back to **Home** via `cwd: '~'`) or starts a fresh chat in that project (hold `⌘`/`Ctrl` or `Shift` to always open a new chat).

## Installation

### Symlink (Local Development)

```bash
ln -s ~/projects/danielarndt/hermes-project-switcher-pill ~/.hermes/desktop-plugins/project-switcher-pill
```

### Git Install (Hermes Desktop)

In Hermes Desktop, open **Settings → Plugins → Install from Git** and provide the repository URL or `danielarndt/hermes-project-switcher-pill`.

## Configuration

Configure under **Settings → Plugins → Project Switcher Pill**:
- **Composer position:** `Above Chat Box`, `Top Banner`, `Beside Model`, or `Left (by +)`
- **Switching during an active chat:** `Move Current Chat` or `Start New Chat`
- **Show auto-discovered repositories**
- **Show session counts**

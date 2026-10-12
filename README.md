# codeee

**A code editor for the terminal, after VS Code.** A file explorer with your VS Code icons and git states, tabs, syntax highlighting in your VS Code theme for every language, find and replace in a file and across the folder, Quick Open, a settings page like VS Code's, Prettier formatting, the current line's blame, and full mouse support.

[![CI](https://img.shields.io/github/actions/workflow/status/illinifellow/codeee-cli/ci.yml?label=CI)](https://github.com/illinifellow/codeee-cli/actions/workflows/ci.yml)
[![Tests](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/illinifellow/codeee-cli/badges/tests.json)](https://github.com/illinifellow/codeee-cli/actions/workflows/ci.yml)
[![Coverage](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/illinifellow/codeee-cli/badges/coverage.json)](https://github.com/illinifellow/codeee-cli/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-ff905c)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.15-88bd66)](https://nodejs.org)
[![Buy me a coffee](https://img.shields.io/badge/Buy%20me%20a%20coffee-ffdd04?logo=buymeacoffee&logoColor=000)](https://buymeacoffee.com/illinifellow)

![codeee in the dark golden-brown theme: the explorer with the source folders open, two tabs, TypeScript highlighted in the VS Code theme and the blame of the cursor line](docs/dark.png)

codeee is the sibling of [gittt](https://github.com/illinifellow/gittt-cli): gittt is a Sourcetree for the terminal, codeee is a VS Code for it. It is an editor and nothing more: no extensions, no built-in terminal, no debugger. What VS Code users reach for every minute is built in.

![The same editor in the light milk-and-honey theme: the Search view with 53 results in 5 files beside the code](docs/light.png)

## Features

- **Explorer:** the folder's tree with the icons of your VS Code icon theme, git states (modified, untracked, added, deleted, conflicted, ignored) and unsaved files; new file, new folder, rename, delete to the Trash, copy path.
- **Tabs and Quick Open:** files open in tabs and come back next time with their cursor where you left it; `^P` finds any file by fuzzy name, `:` goes to a line, `>` runs any command.
- **Highlighting:** every language shiki bundles (over 240), found the way VS Code finds them (its installed language extensions, file names, shebangs), coloured by your VS Code theme with your `editor.tokenColorCustomizations`.
- **Editor groups:** split the editor (View: Split Editor), drag tabs between groups or to the right edge for a new one; tabs wrap onto more rows when they do not fit.
- **Hot exit:** unsaved files are backed up while you work and come back the next time, so quitting never asks and a crash loses nothing.
- **Explorer as in VS Code:** compact folders, a single click opens a preview tab, drag files between folders, Enter renames, Backspace deletes to the Trash.
- **Multiple cursors:** `^D` adds the next occurrence of the selection, `⌥`-click adds a cursor; typing, Backspace, Delete, arrows and Home/End act on every one. Occurrences of the word at the cursor are highlighted.
- **Editing as in VS Code:** auto-indent, auto-closing brackets and quotes, word moves and deletes, Tab and Shift+Tab on selections, line comments, move, copy and delete lines, whole-line copy and paste, undo and redo grouped by typing.
- **Find and replace:** in the file with case, whole-word and regular-expression options; across the folder in the Search view with files to include and exclude, and Replace All.
- **Format Document** with Prettier: the project's Prettier and configuration, or the one the VS Code extension bundles, so the result is what VS Code gives. Optional format on save.
- **From neovim:** lines kept around the cursor while scrolling, relative line numbers, jump to the matching bracket, the last cursor position of every file.
- **From VS Code extensions:** the current line's blame (GitLens); colour literals drawn on their colour (Color Highlight); ESLint problems underlined and written at the line's end (ESLint, Error Lens); the snippets of your installed extensions and your own, expanded on Tab; Markdown Preview that follows every edit.
- **As VS Code draws code:** indent guides, bracket pair colours, the minimap, sticky scroll of the enclosing blocks, git change marks beside the line numbers.
- **Go to Symbol:** `@` in Quick Open lists the file's functions, classes, headings and rules; `F8` walks the problems.
- **Auto save** after a delay or on focus change, as `files.autoSave`.
- **Code intelligence without a language server:** Go to Definition (`F12`) in the file and across the folder, Rename Symbol (`F2`) in the file, enclosing symbols in the breadcrumbs, code folding by indentation.
- **HTML and JSX:** Emmet abbreviations on Tab (`ul>li.item$*3`), closing tags typed for you.
- **Word wrap** (`⌥Z`, on for plain text), whitespace drawn, fold controls beside every block, Fold All and Unfold All (`⌥-` `⌥=`), snippet tab stops.
- **Text commands:** upper, lower and title case, sort lines, join lines, delete duplicate lines, trim trailing whitespace; Open Folder and Open Recent switch folders in place.
- **Small things VS Code users expect:** Reopen Closed Editor, Change Language Mode and Change Indentation commands, type a name in the explorer to jump to it, whitespace shown inside selections.
- **Option as Alt** even when the terminal sends Option as text, so every `⌥` shortcut works in a stock iTerm2 or Terminal.
- **Settings page** like VS Code's: search, table of contents, every option with its description and control, modified marks, reset, and the JSON file one click away.
- **Mouse everywhere:** click, double-click to select a word, drag to select, wheel, right-click menus, drag files between folders, a draggable explorer edge, the minimap, fold arrows.

## Requirements

- Node.js 22.15+; `git` for the explorer's states and the blame.
- A terminal with true colour, SGR mouse reporting and bracketed paste; tested in iTerm2 on macOS. The screenshots use the Decima Mono X font.

## Install

```sh
npm install --global https://github.com/illinifellow/codeee-cli/releases/latest/download/codeee-cli.tgz
```

**Update** appears in the toolbar when a newer release exists; a click installs it and restarts in place. From a clone:

```sh
git clone https://github.com/illinifellow/codeee-cli.git
cd codeee-cli
npm install
npm link
```

## Run

```sh
codeee              # asks which folder to open, prefilled with the current one
codeee ~/code/app   # prefills that folder instead
codeee src/app.ts   # opens the file's folder with the file in a tab
```

## Keyboard

| Key                 | Action                                                                |
| ------------------- | --------------------------------------------------------------------- |
| `^S` `^N` `^W` `^Q` | save, new file, close tab, quit (asks about unsaved files)            |
| `^P`                | Quick Open: files; `:` line; `>` commands                             |
| `^G`                | go to line                                                            |
| `^F` `^R`           | find, replace in the file                                             |
| `F3` `⇧F3`          | next, previous match; the word at the cursor with no search           |
| `^T` `⌥^T`          | search, replace across the folder                                     |
| `⌥C` `⌥W` `⌥R`      | match case, whole word, regular expression                            |
| `^Z` `^Y`           | undo, redo                                                            |
| `^C` `^X` `^V`      | copy, cut, paste (the whole line when nothing is selected)            |
| `^A` `^L`           | select all, expand line selection                                     |
| `^D`                | select the word, then add its next occurrence: type to edit every one |
| `^/` `^K` `⌥⇧↓`     | toggle comment, delete line, copy line down                           |
| `⌥↑` `⌥↓`           | move line                                                             |
| `^\`                | jump to the matching bracket                                          |
| `⌥⇧F`               | Format Document                                                       |
| `^]`                | Go to Symbol                                                          |
| `F12` `F2`          | go to definition, rename symbol                                       |
| `⌥K`                | fold or unfold the block at the cursor                                |
| `⌥T`                | reopen closed editor                                                  |
| `F8` `⇧F8`          | next, previous problem                                                |
| `⌥V`                | Markdown Preview                                                      |
| `Tab`               | expand a snippet prefix, else indent                                  |
| `^B` `^E`           | toggle the explorer, focus it                                         |
| `^O`                | settings                                                              |
| `^PgUp` `^PgDn`     | previous, next tab                                                    |
| `^←` `^→` `⌥←` `⌥→` | word left, right; with `⇧` select                                     |

Every key is set in the settings. Terminals do not pass Cmd to programs; map a Cmd shortcut to one of these in the terminal's key settings to keep your VS Code habits.

## Configuration

The settings page (`^O`) holds every option. Configuration is `settings.json` in two files of one shape:

| File                                    | Holds                                                      |
| --------------------------------------- | ---------------------------------------------------------- |
| `config/settings.json` (in the package) | every default: settings, limits, keys, themes              |
| `~/.config/codeee-cli/settings.json`    | your changes, plus `state` (recent folders, tabs, cursors) |

### Themes

**golden-brown** is dark, warm orange on brown, drawn on the terminal's background; **milk-and-honey** is light, milky with amber. They are gittt's themes; their code colours come from your VS Code theme and from light-plus. `settings.theme` defaults to `auto`, which picks one by the terminal's background; `vscode` takes every colour from the theme VS Code runs, with its `workbench.colorCustomizations`.

## Development

```sh
npm install
npm run build       # dist/app.js and the dist/cli.js launcher
npm run typecheck
npm test
```

In a checkout, `codeee` restarts in place when `dist/app.js` changes and no file is unsaved.

## Contributing

Every change starts as a [bug report](https://github.com/illinifellow/codeee-cli/issues/new?template=bug_report.yml) or a [feature request](https://github.com/illinifellow/codeee-cli/issues/new?template=feature_request.yml), is worked on its own branch, and lands through a pull request that closes the issue.

## License

[MIT](LICENSE)

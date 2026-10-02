# Memfolio

English | [正體中文](README.zh-Hant.md)

A browser extension that saves photos and videos from social platforms into folders on your computer. Files that are already in the folder are not downloaded again. The first supported platform is Instagram.

Status: in development, not published to any extension store.

## What it does

- **Download All** on a profile page, for the tab you are viewing (posts, Reels, tagged).
  - A normal run stops listing at the first page that is already on disk.
  - On the Reels and tagged tabs the first run lists every page; later runs stop early as above.
  - **Full scan** lists every page and fills in anything missing.
  - A run can be cancelled; the next run continues where files are missing.
- Single downloads: a post, one picture of a carousel, a thumbnail, a reel, stories and highlights. Hotkey: `Ctrl/Cmd + Shift + D`.
  - They go to the browser's download folder. A setting sends them to the account folder instead when the account is managed; files already there are skipped.
- One folder per account. The account is identified by its numeric id, so a changed username keeps its folder.
  - An account you download for the first time gets a folder named after it inside the default location. You choose that location once, and the popup's settings show it and let you change it. Changing it moves no files; accounts already on the list keep their folders.
  - The panel of a new account also has **Download to another folder…**, which saves that account to a folder you pick instead.
- **Import existing folders** rebuilds the account list from files that are already on disk.
- The toolbar popup lists the managed accounts; a row opens the profile.
  - Accounts can be put into groups of your own, which fold away, and pinned to a block at the top. A group name is used once.
  - The list sorts by name, last run, file count or date added, inside each group; or you set the order by hand, with buttons or by dragging. Dragging also moves an account to another group and a group to another place.
  - The button with the tray and two arrows opens a view with two tabs. **Add** takes pasted profile addresses, one per line, and adds those accounts to the list without contacting the site. The folder of each is set up at its first download.
  - **Export** gives the list back as addresses, in the manual order and with a `# name` line before each group, to copy or save as a text file. Pasting that text adds the accounts to the same groups and keeps their order as the manual order.
- Interface languages: English and Traditional Chinese. The browser's language is used unless you choose one in the popup's settings.
- Times are shown on a 24-hour clock; the settings can switch to 12-hour.

It sends no analytics and no error reports, and loads no remote code. It asks for the `storage` permission and runs on `www.instagram.com` only.

## File names

```
<username>_<unix time>_<media id>_<account id>.<ext>
```

A file counts as downloaded when a file with the same `<media id>_<account id>` exists in the folder, whatever its username, timestamp or extension.

## Requirements

Chrome, Edge or another Chromium browser, version 111 or later. The folder features use the File System Access API, which Firefox and Safari do not provide.

Folder links on Windows: a directory symbolic link (`mklink /D`) can be picked in the folder dialog and behaves like the folder it points to. A junction (`mklink /J`) cannot: the browser shows it as empty. The browser does not list links that sit inside a picked folder; when an account's folder cannot be opened or created there, the extension asks you to pick it, and you can pick the symbolic link or the real folder.

Developer mode (popup settings, off by default) adds "Check a folder": it shows what the browser reports for a folder you pick and can export the result as JSON.

## Build

```
npm install
npm run build        # unpacked extension in dist/
```

Load it: open `chrome://extensions` (or `edge://extensions`), enable Developer mode, choose "Load unpacked" and select the `dist` folder.

## Development

```
npm test             # unit tests
npm run test:e2e     # built extension in Chrome against a mocked platform
npm run check        # type check, unit tests, production build
```

`npm run test:e2e` needs the test browser once: `npx puppeteer browsers install chrome`.

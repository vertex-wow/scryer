# Frequently Asked Questions

## Does Scryer allow me to play World of Warcraft in VSCode?

No. Scryer is an extremely limited preview tool for developing addons. It is not meant to be, never will be, and is not even a partial game replacement. It renders XML frame layouts and resolves template inheritance — that is the full extent of it.

## Does Scryer download game files?

Scryer allows you to reference files from World of Warcraft in your addons. When you do, it uses the World of Warcraft files you already downloaded when you installed the game. In some cases, Blizzard's own installation metadata points resources at their official CDN for fetching — when that happens, Scryer will prompt you first and ask whether you want to do that.

## Does Scryer allow me to browse or download arbitrary World of Warcraft files?

No. Scryer will only access specific assets you reference in your addon because your addon uses or builds upon them — and only if your local install explicitly indexes those files and indicates they should be fetched from a CDN. It is not a tool for browsing or downloading World of Warcraft files outside the very limited scope of addon development.

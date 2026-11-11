# Third-party notices

Explanimate is MIT licensed (see `LICENSE`). It bundles or depends on the following.

## Bundled assets

| Asset                                                                      | Where                                                  | License                                                                            |
| -------------------------------------------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| Excalifont (by Excalidraw)                                                 | `packages/render/assets/fonts/Excalifont-Regular.*`    | SIL Open Font License 1.1 (`packages/render/assets/fonts/OFL-Excalifont.txt`)      |
| Shantell Sans (The Shantell Sans Project Authors, arrowtype/shantell-sans) | `packages/render/assets/fonts/ShantellSans-Informal.*` | SIL Open Font License 1.1 (`packages/render/assets/fonts/OFL-ShantellSans.txt`)    |
| Nunito (The Nunito Project Authors)                                        | `packages/render/assets/fonts/Nunito-Variable.ttf`     | SIL Open Font License 1.1 (`packages/render/assets/fonts/OFL-Nunito.txt`)          |
| Inter 4.1 (The Inter Project Authors, rsms/inter)                          | `apps/web/app/fonts/InterVariable.woff2`               | SIL Open Font License 1.1 (`apps/web/app/fonts/OFL-Inter.txt`)                     |
| Doodle icon pack                                                           | `packages/render/packs/doodle/*.png`                   | Generated for this project with Meta Muse Image; released under MIT with this repo |

The fonts are redistributed unmodified apart from a WOFF2 to TTF container conversion
(needed to read glyph outlines). It is not sold by itself. Shantell Sans is a static
instance of the upstream variable font (Informal 100, weight 400, no bounce or spacing
change) cut down to Latin characters with fontTools; the font has no Reserved Font Name.
Inter is the upstream web build (`InterVariable.woff2` from the v4.1 release), unchanged.

## Runtime dependencies (not vendored, installed from npm)

| Package                  | License    | Use                                                        |
| ------------------------ | ---------- | ---------------------------------------------------------- |
| roughjs                  | MIT        | hand-drawn strokes                                         |
| perfect-freehand         | MIT        | marker-pen strokes that swell and thin                     |
| elkjs                    | EPL-2.0    | graph layout                                               |
| opentype.js              | MIT        | glyph outlines for handwriting text                        |
| playwright-core          | Apache-2.0 | headless Chrome frame capture, screenshots                 |
| sharp                    | Apache-2.0 | image processing                                           |
| zod                      | MIT        | schemas                                                    |
| @mozilla/readability     | Apache-2.0 | article text extraction                                    |
| linkedom                 | ISC        | DOM for Readability                                        |
| next, react              | MIT        | web app                                                    |
| disposable-email-domains | MIT        | temp-mail blocklist for email sign-up                      |
| ffmpeg (system binary)   | LGPL/GPL   | video encoding, invoked as an external process, not linked |

## File formats

The `.excalidraw` output follows the open Excalidraw JSON scene format
(excalidraw/excalidraw, MIT). No Excalidraw source is copied into this repo.

The `.tldr` output is written by our own code from tldraw's public file format
(schema, record shapes and migration versions). The tldraw SDK is not a dependency and
no tldraw source is copied into this repo. The file opens in tldraw.com.

## Trademarks

"Meta", "Muse", "Excalidraw", "tldraw" and other names belong to their owners. Explanimate is an
independent project; it is not affiliated with or endorsed by Meta. It only calls
Meta's public Model API, credited in plain text as "Powered by Meta Muse models".

## Online services called at runtime

| Service                                  | Use                                              |
| ---------------------------------------- | ------------------------------------------------ |
| Meta Model API (api.meta.ai)             | Muse Spark, Muse Image, SAM, Muse Transcribe     |
| Deepgram (optional)                      | Aura text to speech, Nova word timestamps        |
| FxTwitter public API (api.fxtwitter.com) | public X post text and metadata for X post input |
| GitHub                                   | cloning public repos, sign-in (optional)         |

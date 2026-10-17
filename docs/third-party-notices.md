# Licenses and notices

Original notch desktop code is licensed under GNU Affero General Public License v3.0 only (`AGPL-3.0-only`).

Bundled components retain their own licenses. These include the [vendored CLI's Apache 2.0 license](../vendor/notch-cli/LICENSE), [fff's MIT license](../assets/notices/fff-LICENSE.txt), [Manrope's OFL license](../assets/fonts/Manrope-OFL.txt), and [provider mark notices](../assets/notices/provider-logos.md).

The OpenRouter adapter is [@openrouter/ai-sdk-provider 3.1.0](https://github.com/OpenRouterTeam/ai-sdk-provider), licensed under Apache 2.0. Its package and license are retained in the application's `notch/node_modules/@openrouter/ai-sdk-provider` directory.

The Windows update client bundles [electron-updater 6.8.9](https://github.com/electron-userland/electron-builder/tree/v26.15.3/packages/electron-updater) and its runtime dependencies. Their license texts are retained in `notch/vendor/notch-updater/THIRD_PARTY_NOTICES.txt` inside the application archive.

The Windows sharp/libvips binaries use [Apache 2.0 and LGPL 3.0-or-later notices](../assets/notices/sharp-win32-x64-LICENSE.txt). Their source is available from [sharp](https://github.com/lovell/sharp/tree/v0.34.5) and [libvips](https://github.com/libvips/libvips).

The Windows search companion is the unmodified [official ripgrep 15.2.0 x64 MSVC release](https://github.com/BurntSushi/ripgrep/releases/tag/15.2.0), copied as `resources/bin/notch-rg.exe`. It is dual-licensed under [MIT](../assets/notices/ripgrep-LICENSE-MIT.txt) or the [Unlicense](../assets/notices/ripgrep-UNLICENSE.txt), as stated in its [COPYING notice](../assets/notices/ripgrep-COPYING.txt). It includes PCRE2 10.45 under [BSD-3-Clause WITH PCRE2-exception](../assets/notices/ripgrep-PCRE2-LICENSE.txt); its [COPYING notice](../assets/notices/ripgrep-PCRE2-COPYING.txt) is retained. All these notices and fff's MIT license ship in `resources/notices`. Packaging verifies the official ZIP SHA-256 `71b2fef860abe467217a538ff31de02f5258807c0129f771846f87bd029aafc5` and executable SHA-256 `14231169855ec5205cf5a1b6f1db358ff4aed4247c86b69ce8aae647c77f6680` before redistribution. The ZIP is cached under the ignored `release/` directory; no binary is committed.

Electron and Chromium notices ship with the Windows application. Native libraries and upstream application components retain their included notices and applicable terms. The repository's AGPL license does not replace those licenses.

## Optional Colibri runtime

Experimental model setup downloads the unmodified [Colibri 2.0.0 release](https://github.com/JustVugg/colibri/releases/tag/v2.0.0), licensed under Apache-2.0, into the user's isolated notch runtime directory. Its included LICENSE and notices are retained. Engine binaries and model weights are separate downloads; model licenses apply separately.

## Optional local voice runtime

Local voice setup downloads [whisper.cpp](https://github.com/ggml-org/whisper.cpp) (MIT) and the [converted OpenAI Whisper base model](https://huggingface.co/ggerganov/whisper.cpp) (MIT). Binaries and weights are not bundled in the installer. Setup pins the release/model revision and verifies SHA-256 checksums. Windows speech output uses the operating system's installed System.Speech/SAPI voices.

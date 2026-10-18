# Contributing to notch

Contributions are welcome: bug fixes, clearer documentation, accessibility improvements, and better local-model support all help. You do not need collaborator access to submit a pull request.

## Send a pull request

1. [Fork notch](https://github.com/simpleending/notch-desktop/fork) into your GitHub account.
2. Clone your fork and create a branch for your change.
3. Make a focused change and run the relevant checks below.
4. Push the branch to your fork, then [open a pull request](https://github.com/simpleending/notch-desktop/compare) against `simpleending/notch-desktop` on `main`. Choose **compare across forks** to select your branch.

Explain what changes for someone using notch and how you checked it. Include before-and-after screenshots for interface changes. Draft pull requests are welcome if you want feedback before finishing. For a larger change, an [issue](https://github.com/simpleending/notch-desktop/issues) is a useful place to discuss the approach first.

## Check your change

Use Node.js 22.19 or newer. From the repository root:

```sh
npm ci --ignore-scripts
npm test
npm run typecheck
```

If you change `vendor/notch-cli`, also run `npm run build:core` and include the resulting core files. For changes to models, tools, storage, or the interface, run the relevant packaged-app verification described in the [development guide](docs/development.md). Explain any checks you could not run; access to a paid provider is not required to contribute.

On Windows, `build:core` requires Rust with the MSVC toolchain and Visual Studio C++ build tools. It builds the [hardware probe](vendor/notch-cli/native/windows-hardware/README.md) from locked sources and bundles it automatically. Generated executables stay untracked. Run `node scripts/verify-hardware.mjs` with a CLI checkout and Electron executable to verify the npm and ASAR paths.

The development guide covers preparing the workbench and Windows packaging. Downloaded models, generated installers, extracted workbench files, API keys, private chats, and machine-specific test reports do not belong in a pull request. Use small fixtures for regression tests.

## License and attribution

Submit only code and assets you have the right to contribute. Contributions to notch's original code use the repository's [AGPL v3 license](LICENSE). Preserve applicable third-party notices.

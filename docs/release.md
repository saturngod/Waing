# Release and packaging

## Supported artifacts

- macOS: DMG and ZIP; local validation uses an unpacked `.app`.
- Windows: interactive NSIS installer.
- Linux: AppImage and Debian package.

Build all source with `npm run check`. Create a local unpacked app with `npm run package`. Platform release jobs use `npm run dist:mac`, `npm run dist:win`, or `npm run dist:linux` on the corresponding operating system.

## macOS signing and notarization

The macOS build enables hardened runtime and applies `apps/desktop/build/entitlements.mac.plist` to the app and inherited code. A public release requires a Developer ID Application certificate and notarization credentials configured for electron-builder. Local packages may remain unsigned or ad-hoc signed and are not public distributables.

Validate a release artifact with:

```sh
codesign --verify --deep --strict --verbose=2 "Waing.app"
codesign -d --entitlements :- "Waing.app"
spctl --assess --type execute --verbose=2 "Waing.app"
xcrun stapler validate "Waing.app"
```

## Release decisions

Automatic updates are disabled for the MVP. Releases are downloaded and installed manually so no update service is implicitly trusted. Remote crash reporting is also disabled. Beta reports use the explicit redacted diagnostics export in Settings; no report is sent automatically.

Windows and Linux artifacts must be built and smoke-tested on native release runners. The configuration exists cross-platform, but a macOS host is not evidence that those platform artifacts launch.

/**
 * electron-builder afterPack hook — ad-hoc sign the macOS app.
 *
 * We have no Apple Developer ID (no notarization), and a fully UNSIGNED app on Apple
 * Silicon fails to launch with the misleading «"…" is damaged and can't be opened» —
 * Gatekeeper, not corruption. An ad-hoc signature makes the binary launchable; downloaded
 * copies then get the normal "unverified developer" flow (right-click → Open, or
 * `xattr -cr` to clear quarantine) instead of the damaged error.
 *
 * @electron/osx-sign (ships with electron-builder) signs every nested helper/framework
 * bottom-up — a bare `codesign --deep` leaves nested components failing strict verify.
 */
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);
  if (!fs.existsSync(appPath)) {
    console.warn(`afterPack: ${appPath} not found — skipping ad-hoc sign`);
    return;
  }
  console.log(`afterPack: ad-hoc signing ${appName}`);
  const { signAsync } = require('@electron/osx-sign');
  await signAsync({
    app: appPath,
    identity: '-', // ad-hoc
    identityValidation: false, // '-' is not a keychain identity — skip the lookup
    optionsForFile: () => ({ hardenedRuntime: false, entitlements: undefined }),
  });
  execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' });
  console.log('afterPack: ad-hoc signature verified (deep, strict)');
};

/**
 * electron-builder afterSign hook: VMP-sign the bundled Electron binary so
 * Widevine accepts it as a verified player. Requires:
 *   pip3 install castlabs-evs
 *   python3 -m castlabs_evs.account signup   # one-time, free
 *
 * Skipped silently when SKIP_VMP_SIGN=1 (useful for non-DRM dev builds).
 */
const { execFileSync } = require("node:child_process");
const path = require("node:path");

module.exports = async function (context) {
  if (process.env.SKIP_VMP_SIGN === "1") {
    console.log("VMP sign skipped (SKIP_VMP_SIGN=1)");
    return;
  }
  const appDir = context.appOutDir;
  console.log("VMP signing", appDir);
  try {
    execFileSync(
      "python3",
      ["-m", "castlabs_evs.vmp", "sign-pkg", appDir],
      { stdio: "inherit" },
    );
  } catch (e) {
    console.error(
      "VMP signing failed. Install castlabs-evs (pip3 install castlabs-evs) " +
        "and run `python3 -m castlabs_evs.account signup` once. " +
        "Set SKIP_VMP_SIGN=1 to bypass.",
    );
    throw e;
  }
};

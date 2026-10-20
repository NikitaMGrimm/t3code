#!/usr/bin/env bash
set -euo pipefail
source_root="$1"
output_root="$2"
cd "$source_root"
test "$(git rev-parse HEAD)" = "$SOURCE_SHA"
export NODE_BINARY="$(command -v node)"
pnpm_version="$(node -p "require('./package.json').packageManager.split('@').pop()")"
export PATH="$HOME/.vite-plus/package_manager/pnpm/$pnpm_version/pnpm/bin:$PATH"
cd apps/mobile
vp exec expo prebuild --clean --platform ios --no-install
(cd ios && pod install)
build_root="$RUNNER_TEMP/t3-device-build"
xcodebuild \
  -workspace ios/T3CodeDev.xcworkspace -scheme T3CodeDev \
  -configuration Release -sdk iphoneos -destination 'generic/platform=iOS' \
  -derivedDataPath "$build_root" ARCHS=arm64 ONLY_ACTIVE_ARCH=NO \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY='' DEVELOPMENT_TEAM='' \
  build > "$RUNNER_TEMP/t3-xcodebuild.log" 2>&1 || {
    tail -n 120 "$RUNNER_TEMP/t3-xcodebuild.log"
    exit 1
  }
app="$build_root/Build/Products/Release-iphoneos/T3CodeDev.app"
test -f "$app/main.jsbundle"
test ! -d "$app/PlugIns"
executable=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$app/Info.plist")
test "$(xcrun lipo -archs "$app/$executable")" = arm64
test "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$app/Info.plist")" = dev.nikita.t3.lab
/usr/libexec/PlistBuddy -c 'Set :CFBundleDisplayName T3 Code Lab' "$app/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $GITHUB_RUN_NUMBER" "$app/Info.plist"
mkdir -p "$output_root" "$RUNNER_TEMP/t3-ipa/Payload"
cp -R "$app" "$RUNNER_TEMP/t3-ipa/Payload/"
(cd "$RUNNER_TEMP/t3-ipa" && /usr/bin/zip -qry "$output_root/t3-unsigned.ipa" Payload)
python3 - "$output_root" "$app" <<'PY'
import hashlib, json, os, pathlib, plistlib, subprocess, sys
out, app = map(pathlib.Path, sys.argv[1:])
info = plistlib.loads((app / 'Info.plist').read_bytes())
def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()
(out / 'build-manifest.json').write_text(json.dumps({
    'source_repository': os.environ['SOURCE_REPOSITORY'],
    'source_sha': os.environ['SOURCE_SHA'],
    'workflow_run': os.environ['GITHUB_RUN_ID'],
    'bundle': info['CFBundleIdentifier'], 'version': info['CFBundleShortVersionString'],
    'build': info['CFBundleVersion'], 'architecture': 'arm64',
    'xcode': subprocess.check_output(['xcodebuild','-version'], text=True).strip(),
    'node': subprocess.check_output(['node','--version'], text=True).strip(),
    'ipa_sha256': sha(out / 't3-unsigned.ipa'), 'javascript_sha256': sha(app / 'main.jsbundle'),
    'ota_updates': False, 'capability_mode': 'upstream Personal Team opt-in',
    'limitations': ['No widgets/share extension, push, or Apple sign-in',
                    'Unsigned artifact; local profile validation/signing and device checks required']
}, indent=2) + '\n')
PY

# Devices

Stream and interact with live iOS Simulators, Android Emulators, physical Android devices, and a configured iPhone X right beside a thread, and let agents inspect and drive them via `device_*` tools and the `agent-device` CLI.

## Open a device

Open the right panel in a project thread and choose **Device** (first-time setup starts the device hub, checks iOS/Android tools, and asks whether agents may control devices).

- Start a stopped device or attach to a running one; open additional devices via **+ → Device**.
- Click, drag, and type directly on the live screen; use the toolbar for Home, Back, Recents, rotate, power off, **3D view** (and fold/unfold on foldables), **Tools**, or **Float device over chat**.
- **Tools drawer**: Inspect the foreground app, toggle dark mode, text size, accessibility overlays, mock location, app permissions, iOS VoiceOver / test push notifications, and Android orientation / network toggles.
- Closing a tab stops streaming without powering off the device. Turn off **Settings → Devices → Use devices** to stop helper processes.

## Host prerequisites

Devices run on the environment's server machine (or an SSH/Simlock device host):

- **iOS Simulators**: macOS with Xcode.
- **Android Emulators**: Android SDK Platform-Tools, Android Emulator, Command-line Tools (latest), an AVD created in Android Studio, and `ffmpeg` with `libx264` on `PATH` (or `SERVE_EMU_FFMPEG`). Set `ANDROID_HOME` for custom SDK paths.
- **Physical Android devices**: SDK Platform-Tools only (no `ffmpeg`). Enable **USB debugging** (and **USB debugging (Security settings)** on Xiaomi devices), or pair wirelessly via `adb pair <addr>:<pairing-port>` then `adb connect <addr>:<port>`.

Restart the environment server after installing SDK tools or changing `PATH` / `SERVE_EMU_FFMPEG`.

## Physical iPhone X

Agents can inspect the foreground app's accessibility elements and activate a
control by its returned reference. With the current `ios-device-lab` adapter
and its accessibility helper installed, the device command supports `ax snapshot`,
`ax press SNAPSHOT REF`, and `ax set-value SNAPSHOT REF TEXT`. Text replacement
supports Unicode and reports whether the field's value was read back exactly.
References expire after 30 seconds and are consumed by an action. Navigation,
other input, and control handoffs require a fresh snapshot. Apps expose different
amounts of accessibility information; screenshots and touch input remain available.

The personal fork can connect the iPhone X already configured in
`ios-device-lab`. On the environment server, install that package with its T3
adapter and verify `ios-device-lab x status` succeeds using its existing SSH
configuration. Set **Settings → Integrations → Physical iPhone X** to that
installation's Python executable. Enable Devices, then choose **iPhone X** in
the Device panel. This works on Windows without a Mac or Simulator.

The viewer starts read-only. Choose **Take control** to tap, swipe, type printable
ASCII, and press Home. Human takeover blocks agent input until you release
control or leave it idle for 60 seconds. Another human viewer must release
control before yours can take over. Only one thread can connect the phone at
a time.

Screenshots use the phone's original pixels. The screen refreshes as still
images; it is slower than simulator video. Rotation, simulator settings, app
installation, and reboot are unavailable in this adapter.
Agents receive a phone-specific command when they use `device_open`.

Choose **Disconnect phone**, or have the agent use `device_close`, to release
the connection. Hiding or closing the viewer keeps it attached. Clear the
Python setting or turn off Devices to stop the adapter. The existing phone
setup stays in place; T3 installs no service on the phone.

## Agents and devices

Enable **Settings → Devices → Agents can use devices** so agents can drive devices through `agent-device` (restart existing agent sessions after enabling). First iOS tap builds a small test runner once per server (~2 minutes).

When an agent opens a device, it floats over chat by default (disable **Settings → Browser → Auto-show floating preview** to open in the right panel instead). On mobile, tap the device button above the composer to watch and interact.

## Remote connections

Device video streams through the environment server (works over LAN, Tailscale, and T3 Connect). Live video requires HTTPS or `localhost`—plain HTTP remote origins fall back to still images on iOS and disable video on Android (except Expo Simulators).

## SSH device hosts

Use simulators/emulators on another macOS or Linux machine (e.g., a Mac build host from Linux/Windows):

1. Open **Settings → Devices → Add source → Machine over SSH** and enter an SSH alias or `user@host` (uses the environment server's SSH config/keys; no password prompts).
2. Run **Test connection** to verify SSH, Node.js 22.12+, npm, and SDK tools (Android on SSH hosts requires full SDK tools + `ffmpeg` for emulators).
3. First listing installs pinned device helpers on the SSH host.

> Note: Remote simulators cannot reach `localhost` dev servers (like Metro) on your main host without port forwarding or a reachable network address.

## Simlock hosts (alpha)

Connect to a [Simlock](https://incubator.callstack.com/simlock/) device pool (requires Simlock `main` at commit `6316e10`+ with `capabilities.stream.enabled` and `capabilities.input.enabled`):

1. Enable **Settings → Labs → Simlock device hosts (alpha)** and **Settings → Devices → Use devices**.
2. Choose **Add source → Simlock pool** with an agent token (`simlock --gateway token create --role agent`) over HTTPS or Tailscale (give each T3 server its own token; treat it like worker shell access).
3. Closing a device with **Return device to the pool** wipes and releases the lease. Toolbar tools/rotation/screenshots are unavailable in the UI (agents can still invoke them via `device_open`).

## Device tool updates

The T3 server manages device hub and `agent-device` versions automatically on itself and SSH hosts. Check versions in **Settings → Devices → Check versions**; update the remote T3 server to receive newer device tools.

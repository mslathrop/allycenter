# Ally Center Architecture

## Purpose and scope

Ally Center is a privileged [Decky Loader](https://decky.xyz/) plugin for ASUS ROG Ally devices running SteamOS-compatible Linux distributions. It exposes hardware controls in Steam's Quick Access Menu (QAM): power and fan profiles, CPU controls, battery data and charge limits, joystick-ring RGB, device information, and a low-power download mode.

This document describes the architecture implemented in this repository. Paths and behavior are based on the current code rather than on hardware guarantees; kernel and firmware interfaces can differ across Ally models and distributions.

## System context

```text
User in Steam QAM
       |
       v
React/TypeScript UI (src/index.tsx)
       |
       | Decky callable RPC
       v
Decky Loader plugin runtime
       |
       v
Privileged Python backend (main.py)
       |
       +-- JSON settings in Decky's plugin settings directory
       +-- Linux sysfs/procfs/DMI/hwmon
       +-- ASUS WMI kernel driver
       +-- optional /usr/bin/ryzenadj
```

Decky owns frontend/backend loading and RPC transport. `plugin.json` requests the `root` flag because most hardware control files require elevated permissions. The frontend does not access the operating system directly.

## Repository map

| Path | Responsibility |
| --- | --- |
| `src/index.tsx` | Entire QAM frontend, RPC declarations, local UI state, polling, modals, and download-mode overlay |
| `main.py` | Decky backend lifecycle, RPC methods, settings persistence, hardware discovery/control, and RGB animation workers |
| `plugin.json` | Decky metadata, API version, publishing metadata, and root privilege declaration |
| `defaults/defaults.json` | Packaged baseline settings; runtime defaults are also defined in `main.py` |
| `package.json`, `rollup.config.js`, `tsconfig.json` | TypeScript/Rollup frontend build configuration |
| `install.sh` | Downloads a release archive into Decky's plugin directory and restarts `plugin_loader` |
| `release.sh` | Updates version strings, builds the frontend, and creates the release ZIP |
| `icons/`, `images/` | Plugin icon and README screenshots |

The project is deliberately small and currently has no internal modules: each runtime side is a single source file.

## Runtime components

### Frontend

`src/index.tsx` registers the plugin with `definePlugin`. Its `AllyCenterContent` component composes independent QAM sections:

- `DownloadModeSection`
- `PerformanceSection`
- `CpuSettingsSection`
- `BatteryHealthSection`
- `RgbLightingSection`
- `DeviceInfoSection`
- `AboutSection`

Each section owns React state and calls named backend methods through `@decky/api`'s `callable`. Notifications are presented with Decky's toaster. Device information is cached for the lifetime of the frontend module; battery information is polled every 10 seconds, while profiles and temperature/clock telemetry are polled every 3 seconds.

Download mode also registers a global `BlackScreenOverlay` through `routerHook`. A module-level `DownloadModeState` event emitter lets the QAM section and overlay share state without a broader state-management dependency. The overlay is visual only; the backend performs brightness and power changes.

On dismount, the frontend removes the overlay and clears its local download-mode state. Backend unload separately restores the display if the backend believes it turned it off.

### Backend

Decky instantiates the `Plugin` class in `main.py` and invokes these lifecycle hooks:

- `_main`: establishes the settings path and loads or creates settings.
- `_unload`: stops an RGB worker and restores the display if download mode is active.
- `_migration`: currently a no-op reserved for future migrations.

Public async methods on `Plugin` form the RPC surface. They return JSON-serializable dictionaries, booleans, and primitive values. Private helpers handle sysfs discovery, RGB output, and animation threads.

The backend uses capability detection (`os.path.exists`) before most device operations. Read failures generally produce default/partial data; write failures are logged and usually return `False`.

### Hardware adapters

The backend talks directly to Linux kernel interfaces rather than introducing an adapter abstraction:

| Domain | Primary interface | Fallback or notes |
| --- | --- | --- |
| Device identity | `/sys/class/dmi/id`, `/proc/cpuinfo`, `/proc/meminfo`, `uname -r` | GPU name is inferred from CPU text |
| Battery | `/sys/class/power_supply/BAT0` | Health is calculated from full/design energy |
| Charge limit | ASUS WMI `charge_control_end_threshold` | Stored even when the sysfs control is unavailable |
| RGB | `/sys/class/leds/ally:rgb:joystick_rings` | Uses `multi_intensity` and `brightness` |
| TDP | ASUS WMI `ppt_*` files | Falls back to `/usr/bin/ryzenadj` |
| Fan policy | Discovered `throttle_thermal_policy` | Searches ASUS WMI and hwmon locations |
| Telemetry | `/sys/class/hwmon` | Recognizes `k10temp`, `zenpower`, and `amdgpu` |
| Display brightness | `/sys/class/backlight/amdgpu_bl0` | No alternative backlight discovery in the download-mode setter |
| CPU SMT/boost | CPU sysfs controls | Controls are hidden by the UI if files are absent |
| MCU power saving | ASUS WMI `mcu_powersave` | Used with RGB and download mode |

## RPC boundary

The frontend currently binds the following backend operations:

| Area | Reads | Writes/actions |
| --- | --- | --- |
| Device | `get_device_info` | — |
| Battery | `get_battery_info`, `get_charge_limit` | `set_charge_limit` |
| RGB | `get_rgb_state` | `set_rgb_color`, `set_rgb_brightness`, `set_rgb_effect`, `set_rgb_speed`, `set_rgb_enabled` |
| Performance | `get_performance_profiles`, `get_current_tdp`, `get_tdp_settings` | `set_performance_profile`, `set_tdp`, `set_tdp_override`, `set_use_external_tdp` |
| Fan | `get_fan_info`, `get_fan_diagnostics` | `set_fan_mode` |
| CPU | `get_cpu_settings` | `set_smt_enabled`, `set_cpu_boost_enabled` |
| Display | `get_screen_state` | `set_screen_state`, `toggle_screen` |

Some declared calls are not exercised by the current UI (`get_charge_limit`, `get_screen_state`, `toggle_screen`, and `get_fan_diagnostics`). The backend also exposes generic settings and brightness methods that have no frontend binding.

There is no separate schema or generated client. TypeScript interfaces document expected response shapes, but compatibility between them and Python dictionaries is maintained manually.

## State and persistence

Runtime settings live in `Plugin.settings` and are serialized to:

```text
<DECKY_PLUGIN_SETTINGS_DIR>/settings.json
```

This typically corresponds to the path documented in the README, `~/homebrew/settings/Ally Center/settings.json`, but Decky's supplied directory is authoritative. Writes replace the complete JSON document and are not synchronized across concurrent calls.

Persisted values include the active profile, custom TDP and override flags, fan mode, charge limit, RGB configuration, CPU preferences, and brightness/profile snapshots used by download mode. The backend defines defaults when no file exists. `defaults/defaults.json` is packaged but is not read by `main.py`; its values must therefore be kept aligned manually with the runtime defaults.

Not all state is persistent:

- Whether download mode is currently active is held in backend memory (`screen_off`) and separately in frontend memory.
- The frontend remembers whether RGB was enabled before entering download mode only for the current frontend lifetime.
- RGB animation lifecycle is represented by an in-memory flag and one daemon thread.

## Important flows

### Applying a performance preset

1. The user selects a preset in `PerformanceSection`.
2. The frontend calls `set_performance_profile(profile_id)`.
3. The backend looks up the fixed profile in `PERFORMANCE_PROFILES`.
4. It applies TDP through ASUS WMI or `ryzenadj`, then maps the fan mode to an ASUS thermal policy.
5. It saves `current_profile` and disables manual TDP override.
6. The frontend updates its selected profile and shows a toast.

The `gpu_clock` values in the preset definitions are descriptive today; profile application does not set a GPU clock.

### Download mode

1. The frontend reads and remembers the current RGB-enabled flag.
2. `set_screen_state(false)` saves brightness and the current profile, writes brightness `0`, applies the 5 W download profile, enables MCU power saving, and marks backend `screen_off`.
3. The frontend disables RGB, activates the full-screen black overlay, and closes the QAM.
4. Reopening the QAM allows exit. `set_screen_state(true)` restores saved brightness and profile and disables MCU power saving; the frontend conditionally restores RGB.

This is an orchestrated multi-device operation, not a transaction. A failure partway through can leave some settings applied.

### RGB effects

Static RGB is written once. Animated effects stop the previous worker and start one daemon `threading.Thread` that periodically writes LED color/brightness. Pulse, spectrum, wave, and flash use a speed-derived delay; battery mode refreshes every five seconds. Settings changes restart the effect when necessary. Backend unload attempts to stop and join the worker.

## Build, packaging, and installation

The frontend build is:

```text
src/index.tsx -> @decky/rollup -> dist/ (ES module + source map)
```

`pnpm run build` clears `dist` and invokes Rollup. Python is shipped as source and is loaded by Decky. The release archive contains `dist`, `main.py`, plugin/package metadata, the README and license, defaults, and icons. `ARCHITECTURE.md` is repository documentation and is not currently included by `release.sh`. The installer queries GitHub's latest release, extracts its ZIP into `~/homebrew/plugins/Ally Center`, and restarts the `plugin_loader` systemd service.

There is no CI configuration and `pnpm test` explicitly reports that no tests are configured. Validation is currently the TypeScript production build plus manual testing on supported hardware.

## Security and reliability boundaries

- The plugin runs as root and writes directly to power, thermal, LED, backlight, and CPU controls. All new RPC inputs should be validated and bounded in the backend, even if the UI constrains them.
- Hardware availability is distribution-, kernel-, and model-dependent. New controls should expose an `available` capability and degrade without preventing unrelated sections from loading.
- RPC calls can overlap with polling and RGB worker activity. Settings writes and thread-shared fields currently have no locks.
- Most hardware changes are persistent only in the plugin settings, not automatically re-applied during `_main`. The actual device state can therefore diverge after reboot, driver reload, or modification by another plugin.
- `use_external_tdp` is a UI coordination flag. Backend `set_tdp` and `set_performance_profile` do not enforce it, so other callers can still change TDP.

## Known implementation constraints

These details are useful when modifying the system:

- `set_charge_limit` is defined twice in `Plugin`; Python uses the later definition. That implementation reports success and saves the preference even if the hardware control does not exist.
- `BACKLIGHT_PATH` names a concrete backlight device. `set_screen_state` treats it that way, while `_get_brightness` and `set_brightness` treat it as a directory containing devices. Those generic read/set helpers therefore do not match the download-mode path model.
- `set_performance_profile` does not propagate failures from its TDP or fan operations and can report success after a partial application.
- Frontend write handlers are inconsistent about rollback and error notification; several optimistically update local state regardless of backend success.
- The settings class attributes are mutable and shared at class level until assigned on an instance. Decky normally creates one plugin instance, but explicit instance initialization would make ownership clearer.
- Defaults and version strings are duplicated across files, making release consistency dependent on scripts and maintainer discipline.
- The release script uses BSD/macOS-style `sed -i ''`, while the target/runtime platform is Linux; portability should be verified before relying on it there.

## Extension guidance

For a new hardware feature, keep the existing boundary: add capability-aware read/write methods to `Plugin`, bind them with typed `callable` declarations, and place UI state in a focused section component. Validate inputs in Python, return availability explicitly, log failures with enough path context to diagnose kernel differences, and ensure unload can reverse any long-lived side effect.

If the codebase grows, the natural seams for extraction are frontend sections and API types, plus backend modules for settings, hardware discovery, RGB, performance, battery, and display control. A shared RPC contract and mocked filesystem tests would reduce the main risks created by today's manually synchronized types and hardware-dependent behavior.

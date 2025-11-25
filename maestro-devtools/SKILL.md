---
name: maestro-devtools
description: A wrapper around Maestro CLI that allows for atomic UI interactions (tap, type) and inspection without writing YAML files manually. Useful for debugging, benchmarking, and verifying UI parity between Native and Web.
allowed-tools: Bash, Read
---

# Maestro DevTools

This skill provides a bridge to the Maestro mobile testing framework, allowing you to interact with running Android/iOS apps or Mobile Web browsers using simple atomic commands.

## Capabilities

- **Tap**: Click on UI elements by text or ID.
- **Type**: Input text into fields.
- **Inspect**: View the current UI hierarchy (View XML).
- **Targeting**: Switch seamlessy between `native` app and `web` (WebView/Browser) contexts.

## Prerequisite
- Maestro CLI must be installed (`curl -Ls "https://get.maestro.mobile.dev" | bash`)
- A simulator/emulator must be running.

## Usage

The tool is a Python script located at `maestro_bridge.py`.

### 1. Tapping Elements
Tap by visible text or accessibility ID.

```bash
# Native App
./maestro_bridge.py tap "Login Button" --target native

# Web Browser (automatically navigates to URL if needed)
./maestro_bridge.py tap "Login Button" --target web --url "http://localhost:8081"
```

### 2. Typing Text
```bash
./maestro_bridge.py type "user@example.com"
```

### 3. Inspecting UI
Dumps the current view hierarchy (useful to find IDs).
```bash
./maestro_bridge.py inspect
```

### 4. Configuration
You can override the App ID:
```bash
./maestro_bridge.py tap "Submit" --app-id "com.mycompany.app"
```

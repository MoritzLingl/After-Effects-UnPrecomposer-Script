# Un-PreCompose for After Effects

Releases the contents of selected pre-comp layers back into the parent composition, the reverse of **Layer > Pre-compose**, while keeping the result looking the same.

- Keeps layer order, effects, masks, keyframes and expressions
- Rebuilds parenting and track mattes between the released layers
- Converts timing correctly (start offset, time stretch) and can trim to the pre-comp layer's in/out points
- Keeps the pre-comp layer's position, scale and rotation (animated or not) by turning it into a hidden *container* layer when needed
- Works on several selected pre-comps at once, and the whole run is a single undo step
- Warns you up front about anything that can't be carried over

Built for **After Effects 2026 (26.x)** on **macOS** and **Windows**. It only uses long-standing scripting APIs, so older versions will likely work too, but they are not tested.

---

## Installation

There is no installer. The whole tool is one file, `Un-PreCompose.jsx`.

**Get the file:** on GitHub, click `Un-PreCompose.jsx`, then the **Download raw file** button (the download arrow at the top right of the file view). Or download the whole repository via **Code > Download ZIP**.

### Option 1: just run it (no install, no admin rights)

Works the same on macOS and Windows:

1. In After Effects, choose **File > Scripts > Run Script File...**
2. Pick `Un-PreCompose.jsx`.

That's it. Keep the file somewhere handy, such as your Documents folder; you'll pick it from there each time. After Effects remembers the folder you used last.

### Option 2: add it to the File > Scripts menu

Copy the file once into After Effects' `Scripts` folder, then **restart After Effects**. It will then appear under **File > Scripts**.

**macOS**

1. In Finder, press **Cmd+Shift+G** and paste:
   ```
   /Applications/Adobe After Effects 2026/Scripts
   ```
2. Drag `Un-PreCompose.jsx` into that folder. Click **Authenticate** and enter your Mac password when Finder asks.

**Windows**

1. In File Explorer, paste this into the address bar and press Enter:
   ```
   C:\Program Files\Adobe\Adobe After Effects 2026\Support Files\Scripts
   ```
2. Drag `Un-PreCompose.jsx` into that folder. Click **Continue** when Windows asks for administrator permission.

For another After Effects version, replace `2026` with your version's year.

---

## Usage

1. Open a composition and select one or more layers whose source is a composition.
2. Choose **File > Scripts > Un-PreCompose.jsx** (or **Run Script File...** if you use Option 1).
3. Review the options and any warnings, then click **Un-PreCompose**.
4. A short report lists what was done. To revert everything, press **Cmd+Z** (macOS) or **Ctrl+Z** (Windows) once.

### Options

| Option | Default | What it does |
|---|---|---|
| Keep transform with a container layer when needed | On | If the pre-comp layer is moved, scaled, rotated, animated, 3D, or other layers are parented to it, it's kept as a disabled guide layer and the released layers are parented to it. If its transform is neutral, it is simply deleted. |
| Trim released layers to the pre-comp layer's in/out points | On | Released layers only show where the pre-comp layer did. |
| Delete released layers that fall outside that range | Off | Removes layers that would be completely invisible after trimming (instead of disabling them). Layers that others depend on as parent or matte are always kept. |
| Make container layers shy | Off | Hides containers from the timeline when the Shy switch is active. |
| Delete the source composition if nothing else uses it | Off | Cleans up the Project panel. |

### What can't be carried over

The released layers can't inherit properties applied **to the pre-comp layer itself**. The script warns you before running if any of these are present:

- effects, masks, opacity, blending mode, or a track matte on the pre-comp layer
- time remapping, collapse transformations, Master (Essential) Property overrides

Also worth knowing:

- Expressions that reference layers by name (`thisComp.layer("Name")`) now resolve in the parent comp. If a layer with the same name already exists there, they may point at the wrong one. A container layer is renamed to `[container] <name>`, which can also break expressions that referenced the pre-comp layer by name.
- Only one level is released per run. Nested pre-comps inside the released layers stay as they are; run the script again on them if needed.

---

## Security & permissions

The script is a single, readable text file with no dependencies. It:

- does **not** read or write files on disk
- does **not** access the network
- does **not** run shell commands or evaluate dynamic code
- only changes the open project, inside one undo group

So you can leave **Allow Scripts to Write Files and Access Network** turned **off** in After Effects' Scripting & Expressions settings.

See [SECURITY.md](SECURITY.md) for how to report a problem.

---

## Uninstall

Delete `Un-PreCompose.jsx` from the `Scripts` folder you copied it into (Option 2) and restart After Effects. With Option 1 there is nothing to uninstall.

## Troubleshooting

| Problem | Fix |
|---|---|
| Script doesn't appear under File > Scripts | Restart After Effects. Check the file is directly in the `Scripts` folder, not in `ScriptUI Panels` or a subfolder. |
| "Select at least one layer whose source is a composition" | Select the pre-comp layer in the timeline, not the composition in the Project panel. |
| A layer is reported as skipped | Read the reason in the report, e.g. unlock a locked pre-comp layer first. |
| The Scripts folder path doesn't exist | Check your version: the folder name contains the year, e.g. `Adobe After Effects 2025`. Or use Option 1. |

## Development

`tests/mock_test.js` runs the script against a small mock of the After Effects object model (ordering, parenting, timing, container logic):

```bash
node tests/mock_test.js Un-PreCompose.jsx
```

It's a sanity check, not a replacement for testing inside After Effects.

## License

[MIT](LICENSE)

*Not affiliated with or endorsed by Adobe. Adobe and After Effects are trademarks of Adobe Inc.*

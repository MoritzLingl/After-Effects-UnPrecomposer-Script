# Changelog

## 1.1.0 - 2026-10-26

- Fix: released layers are now parented with `setParentWithJump()`. Assigning `layer.parent` directly made After Effects add a compensating offset, which misplaced child layers and layers attached to the container.
- Fix: layers that other layers are parented to keep their rig (the pre-comp layer becomes a container instead of being deleted).
- Fix: "delete layers outside the trim range" no longer deletes layers that others use as parent or track matte.
- Locked pre-comp layers are skipped with a clear message instead of failing mid-run.
- Source is pure ASCII so it decodes the same on macOS and Windows.
- Added README with macOS and Windows setup (no installer needed), license and security policy.

## 1.0 - initial version

/**********************************************************************
 * Un-PreCompose.jsx   v1.1.0
 *
 * Takes the selected pre-comp layers in the active composition and
 * releases their contents back into that composition, trying to keep
 * the visual result identical.
 *
 * Handles:
 *   - layer order, names, effects, masks, keyframes, expressions
 *     (via copyToComp)
 *   - internal parenting hierarchy and track mattes
 *   - time offset (startTime), time stretch, trimming to the
 *     pre-comp layer's in/out points
 *   - the pre-comp layer's own transform: if it is not neutral, the
 *     pre-comp layer is converted into a disabled "container" layer
 *     (same transform, animation included) and the released layers are
 *     parented to it
 *   - multiple selected pre-comps, nested pre-comps (one level per run)
 *
 * Cannot transfer (you are warned before anything happens):
 *   - effects / masks / opacity / blending mode / track matte applied
 *     ON the pre-comp layer itself
 *   - time remapping, collapse transformations, Master (Essential)
 *     Property overrides
 *
 * Target:  Adobe After Effects 26.x (2026), macOS and Windows.
 * Use:     File > Scripts > Run Script File..., or copy into the
 *          After Effects Scripts folder (see README.md)
 *
 * Security: this script does not read or write files, does not access
 * the network, does not run shell commands and does not evaluate code.
 * "Allow Scripts to Write Files and Access Network" can stay OFF.
 *
 * Source is kept pure ASCII on purpose: ExtendScript may decode files
 * without a BOM using the system code page (notably on Windows), so all
 * non-ASCII characters in strings are written as \u escapes.
 *
 * License: MIT (see LICENSE)
 **********************************************************************/

#target aftereffects

(function UnPreCompose() {

    var SCRIPT_NAME = "Un-PreCompose";
    var VERSION = "1.1.0";
    var EPS = 0.0001;

    var CHECK = "\u2713", CROSS = "\u2716", WARN = "\u26A0", ARROW = "\u2192", DASH = "\u2014";

    /* ------------------------------------------------------------------
     * generic helpers (ExtendScript / ES3 only - no let/const/arrow)
     * ---------------------------------------------------------------- */

    function isArr(v) { return v instanceof Array; }

    function valEq(a, b, eps) {
        if (eps === undefined) { eps = EPS; }
        if (isArr(a) || isArr(b)) {
            if (!isArr(a) || !isArr(b)) { return false; }
            var n = Math.max(a.length, b.length);
            for (var i = 0; i < n; i++) {
                var av = (a[i] === undefined) ? 0 : a[i];
                var bv = (b[i] === undefined) ? 0 : b[i];
                if (Math.abs(av - bv) > eps) { return false; }
            }
            return true;
        }
        return Math.abs(a - b) <= eps;
    }

    function isStatic(prop) {
        if (!prop) { return true; }
        try {
            if (prop.numKeys > 0) { return false; }
            if (prop.expressionEnabled && prop.expression !== "") { return false; }
        } catch (e) {}
        return true;
    }

    function tryProp(layer, name) {
        try { return layer.property(name); } catch (e) { return null; }
    }

    function groupCount(layer, name) {
        var g = tryProp(layer, name);
        if (!g) { return 0; }
        try { return g.numProperties; } catch (e) { return 0; }
    }

    function layerId(L) {
        try { if (L.id !== undefined && L.id !== null) { return L.id; } } catch (e) {}
        return -1;
    }

    function snapshotIds(comp) {
        var map = {}, i;
        for (i = 1; i <= comp.numLayers; i++) {
            map["k" + layerId(comp.layer(i))] = true;
        }
        return map;
    }

    /* Returns the layer that was added since the snapshot was taken. */
    function findNewLayer(comp, known) {
        var i, L, id;
        for (i = 1; i <= comp.numLayers; i++) {
            L = comp.layer(i);
            id = layerId(L);
            if (id === -1) { return comp.layer(1); }   // very old host: copyToComp puts it on top
            if (!known["k" + id]) {
                known["k" + id] = true;
                return L;
            }
        }
        return null;
    }

    function deselectAll(comp) {
        for (var i = 1; i <= comp.numLayers; i++) {
            try { comp.layer(i).selected = false; } catch (e) {}
        }
    }

    /* Parent WITHOUT transform compensation.
     * The released layers carry transform values that are expressed in the
     * coordinate space of their (new) parent already, so AE must not add an
     * offset. Assigning layer.parent directly WOULD add one. */
    function parentKeepValues(child, parent) {
        if (typeof child.setParentWithJump === "function") {
            child.setParentWithJump(parent);
        } else {
            child.parent = parent;   // legacy fallback (very old hosts)
        }
    }

    /* Trim a layer without ever passing through an invalid in>out state. */
    function setInOut(layer, inP, outP, minDur) {
        if (outP - inP < minDur) { outP = inP + minDur; }
        try {
            if (inP >= layer.outPoint) {
                layer.outPoint = outP;
                layer.inPoint = inP;
            } else {
                layer.inPoint = inP;
                layer.outPoint = outP;
            }
        } catch (e) {}
    }

    /* ------------------------------------------------------------------
     * inspection
     * ---------------------------------------------------------------- */

    function getSelectedPrecompLayers(comp) {
        var out = [], sel = comp.selectedLayers, i, L;
        for (i = 0; i < sel.length; i++) {
            L = sel[i];
            if (L instanceof AVLayer && L.source && (L.source instanceof CompItem)) {
                out.push(L);
            }
        }
        out.sort(function (a, b) { return a.index - b.index; });
        return out;
    }

    function hasChildrenInComp(L) {
        var comp = L.containingComp, i, other;
        for (i = 1; i <= comp.numLayers; i++) {
            other = comp.layer(i);
            if (other === L) { continue; }
            try { if (other.parent && other.parent === L) { return true; } } catch (e) {}
        }
        return false;
    }

    /* Does the pre-comp layer's own transform change anything?
     * Inner point p maps to  q = position + R*S*(p - anchorPoint).
     * So the transform is neutral when position == anchorPoint,
     * scale == 100%, rotation == 0 and nothing is animated.
     * Layers that other layers are parented to are always kept as a
     * container so that rig stays intact. */
    function needsContainer(L) {
        var t = L.transform;
        if (L.threeDLayer) { return true; }
        if (hasChildrenInComp(L)) { return true; }
        try { if (t.position.dimensionsSeparated) { return true; } } catch (e) {}

        var props = [t.position, t.anchorPoint, t.scale, t.rotation];
        for (var i = 0; i < props.length; i++) {
            if (!isStatic(props[i])) { return true; }
        }
        if (!valEq(t.anchorPoint.value, t.position.value, 0.001)) { return true; }
        if (!valEq(t.scale.value, [100, 100], 0.001)) { return true; }
        var rot = t.rotation.value % 360;
        if (Math.abs(rot) > 0.001 && Math.abs(Math.abs(rot) - 360) > 0.001) { return true; }
        return false;
    }

    function hasMasterProperties(L) {
        var names = ["ADBE Layer Overrides", "Essential Properties"];
        for (var i = 0; i < names.length; i++) {
            if (groupCount(L, names[i]) > 0) { return true; }
        }
        return false;
    }

    function usedAsMatteInComp(L) {
        var comp = L.containingComp, i, other;
        for (i = 1; i <= comp.numLayers; i++) {
            other = comp.layer(i);
            if (other === L) { continue; }
            try {
                if (other.trackMatteLayer && other.trackMatteLayer === L) { return true; }
            } catch (e) {}
        }
        return false;
    }

    /* Returns {fatal:[], warn:[]} for one pre-comp layer. */
    function inspectLayer(L) {
        var res = { fatal: [], warn: [] };
        var comp = L.containingComp, src = L.source, t = L.transform;

        if (src === comp) { res.fatal.push("the layer's source is the composition itself"); }
        if (L.locked) { res.fatal.push("the layer is locked " + DASH + " unlock it first"); }
        if (L.stretch < 0) { res.fatal.push("negative time stretch is not supported"); }
        if (src.numLayers === 0) { res.warn.push("source comp is empty " + DASH + " the layer will simply be deleted"); }

        if (groupCount(L, "ADBE Effect Parade") > 0) {
            res.warn.push(groupCount(L, "ADBE Effect Parade") + " effect(s) on the pre-comp layer will be lost");
        }
        if (groupCount(L, "ADBE Mask Parade") > 0) {
            res.warn.push(groupCount(L, "ADBE Mask Parade") + " mask(s) on the pre-comp layer will be lost");
        }
        if (!isStatic(t.opacity) || !valEq(t.opacity.value, 100, 0.001)) {
            res.warn.push("opacity on the pre-comp layer cannot be inherited by the released layers");
        }
        try {
            if (L.blendingMode !== BlendingMode.NORMAL) {
                res.warn.push("blending mode on the pre-comp layer will be lost");
            }
        } catch (e) {}
        try {
            if (L.trackMatteType !== TrackMatteType.NO_TRACK_MATTE) {
                res.warn.push("the track matte on the pre-comp layer will be lost");
            }
        } catch (e) {}
        if (usedAsMatteInComp(L)) {
            res.warn.push("another layer uses this pre-comp layer as its track matte " + DASH + " that link will break");
        }
        if (L.timeRemapEnabled) {
            res.warn.push("time remapping will be discarded");
        }
        if (L.collapseTransformation) {
            res.warn.push("collapse transformations is on " + DASH + " rendering may differ");
        }
        if (hasMasterProperties(L)) {
            res.warn.push("Master (Essential) Property overrides will be lost");
        }
        if (L.threeDLayer) {
            res.warn.push("layer is 3D " + DASH + " released 2D layers will be parented to a 3D container");
        }
        if (Math.abs(src.frameRate - comp.frameRate) > 0.001) {
            res.warn.push("source comp runs at " + src.frameRate.toFixed(3) + " fps, target at " + comp.frameRate.toFixed(3) + " fps");
        }
        if (src.width !== comp.width || src.height !== comp.height) {
            res.warn.push("comp sizes differ (" + src.width + "x" + src.height + " vs " + comp.width + "x" + comp.height + ") " + DASH + " expressions using thisComp.width/height may change");
        }
        return res;
    }

    /* ------------------------------------------------------------------
     * the actual work
     * ---------------------------------------------------------------- */

    /* Turns the pre-comp layer itself into a container: its source is
     * swapped for a solid of exactly the same size, so every transform
     * value and keyframe stays numerically valid. */
    function makeContainer(L, opts) {
        var comp = L.containingComp, src = L.source;

        if (L.timeRemapEnabled) { L.timeRemapEnabled = false; }

        var tmp = comp.layers.addSolid(
            [0, 0, 0],
            "Un-PreCompose container",
            Math.max(1, src.width),
            Math.max(1, src.height),
            src.pixelAspect,
            comp.duration
        );
        var solidItem = tmp.source;
        tmp.remove();

        L.replaceSource(solidItem, false);

        L.name = "[container] " + L.name;
        L.enabled = false;
        try { L.guideLayer = true; } catch (e) {}
        try { L.shy = opts.shyContainer; } catch (e) {}
        try { L.label = 8; } catch (e) {}
        return L;
    }

    function processLayer(L, opts, report) {
        var comp = L.containingComp;
        var src = L.source;
        var name = L.name;
        var minDur = comp.frameDuration;
        var i;

        /* --- read everything we need before mutating anything --- */
        var Lstart   = L.startTime;
        var Lin      = L.inPoint;
        var Lout     = L.outPoint;
        var s        = L.stretch / 100;
        var Lparent  = L.parent;
        var wantsContainer = needsContainer(L);
        var useContainer = opts.preserveTransform && wantsContainer;

        if (wantsContainer && !useContainer) {
            report.push("! " + name + ": transform is not neutral and container layers are disabled " + DASH + " position/scale/rotation will be lost.");
        }

        /* --- empty source comp: nothing to release --- */
        if (src.numLayers === 0) {
            L.remove();
            report.push("- " + name + ": source comp was empty, layer removed.");
            return { created: [], src: src };
        }

        /* --- collect source layers, unlock them for copying --- */
        var srcLayers = [], wasLocked = [];
        for (i = 1; i <= src.numLayers; i++) {
            srcLayers.push(src.layer(i));
        }
        for (i = 0; i < srcLayers.length; i++) {
            wasLocked[i] = srcLayers[i].locked;
            try { srcLayers[i].locked = false; } catch (e) {}
        }

        /* layers other inner layers depend on (as parent or matte) */
        var isReferenced = [];
        for (i = 0; i < srcLayers.length; i++) {
            try {
                if (srcLayers[i].parent) { isReferenced[srcLayers[i].parent.index - 1] = true; }
            } catch (e) {}
            try {
                if (srcLayers[i].trackMatteType !== TrackMatteType.NO_TRACK_MATTE && srcLayers[i].trackMatteLayer) {
                    isReferenced[srcLayers[i].trackMatteLayer.index - 1] = true;
                }
            } catch (e) {}
        }

        deselectAll(comp);

        /* --- copy the layers over (bottom-most first) --- */
        var known = snapshotIds(comp);
        var newLayers = [];
        for (i = srcLayers.length - 1; i >= 0; i--) {
            try {
                srcLayers[i].copyToComp(comp);
                newLayers[i] = findNewLayer(comp, known);
            } catch (e) {
                newLayers[i] = null;
                report.push("! " + name + ": could not copy \"" + srcLayers[i].name + "\" (" + e.toString() + ")");
            }
        }
        for (i = 0; i < srcLayers.length; i++) {
            try { srcLayers[i].locked = wasLocked[i]; } catch (e) {}
        }

        /* the copies must be editable for the steps below */
        var copyLocked = [];
        for (i = 0; i < newLayers.length; i++) {
            if (!newLayers[i]) { continue; }
            copyLocked[i] = wasLocked[i];
            try { newLayers[i].locked = false; } catch (e) {}
        }

        /* --- restore the original stacking order, right above the pre-comp layer --- */
        var prev = null;
        for (i = 0; i < newLayers.length; i++) {
            if (!newLayers[i]) { continue; }
            try {
                if (prev === null) { newLayers[i].moveBefore(L); }
                else { newLayers[i].moveAfter(prev); }
                prev = newLayers[i];
            } catch (e) {}
        }

        /* --- rebuild the internal parenting hierarchy (no compensation) --- */
        for (i = 0; i < newLayers.length; i++) {
            if (!newLayers[i]) { continue; }
            var p = srcLayers[i].parent;
            try {
                if (p && newLayers[p.index - 1]) { parentKeepValues(newLayers[i], newLayers[p.index - 1]); }
                else if (newLayers[i].parent) { parentKeepValues(newLayers[i], null); }
            } catch (e) {}
        }

        /* --- rebuild track mattes (AE 23+ API, guarded) --- */
        for (i = 0; i < newLayers.length; i++) {
            if (!newLayers[i]) { continue; }
            try {
                var sl = srcLayers[i];
                if (sl.trackMatteType !== TrackMatteType.NO_TRACK_MATTE && sl.trackMatteLayer) {
                    var tgt = newLayers[sl.trackMatteLayer.index - 1];
                    if (tgt && typeof newLayers[i].setTrackMatte === "function") {
                        newLayers[i].setTrackMatte(tgt, sl.trackMatteType);
                    }
                }
            } catch (e) {}
        }

        /* --- timing: inner time t  ->  outer time  Lstart + t * stretch --- */
        var survivors = [];
        for (i = 0; i < newLayers.length; i++) {
            var NL = newLayers[i];
            if (!NL) { continue; }
            var SL = srcLayers[i];

            try {
                if (Math.abs(s - 1) > EPS) { NL.stretch = SL.stretch * s; }
                NL.startTime = Lstart + SL.startTime * s;
            } catch (e) {}

            var newIn  = Lstart + SL.inPoint  * s;
            var newOut = Lstart + SL.outPoint * s;

            if (opts.trimToPrecomp) {
                if (newOut <= Lin + EPS || newIn >= Lout - EPS) {
                    // entirely outside the pre-comp layer's visible range
                    if (opts.deleteInvisible && !isReferenced[i]) {
                        report.push("- " + name + ": \"" + NL.name + "\" was outside the trim range and was deleted.");
                        NL.remove();
                        newLayers[i] = null;
                        continue;
                    }
                    NL.enabled = false;
                } else {
                    setInOut(NL, Math.max(newIn, Lin), Math.min(newOut, Lout), minDur);
                }
            } else {
                setInOut(NL, newIn, newOut, minDur);
            }
            survivors.push(NL);
        }

        /* --- transform: container layer, or straight hand-over --- */
        var rootParent = null;
        if (useContainer) {
            makeContainer(L, opts);
            rootParent = L;
        } else {
            rootParent = Lparent;   // may be null
        }
        if (rootParent) {
            for (i = 0; i < newLayers.length; i++) {
                if (!newLayers[i]) { continue; }
                if (!srcLayers[i].parent) {
                    try { parentKeepValues(newLayers[i], rootParent); } catch (e) {}
                }
            }
        }
        if (useContainer) {
            report.push(CHECK + " " + name + ": " + survivors.length + " layer(s) released, transform kept on a disabled container layer.");
        } else {
            try { L.remove(); } catch (e) {}
            report.push(CHECK + " " + name + ": " + survivors.length + " layer(s) released, no container needed.");
        }

        /* restore lock state on the copies */
        for (i = 0; i < newLayers.length; i++) {
            if (newLayers[i] && copyLocked[i]) {
                try { newLayers[i].locked = true; } catch (e) {}
            }
        }

        return { created: survivors, src: src };
    }

    /* ------------------------------------------------------------------
     * UI
     * ---------------------------------------------------------------- */

    function buildReportText(layers) {
        var lines = [], i, j, info;
        for (i = 0; i < layers.length; i++) {
            info = inspectLayer(layers[i]);
            if (info.fatal.length === 0 && info.warn.length === 0) { continue; }
            lines.push(layers[i].name + " " + ARROW + " " + layers[i].source.name);
            for (j = 0; j < info.fatal.length; j++) { lines.push("   " + CROSS + " SKIPPED: " + info.fatal[j]); }
            for (j = 0; j < info.warn.length; j++) { lines.push("   " + WARN + " " + info.warn[j]); }
            lines.push("");
        }
        return lines.join("\n");
    }

    function showOptionsDialog(layers) {
        var opts = null;
        var w = new Window("dialog", SCRIPT_NAME + " " + VERSION);
        w.orientation = "column";
        w.alignChildren = ["fill", "top"];
        w.spacing = 10;
        w.margins = 16;

        w.add("statictext", undefined,
            layers.length + " pre-comp layer(s) selected in \"" + layers[0].containingComp.name + "\".");

        var g = w.add("panel", undefined, "Options");
        g.orientation = "column";
        g.alignChildren = ["left", "top"];
        g.margins = 14;
        g.spacing = 7;

        var cbTransform = g.add("checkbox", undefined, "Keep transform with a container layer when needed");
        var cbTrim      = g.add("checkbox", undefined, "Trim released layers to the pre-comp layer's in/out points");
        var cbDelInvis  = g.add("checkbox", undefined, "Delete released layers that fall outside that range");
        var cbShy       = g.add("checkbox", undefined, "Make container layers shy");
        var cbCleanup   = g.add("checkbox", undefined, "Delete the source composition if nothing else uses it");
        cbTransform.value = true;
        cbTrim.value = true;
        cbDelInvis.value = false;
        cbShy.value = false;
        cbCleanup.value = false;

        cbTrim.onClick = function () { cbDelInvis.enabled = cbTrim.value; };
        cbTransform.onClick = function () { cbShy.enabled = cbTransform.value; };

        var warnings = buildReportText(layers);
        if (warnings !== "") {
            var p = w.add("panel", undefined, "Before you continue");
            p.orientation = "column";
            p.alignChildren = ["fill", "top"];
            p.margins = 14;
            var et = p.add("edittext", undefined, warnings,
                { multiline: true, scrolling: true, readonly: true });
            et.preferredSize = [520, 150];
        }

        var btns = w.add("group");
        btns.alignment = "right";
        var cancel = btns.add("button", undefined, "Cancel", { name: "cancel" });
        var ok = btns.add("button", undefined, "Un-PreCompose", { name: "ok" });

        ok.onClick = function () {
            opts = {
                preserveTransform: cbTransform.value,
                trimToPrecomp: cbTrim.value,
                deleteInvisible: cbTrim.value && cbDelInvis.value,
                shyContainer: cbShy.value,
                cleanupSource: cbCleanup.value
            };
            w.close(1);
        };
        cancel.onClick = function () { w.close(0); };

        w.show();
        return opts;
    }

    function showReport(lines) {
        var w = new Window("dialog", SCRIPT_NAME + " " + DASH + " done");
        w.orientation = "column";
        w.alignChildren = ["fill", "top"];
        w.margins = 16;
        var et = w.add("edittext", undefined, lines.join("\n"),
            { multiline: true, scrolling: true, readonly: true });
        et.preferredSize = [560, 260];
        var b = w.add("button", undefined, "Close", { name: "ok" });
        b.alignment = "right";
        w.show();
    }

    /* ------------------------------------------------------------------
     * entry point
     * ---------------------------------------------------------------- */

    var proj = app.project;
    if (!proj) {
        alert("Open a project first.", SCRIPT_NAME);
        return;
    }
    var comp = proj.activeItem;
    if (!(comp && comp instanceof CompItem)) {
        alert("Select or open a composition first.", SCRIPT_NAME);
        return;
    }

    var layers = getSelectedPrecompLayers(comp);
    if (layers.length === 0) {
        alert("Select at least one layer whose source is a composition.", SCRIPT_NAME);
        return;
    }

    var opts = showOptionsDialog(layers);
    if (!opts) { return; }

    app.beginUndoGroup(SCRIPT_NAME);
    var report = [];
    var created = [];
    var sourceComps = [];
    try {
        for (var i = 0; i < layers.length; i++) {
            var L = layers[i];
            var info = inspectLayer(L);
            if (info.fatal.length > 0) {
                report.push(CROSS + " " + L.name + ": skipped (" + info.fatal.join("; ") + ")");
                continue;
            }
            var out = processLayer(L, opts, report);
            for (var k = 0; k < out.created.length; k++) { created.push(out.created[k]); }
            if (out.src) {
                var seen = false;
                for (var d = 0; d < sourceComps.length; d++) { if (sourceComps[d] === out.src) { seen = true; } }
                if (!seen) { sourceComps.push(out.src); }
            }
        }

        /* optional project cleanup */
        if (opts.cleanupSource) {
            for (var c = 0; c < sourceComps.length; c++) {
                var sc = sourceComps[c];
                try {
                    if (sc && sc.usedIn && sc.usedIn.length === 0) {
                        var scName = sc.name;
                        sc.remove();
                        report.push("- removed unused composition \"" + scName + "\" from the project.");
                    }
                } catch (e) {}
            }
        }

        /* select the released layers */
        deselectAll(comp);
        for (var m = 0; m < created.length; m++) {
            try { created[m].selected = true; } catch (e) {}
        }
    } catch (err) {
        report.push(CROSS + " Error: " + err.toString() + (err.line ? " (line " + err.line + ")" : ""));
    } finally {
        app.endUndoGroup();
    }

    if (report.length === 0) { report.push("Nothing to do."); }
    showReport(report);

})();

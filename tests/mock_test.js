// Minimal mock of the After Effects object model, enough to run Un-PreCompose.jsx end to end.
const fs = require('fs'), vm = require('vm'), assert = require('assert');
const SRC = fs.readFileSync(process.argv[2], 'utf8').replace(/^#target.*$/m, '//');

function run(scenario) {
  let nextId = 1;
  const ctx = vm.createContext({});
  const toCtx = (v) => Array.isArray(v) ? vm.runInContext(JSON.stringify(v), ctx) : v;
  const P = (v) => ({ value: toCtx(v), numKeys: 0, expressionEnabled: false, expression: '', dimensionsSeparated: false });
  class CompItem {
    constructor(name, w, h) {
      Object.assign(this, { name, width: w, height: h, frameRate: 25, frameDuration: 0.04, duration: 20, pixelAspect: 1, _layers: [], usedIn: [] });
      const self = this;
      this.layers = { addSolid(c, n, w, h) { const L = new AVLayer(n, { name: n, width: w, height: h }); self._add(L, 0); return L; } };
    }
    get numLayers() { return this._layers.length; }
    layer(i) { return this._layers[i - 1]; }
    get selectedLayers() { return this._layers.filter(l => l.selected); }
    _add(L, pos) { L.containingComp = this; this._layers.splice(pos, 0, L); }
    remove() { this.removed = true; }
  }
  class AVLayer {
    constructor(name, source, o = {}) {
      Object.assign(this, { id: nextId++, name, source, parent: null, locked: false, enabled: true, selected: false,
        startTime: 0, inPoint: 0, outPoint: 10, stretch: 100, threeDLayer: false, timeRemapEnabled: false,
        collapseTransformation: false, blendingMode: 1, trackMatteType: 0, trackMatteLayer: null, guideLayer: false, jumpParented: null }, o);
      this.transform = Object.assign({ position: P([960, 540]), anchorPoint: P([960, 540]), scale: P([100, 100]), rotation: P(0), opacity: P(100) }, o.transform || {});
    }
    get index() { return this.containingComp._layers.indexOf(this) + 1; }
    property() { return { numProperties: 0 }; }
    copyToComp(comp) {
      const c = new AVLayer(this.name, this.source, { startTime: this.startTime, inPoint: this.inPoint, outPoint: this.outPoint,
        stretch: this.stretch, locked: this.locked, transform: this.transform });
      comp._add(c, 0);
    }
    moveBefore(x) { const a = this.containingComp._layers; a.splice(a.indexOf(this), 1); a.splice(a.indexOf(x), 0, this); }
    moveAfter(x) { const a = this.containingComp._layers; a.splice(a.indexOf(this), 1); a.splice(a.indexOf(x) + 1, 0, this); }
    remove() { const a = this.containingComp._layers; a.splice(a.indexOf(this), 1); this.removed = true; }
    setParentWithJump(p) { this.parent = p; this.jumpParented = p ? p.name : null; }
    replaceSource(s) { this.source = s; }
  }

  const s = scenario({ CompItem, AVLayer, P });
  const g = {
    CompItem, AVLayer, BlendingMode: { NORMAL: 1 }, TrackMatteType: { NO_TRACK_MATTE: 0 },
    app: { project: { activeItem: s.outer }, beginUndoGroup() {}, endUndoGroup() {} },
    alert: (m) => { throw new Error('alert: ' + m); }, report: null,
    Window: function () {
      const btns = {}; let lastText = '';
      const node = () => ({ add(type, b, text, props) {
        const n = node(); n.type = type; n.value = false; n.text = text;
        if (type === 'button' && props) btns[props.name] = n; if (type === 'edittext') lastText = text; return n; } });
      const w = node(); w.close = () => {};
      w.show = () => { ctx.report = lastText; if (btns.ok && btns.ok.onClick) btns.ok.onClick(); };
      return w;
    },
  };
  Object.assign(ctx, g); vm.runInContext(SRC, ctx); g.report = ctx.report;
  return { s, report: g.report };
}

// Scenario 1: neutral transform, time offset 2s, inner parenting B -> A
{
  const { s, report } = run(({ CompItem, AVLayer }) => {
    const outer = new CompItem('Main', 1920, 1080), inner = new CompItem('Pre', 1920, 1080);
    const A = new AVLayer('A', null, { startTime: 0, inPoint: 0, outPoint: 5 });
    const B = new AVLayer('B', null, { startTime: 1, inPoint: 1, outPoint: 8 });
    inner._add(A, 0); inner._add(B, 1); B.parent = A;
    const bg = new AVLayer('BG', null); outer._add(bg, 0);
    const L = new AVLayer('Pre', inner, { startTime: 2, inPoint: 2, outPoint: 9, selected: true }); outer._add(L, 0);
    return { outer, inner, L };
  });
  const names = s.outer._layers.map(l => l.name);
  assert.deepStrictEqual(names, ['A', 'B', 'BG'], 'stack order: ' + names);
  const [A, B] = s.outer._layers;
  assert.strictEqual(B.jumpParented, 'A', 'B parented to A without compensation');
  assert.strictEqual(A.parent, null);
  assert.strictEqual(A.startTime, 2); assert.strictEqual(B.startTime, 3);
  assert.strictEqual(B.inPoint, 3); assert.strictEqual(B.outPoint, 9, 'B trimmed to precomp out point');
  assert.ok(s.L.removed, 'pre-comp layer removed');
  console.log('scenario 1 OK:', report.split('\n')[0]);
}

// Scenario 2: scaled + offset precomp, stretch 200% -> container + jump-parenting
{
  const { s, report } = run(({ CompItem, AVLayer, P }) => {
    const outer = new CompItem('Main', 1920, 1080), inner = new CompItem('Pre', 1000, 500);
    const A = new AVLayer('A', null, { startTime: 0, inPoint: 0, outPoint: 4 });
    inner._add(A, 0);
    const L = new AVLayer('Pre', inner, { startTime: 1, inPoint: 1, outPoint: 9, stretch: 200, selected: true,
      transform: { position: P([300, 200]), anchorPoint: P([500, 250]), scale: P([50, 50]) } });
    outer._add(L, 0);
    return { outer, inner, L };
  });
  const names = s.outer._layers.map(l => l.name);
  assert.deepStrictEqual(names, ['A', '[container] Pre'], 'order: ' + names);
  const [A, C] = s.outer._layers;
  assert.strictEqual(A.jumpParented, '[container] Pre');
  assert.strictEqual(C.enabled, false); assert.strictEqual(C.guideLayer, true);
  assert.strictEqual(C.source.width, 1000, 'container solid matches source size');
  assert.strictEqual(A.stretch, 200); assert.strictEqual(A.startTime, 1);
  assert.strictEqual(A.outPoint, 9, 'out point = 1 + 4*2');
  console.log('scenario 2 OK; warnings shown:', JSON.stringify(report).slice(0, 120));
}

// Scenario 3: locked pre-comp layer is skipped, nothing changes
{
  const { s, report } = run(({ CompItem, AVLayer }) => {
    const outer = new CompItem('Main', 1920, 1080), inner = new CompItem('Pre', 1920, 1080);
    inner._add(new AVLayer('A', null), 0);
    const L = new AVLayer('Pre', inner, { selected: true, locked: true }); outer._add(L, 0);
    return { outer, inner, L };
  });
  assert.deepStrictEqual(s.outer._layers.map(l => l.name), ['Pre']);
  assert.ok(/skipped/.test(report));
  console.log('scenario 3 OK:', report.trim());
}
console.log('ALL MOCK TESTS PASSED');

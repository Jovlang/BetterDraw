const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { test } = require("node:test");
const { runInNewContext } = require("node:vm");
const { EventEmitter } = require("node:events");

class TFile {
  constructor(path) { this.path = path; }
}
class TFolder {}
class Component {
  registerEvent() {}
  load() { this.onload(); }
  registerDomEvent(element, name, callback) { element[name] = callback; }
}
class Element {
  children = [];
  createEl(tag, options = {}) {
    const child = Object.assign(new Element(), { tag, text: options.text });
    this.children.push(child);
    return child;
  }
  createDiv() { return this.createEl("div"); }
  addClass() {}
  setText(text) { this.text = text; }
  setPointerCapture() {}
  getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 400 }; }
  getContext() {
    return {
      clearRect: () => { this.paints = (this.paints ?? 0) + 1; },
      beginPath() {}, arc() {}, fill() {}, moveTo() {}, lineTo() {}, stroke() {},
    };
  }
}

test("vault SVG insertion, shared editing, retry, reload, and invalid references", async () => {
  const files = new Map();
  const contents = new Map();
  const notices = [];
  let fail = false;
  let writes = 0;

  class Plugin extends Component {
    addCommand(command) { this.insert = command.editorCallback; }
    registerMarkdownCodeBlockProcessor(_, processor) { this.render = processor; }
  }
  const api = {
    Plugin, TFile, TFolder,
    MarkdownRenderChild: class extends Component {
      constructor(element) { super(); this.containerEl = element; }
    },
    Notice: class { constructor(message) { notices.push(message); } },
  };
  const vault = Object.assign(new EventEmitter(), {
    getAbstractFileByPath: (path) => files.get(path),
    async createFolder(path) { files.set(path, new TFolder()); },
    async create(path, data) {
      const file = new TFile(path);
      files.set(path, file);
      contents.set(file, data);
      return file;
    },
    async read(file) { return contents.get(file); },
    async process(file, update) {
      if (fail) throw new Error("Write failed");
      contents.set(file, update(contents.get(file)));
      writes++;
      this.emit("modify", file);
      return contents.get(file);
    },
  });
  const workspace = new EventEmitter();
  workspace.trigger = workspace.emit;
  workspace.onLayoutReady = () => {};

  const module = {};
  const codec = runInNewContext(
    readFileSync(new URL("main.js", require("node:url").pathToFileURL(__filename)), "utf8") +
      "\n({ parse, serialize });",
    {
      module,
      require(name) { assert.equal(name, "obsidian"); return api; },
      window: { crypto: globalThis.crypto },
    },
  );
  const load = () => {
    const plugin = new module.exports();
    plugin.app = { vault, workspace };
    plugin.onload();
    return plugin;
  };
  const plugin = load();
  const normalize = (strokes) => JSON.parse(JSON.stringify(strokes));
  const sample = [[[1, 2]], [[3, 4], [3, 4]], [[5, 6], [7, 8]]];
  assert.deepEqual(normalize(codec.parse(codec.serialize(sample))), sample);

  let markdown;
  const editor = {
    getCursor: () => ({ line: 0 }),
    getLine: () => "A note",
    replaceRange: (text) => { markdown = text; },
    setCursor() {},
  };
  await plugin.insert(editor, { file: new TFile("note.md") });
  const [, path] = /^\s*!\[\[(BetterDraw\/[a-f0-9]{32}\.svg)\]\]\s*$/.exec(markdown);
  const file = files.get(path);
  assert.ok(file instanceof TFile);
  assert.ok(files.get("BetterDraw") instanceof TFolder);
  assert.deepEqual(normalize(codec.parse(contents.get(file))), []);

  const render = async (source, instance = plugin) => {
    const root = new Element();
    let view;
    await instance.render(source, root, { addChild(child) { view = child; view.onload(); } });
    return { root, view, canvas: root.children[1], buttons: root.children[0]?.children };
  };
  const first = await render(path);
  const host = new Element();
  host.isConnected = true;
  host.getAttribute = () => path;
  host.classList = new Set();
  const mount = { path };
  await plugin.mountEmbed(host, mount, () => true);
  assert.ok(host.classList.has("betterdraw-embed"));
  const copy = {
    view: mount.view,
    canvas: mount.root.children[1],
    buttons: mount.root.children[0].children,
  };
  assert.equal(files.size, 2);
  assert.equal(first.view.drawing, copy.view.drawing);
  const point = (x, y) => ({
    pointerId: 1, button: 0, clientX: x, clientY: y,
    preventDefault() {}, stopPropagation() {},
  });
  const initialPaints = copy.canvas.paints;
  first.canvas.pointerdown(point(10, 20));
  first.canvas.pointermove(point(11, 21));
  first.canvas.pointerup(point(14, 25));
  await first.view.drawing.pendingSave;
  assert.equal(writes, 1);
  assert.match(contents.get(file), /<path d="M 10 20 L 11 21 L 14 25"/);
  assert.ok(copy.canvas.paints > initialPaints);

  const reopened = await render(path, load());
  assert.deepEqual(normalize(reopened.view.drawing.strokes), [[[10, 20], [11, 21], [14, 25]]]);

  fail = true;
  copy.buttons[0].click();
  await copy.view.drawing.pendingSave;
  assert.equal(writes, 1);
  assert.match(notices.at(-1), /could not save/);
  fail = false;
  assert.deepEqual(copy.buttons.map((button) => button.text), ["Undo stroke"]);
  copy.canvas.pointerdown(point(30, 40));
  copy.canvas.pointerup(point(30, 40));
  await copy.view.drawing.pendingSave;
  assert.equal(writes, 2);
  assert.deepEqual(normalize(codec.parse(contents.get(file))), [[[30, 40]]]);
  copy.buttons[0].click();
  await copy.view.drawing.pendingSave;
  assert.equal(writes, 3);
  assert.deepEqual(normalize(codec.parse(contents.get(file))), []);

  first.canvas.pointerdown(point(50, 60));
  first.canvas.pointerup(point(50, 60));
  contents.set(file, codec.serialize([[[70, 80]]]));
  vault.emit("modify", file);
  await first.view.drawing.pendingSave;
  assert.deepEqual(normalize(codec.parse(contents.get(file))), [[[70, 80]], [[50, 60]]]);

  assert.match((await render("BetterDraw/missing.svg")).root.text, /missing/);
  assert.match((await render("../outside.svg")).root.text, /vault-relative/);
  await vault.create("BetterDraw/broken.svg", "<svg><path>");
  assert.match((await render("BetterDraw/broken.svg")).root.text, /could not read/);
  assert.ok([...files.keys()].every((name) => !name.endsWith("data.json")));
});

const { Plugin, MarkdownRenderChild, Notice, TFile, TFolder } = require("obsidian");

const FOLDER = "BetterDraw";
const EMBED = ".internal-embed.image-embed[src]";
const WIDTH = 800;
const HEIGHT = 400;
const INK = "#527ab8";
const SVG_START = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" width="${WIDTH}" height="${HEIGHT}">
  <g fill="none" stroke="${INK}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">`;
const SVG_END = "  </g>\n</svg>";

function serialize(strokes) {
  const paths = strokes.map((points) => {
    // A zero-length round-capped segment renders a single tap as a dot.
    const vertices = points.length === 1 ? [points[0], points[0]] : points;
    const path = vertices.map(([x, y], i) => `${i ? "L" : "M"} ${x} ${y}`).join(" ");
    const dot = points.length === 1 ? ' data-dot="true"' : "";
    return `    <path d="${path}"${dot}/>\n`;
  }).join("");
  return `${SVG_START}\n${paths}${SVG_END}\n`;
}

function parse(svg) {
  const text = svg.trim().replace(/\r\n/g, "\n");
  const start = SVG_START + "\n";
  if (!text.startsWith(start) || !text.endsWith(SVG_END)) {
    throw new Error("Unsupported drawing SVG");
  }

  // Accept only the editable subset we write, so saving cannot discard
  // unsupported SVG elements, attributes, or path commands.
  const paths = text.slice(start.length, -SVG_END.length);
  if (!paths) return [];
  return paths.trimEnd().split("\n").map((line) => {
    const match = /^    <path d="M (-?\d+ -?\d+(?: L -?\d+ -?\d+)+)"( data-dot="true")?\/>$/.exec(line);
    if (!match) throw new Error("Invalid drawing path");
    const points = match[1].split(" L ").map((pair) => pair.split(" ").map(Number));
    if (!points.every((point) => point.every(Number.isSafeInteger))) {
      throw new Error("Invalid drawing coordinates");
    }
    const [first, second] = points;
    if (match[2]) {
      if (points.length !== 2 || first[0] !== second[0] || first[1] !== second[1]) {
        throw new Error("Invalid drawing dot");
      }
      return [first];
    }
    return points;
  });
}

function isDrawingPath(path) {
  return /\.svg$/i.test(path) && !/[\\:\[\]\x00-\x1f]/.test(path) &&
    path.split("/").every((part) => part && part !== "." && part !== "..");
}

module.exports = class BetterDraw extends Plugin {
  onload() {
    this.drawings = new WeakMap();
    this.app.workspace.onLayoutReady(() => this.watchEmbeds(document));
    this.registerEvent(this.app.workspace.on("window-open", (_, win) => this.watchEmbeds(win.document)));
    this.registerEvent(this.app.vault.on("modify", (file) => this.refreshDrawing(file)));
    this.addCommand({
      id: "insert-drawing",
      name: "Insert drawing",
      editorCallback: (editor, view) => this.insertDrawing(editor, view),
    });

    this.registerMarkdownCodeBlockProcessor("betterdraw", async (source, element, context) => {
      const path = source.trim();
      if (!isDrawingPath(path)) {
        element.setText("BetterDraw needs a vault-relative SVG path.");
        return;
      }

      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) {
        element.setText("BetterDraw SVG is missing.");
        return;
      }

      try {
        const drawing = await this.openDrawing(file);
        context.addChild(new DrawingView(element, this, drawing));
      } catch {
        element.setText("BetterDraw could not read this SVG.");
      }
    });
  }

  watchEmbeds(doc) {
    const mounts = new Map();
    const remove = (host, mount) => {
      mounts.delete(host);
      mount.view?.unload();
      mount.root?.remove();
      host.classList.remove("betterdraw-embed");
    };
    const scan = (node) => {
      if (node.nodeType !== 1) return;
      const attach = (host) => {
        if (mounts.has(host) || host.querySelector('img[alt="BetterDraw fallback"]')) return;
        const path = host.getAttribute("src");
        if (!path.startsWith(FOLDER + "/") || !isDrawingPath(path)) return;
        const mount = { path };
        mounts.set(host, mount);
        this.mountEmbed(host, mount, () => mounts.get(host) === mount);
      };
      if (node.matches(EMBED)) attach(node);
      node.querySelectorAll(EMBED).forEach(attach);
    };
    const observer = new doc.defaultView.MutationObserver((changes) => {
      for (const [host, mount] of mounts) {
        if (!host.isConnected || host.getAttribute("src") !== mount.path ||
            (mount.root && mount.root.parentNode !== host)) remove(host, mount);
      }
      for (const change of changes) {
        if (change.target.nodeType === 1 && change.target.matches(EMBED)) scan(change.target);
        for (const node of change.addedNodes) scan(node);
      }
    });
    observer.observe(doc.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["src"] });
    const stop = () => {
      observer.disconnect();
      for (const [host, mount] of mounts) remove(host, mount);
    };
    this.register(stop);
    doc.defaultView.addEventListener("pagehide", stop, { once: true });
    this.register(() => doc.defaultView?.removeEventListener("pagehide", stop));
    scan(doc.body);
  }

  async mountEmbed(host, mount, isCurrent) {
    const file = this.app.vault.getAbstractFileByPath(mount.path);
    if (!(file instanceof TFile)) return;
    let drawing;
    try {
      drawing = await this.openDrawing(file);
    } catch {
      // Other SVGs retain their native image rendering.
      return;
    }
    if (!isCurrent() || !host.isConnected || host.getAttribute("src") !== mount.path) return;
    mount.root = host.createDiv({ cls: "betterdraw-embed-editor" });
    mount.view = new DrawingView(mount.root, this, drawing);
    mount.view.load();
    host.classList.add("betterdraw-embed");
  }

  async insertDrawing(editor, view) {
    const vault = this.app.vault;
    const note = view.file;
    try {
      if (!vault.getAbstractFileByPath(FOLDER)) {
        try {
          await vault.createFolder(FOLDER);
        } catch (error) {
          if (!(vault.getAbstractFileByPath(FOLDER) instanceof TFolder)) throw error;
        }
      }
      if (!(vault.getAbstractFileByPath(FOLDER) instanceof TFolder)) {
        throw new Error("Drawing folder is unavailable");
      }

      let path;
      do {
        const bytes = window.crypto.getRandomValues(new Uint8Array(16));
        const id = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
        path = `${FOLDER}/${id}.svg`;
      } while (vault.getAbstractFileByPath(path));
      await vault.create(path, serialize([]));

      if (view.file !== note) {
        new Notice(`BetterDraw created ${path}. The original note is no longer open.`);
        return;
      }
      const cursor = editor.getCursor("to");
      const end = { line: cursor.line, ch: editor.getLine(cursor.line).length };
      editor.replaceRange(`\n\n![[${path}]]\n\n`, end);
      editor.setCursor(end.line + 4, 0);
    } catch {
      new Notice("BetterDraw could not create a drawing.");
    }
  }

  openDrawing(file) {
    if (!this.drawings.has(file)) {
      const opening = this.app.vault.read(file).then((svg) => ({
        file, svg, strokes: parse(svg), edits: [], pendingSave: Promise.resolve(),
      })).catch((error) => {
        this.drawings.delete(file);
        throw error;
      });
      this.drawings.set(file, opening);
    }
    return this.drawings.get(file);
  }

  async refreshDrawing(file) {
    const opening = this.drawings.get(file);
    if (!opening) return;
    const drawing = await opening.catch(() => null);
    if (!drawing) return;
    drawing.pendingSave = drawing.pendingSave.then(async () => {
      try {
        if (drawing.edits.length) return;
        const svg = await this.app.vault.read(file);
        if (drawing.edits.length || svg === drawing.svg) return;
        drawing.strokes = parse(svg);
        drawing.svg = svg;
        this.app.workspace.trigger("betterdraw:changed", drawing);
      } catch {
        new Notice("BetterDraw could not reload this SVG.");
      }
    });
  }


  saveDrawing(drawing) {
    drawing.pendingSave = drawing.pendingSave.then(async () => {
      const edits = drawing.edits.slice();
      if (!edits.length) return;
      const vault = this.app.vault;
      try {
        const svg = await vault.process(drawing.file, (current) => {
          const strokes = parse(current);
          for (const edit of edits) edit(strokes);
          return serialize(strokes);
        });
        drawing.svg = svg;
        drawing.edits.splice(0, edits.length);
        drawing.strokes = parse(svg);
        for (const edit of drawing.edits) edit(drawing.strokes);
        this.app.workspace.trigger("betterdraw:changed", drawing);
      } catch {
        new Notice("BetterDraw could not save this SVG. The next edit will retry.");
      }
    });
    return drawing.pendingSave;
  }
};

class DrawingView extends MarkdownRenderChild {
  constructor(element, plugin, drawing) {
    super(element);
    this.plugin = plugin;
    this.drawing = drawing;
  }

  onload() {
    const root = this.containerEl;
    root.addClass("betterdraw");
    const toolbar = root.createDiv({ cls: "betterdraw-toolbar" });
    const canvas = root.createEl("canvas", {
      attr: { width: WIDTH, height: HEIGHT, "aria-label": "Freehand drawing" },
    });
    const ctx = canvas.getContext("2d");
    let pointer = null;
    let draft = null;

    const strokes = () => this.drawing.strokes;
    const paint = () => {
      ctx.clearRect(0, 0, WIDTH, HEIGHT);
      const color = INK;
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = 3;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      for (const points of draft ? [...strokes(), draft] : strokes()) {
        const [x, y] = points[0];
        ctx.beginPath();
        if (points.length === 1) {
          ctx.arc(x, y, 1.5, 0, Math.PI * 2);
          ctx.fill();
          continue;
        }
        ctx.moveTo(x, y);
        for (const [px, py] of points.slice(1)) ctx.lineTo(px, py);
        ctx.stroke();
      }
    };

    const update = (edit) => {
      edit(this.drawing.strokes);
      this.drawing.edits.push(edit);
      this.plugin.app.workspace.trigger("betterdraw:changed", this.drawing);
      this.plugin.saveDrawing(this.drawing);
    };
    const button = (label, action) => {
      const el = toolbar.createEl("button", { text: label, attr: { type: "button" } });
      this.registerDomEvent(el, "click", action);
    };
    button("Undo stroke", () => {
      const prefix = serialize(strokes());
      const count = strokes().length;
      if (!count) return;
      update((current) => {
        if (serialize(current.slice(0, count)) === prefix) current.splice(count - 1, 1);
      });
    });

    const point = (event) => {
      const rect = canvas.getBoundingClientRect();
      return [
        Math.round((event.clientX - rect.left) * WIDTH / rect.width),
        Math.round((event.clientY - rect.top) * HEIGHT / rect.height),
      ];
    };

    this.registerDomEvent(canvas, "pointerdown", (event) => {
      if (pointer !== null || event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      canvas.setPointerCapture(event.pointerId);
      pointer = event.pointerId;
      draft = [point(event)];
      paint();
    });
    this.registerDomEvent(canvas, "pointermove", (event) => {
      if (event.pointerId !== pointer) return;
      draft.push(point(event));
      paint();
    });
    this.registerDomEvent(canvas, "pointerup", (event) => {
      if (event.pointerId !== pointer) return;
      const end = point(event);
      const last = draft[draft.length - 1];
      if (end[0] !== last[0] || end[1] !== last[1]) draft.push(end);
      const completed = draft;
      draft = null;
      pointer = null;
      update((current) => current.push(completed));
    });
    const cancel = (event) => {
      if (event.pointerId !== pointer) return;
      draft = null;
      pointer = null;
      paint();
    };
    this.registerDomEvent(canvas, "pointercancel", cancel);
    this.registerDomEvent(canvas, "lostpointercapture", cancel);
    this.registerEvent(this.plugin.app.workspace.on("betterdraw:changed", (drawing) => {
      if (drawing === this.drawing) paint();
    }));
    paint();
  }
}

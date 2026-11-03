const { Plugin, MarkdownRenderChild, Notice } = require("obsidian");

const WIDTH = 800;
const HEIGHT = 400;
const ID = /^[0-9a-f]{32}$/;

module.exports = class BetterDraw extends Plugin {
  async onload() {
    this.drawings = (await this.loadData()) ?? {};
    this.pendingSave = Promise.resolve();
    this.addCommand({
      id: "insert-drawing",
      name: "Insert drawing",
      editorCallback: (editor) => {
        const bytes = window.crypto.getRandomValues(new Uint8Array(16));
        const id = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
        const cursor = editor.getCursor("to");
        const end = { line: cursor.line, ch: editor.getLine(cursor.line).length };
        editor.replaceRange("\n\n```betterdraw\n" + id + "\n```\n\n", end);
        editor.setCursor(end.line + 6, 0);
      },
    });

    this.registerMarkdownCodeBlockProcessor("betterdraw", (source, element, context) => {
      const id = source.trim();
      if (!ID.test(id)) {
        element.setText("Use the BetterDraw: Insert drawing command to create a drawing.");
        return;
      }
      context.addChild(new DrawingView(element, this, id));
    });
  }

  saveDrawing(id, strokes) {
    this.drawings[id] = strokes;
    this.pendingSave = this.pendingSave
      .then(() => this.saveData(this.drawings))
      .catch(() => new Notice("BetterDraw could not save. Use Save to retry."));
  }
};

class DrawingView extends MarkdownRenderChild {
  constructor(element, plugin, id) {
    super(element);
    this.plugin = plugin;
    this.id = id;
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

    const strokes = () => this.plugin.drawings[this.id] ?? [];
    const paint = () => {
      ctx.clearRect(0, 0, WIDTH, HEIGHT);
      const color = canvas.ownerDocument.defaultView.getComputedStyle(canvas).color;
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

    const update = (next) => {
      this.plugin.saveDrawing(this.id, next);
      this.plugin.app.workspace.trigger("betterdraw:changed", this.id);
    };
    const button = (label, action) => {
      const el = toolbar.createEl("button", { text: label, attr: { type: "button" } });
      this.registerDomEvent(el, "click", action);
    };
    button("Undo stroke", () => {
      if (strokes().length) update(strokes().slice(0, -1));
    });
    button("Save", () => this.plugin.saveDrawing(this.id, strokes()));

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
      const next = [...strokes(), draft];
      draft = null;
      pointer = null;
      update(next);
    });
    this.registerDomEvent(canvas, "lostpointercapture", (event) => {
      if (event.pointerId !== pointer) return;
      draft = null;
      pointer = null;
      paint();
    });
    this.registerEvent(this.plugin.app.workspace.on("betterdraw:changed", (id) => {
      if (id === this.id) paint();
    }));
    this.registerEvent(this.plugin.app.workspace.on("css-change", paint));
    paint();
  }
}

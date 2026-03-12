import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { createStore, produce } from "solid-js/store";
const compilerWasmUrl =
  "https://cdn.jsdelivr.net/npm/@myriaddreamin/typst-ts-web-compiler@0.7.0-rc2/pkg/typst_ts_web_compiler_bg.wasm";
import { setImportWasmModule as setCompilerImporter } from "@myriaddreamin/typst-ts-web-compiler/pkg/typst_ts_web_compiler.mjs";
import { $typst } from "@myriaddreamin/typst.ts";

import { v7 as uuid } from "uuid";
import { exportJSON, importJSON } from "../utils/importExport";

// ─── Types ───────────────────────────────────────────────────────────────────
/** A snippet definition stored in the left panel */
type Block = { id: string; title: string; content: string };

/** A plain-text typst node in the editor */
type TextNode = { id: string; type: "text"; content: string };

/** A snippet instance placed in the editor, with variable values filled in */
type SnippetNode = {
  id: string;
  type: "snippet";
  title: string;
  template: string;
  vars: Record<string, string>;
  blockId?: string;
};

type EditorNode = TextNode | SnippetNode;

// ─── Helpers ─────────────────────────────────────────────────────────────────
const LS_KEYS = {
  blocks: "typst.blocks",
  nodes: "typst.nodes",
  sizes: "typst.sizes",
};

/** Extract unique variable names from a template string */
function parseVarNames(template: string): string[] {
  const matches = [...template.matchAll(/\{\{(\w+)\}\}/g)];
  return [...new Set(matches.map((m) => m[1]))];
}

/** Render an editor node to its final typst string */
function renderNode(node: EditorNode): string {
  if (node.type === "text") return node.content;
  let out = node.template;
  for (const [k, v] of Object.entries(node.vars)) {
    out = out.replaceAll(`{{${k}}}`, v);
  }
  return out;
}

/** Create a fresh snippet node from a Block definition */
function blockToNode(b: Block): SnippetNode {
  const varNames = parseVarNames(b.content);
  return {
    id: uuid(),
    type: "snippet",
    title: b.title,
    template: b.content,
    vars: Object.fromEntries(varNames.map((n) => [n, ""])),
    blockId: b.id,
  };
}

export default function Home() {
  const [blocks, setBlocks] = createStore<Block[]>([]);
  const [nodes, setNodes] = createStore<EditorNode[]>([]);
  const [sizes, setSizes] = createSignal({ left: 25, middle: 45, right: 30 });
  const [isDraggingPanel, setIsDraggingPanel] = createSignal(false);
  const [pdfUrl, setPdfUrl] = createSignal("");
  // Double-buffer so the old PDF stays visible while the new one loads (no flash)
  const [activeSlot, setActiveSlot] = createSignal<0 | 1>(0);
  const [slotUrls, setSlotUrls] = createSignal<[string, string]>(["", ""]);
  const [dropIndex, setDropIndex] = createSignal<number | null>(null);
  const [draggingNodeId, setDraggingNodeId] = createSignal("");
  const [blockDropIndex, setBlockDropIndex] = createSignal<number | null>(null);
  const [draggingBlockId, setDraggingBlockId] = createSignal("");
  const blockTitleRefs: Record<string, HTMLInputElement | undefined> = {};

  // ── Simple undo/redo history ─────────────────────────────────────────────
  const MAX_HISTORY = 200;
  const [history, setHistory] = createSignal<
    Array<{
      blocks: Block[];
      nodes: EditorNode[];
      sizes: { left: number; middle: number; right: number };
    }>
  >([]);
  const [historyIndex, setHistoryIndex] = createSignal(-1);
  let historyDebounceTimer: ReturnType<typeof setTimeout> | undefined;

  function snapshotState() {
    return {
      blocks: structuredClone(blocks),
      nodes: structuredClone(nodes),
      sizes: structuredClone(sizes()),
    };
  }

  function pushSnapshotImmediate() {
    const snap = snapshotState();
    // truncate any "future" history if we've undone some actions
    const truncated =
      historyIndex() < history().length - 1 ? history().slice(0, historyIndex() + 1) : history();
    const next = [...truncated, snap].slice(-MAX_HISTORY);
    setHistory(next);
    setHistoryIndex(next.length - 1);
  }

  function pushSnapshotDebounced(ms = 600) {
    clearTimeout(historyDebounceTimer);
    historyDebounceTimer = setTimeout(() => pushSnapshotImmediate(), ms);
  }

  function restoreSnapshotAt(idx: number) {
    const s = history()[idx];
    if (!s) return;
    // Replace stores with snapshot content
    setBlocks(s.blocks);
    setNodes(s.nodes);
    setSizes(s.sizes);
    setHistoryIndex(idx);
  }

  function undo() {
    if (historyIndex() > 0) restoreSnapshotAt(historyIndex() - 1);
  }

  function redo() {
    if (historyIndex() < history().length - 1) {
      restoreSnapshotAt(historyIndex() + 1);
    }
  }

  // ── LocalStorage ────────────────────────────────────────────────────────────
  onMount(() => {
    try {
      const b = localStorage.getItem(LS_KEYS.blocks);
      if (b) {
        const parsed = JSON.parse(b) as Block[];
        parsed.sort((x, y) => x.id.localeCompare(y.id));
        setBlocks(parsed);
      }
      const nd = localStorage.getItem(LS_KEYS.nodes);
      if (nd) setNodes(JSON.parse(nd));
      const s = localStorage.getItem(LS_KEYS.sizes);
      if (s) setSizes(JSON.parse(s));
      try {
        setCompilerImporter(async () => {
          const res = await fetch(compilerWasmUrl);
          return await res.arrayBuffer();
        });
        $typst.setCompilerInitOptions?.({ getModule: () => compilerWasmUrl });
      } catch (e) {
        console.warn("Failed to init Typst compiler:", e);
      }
      // push initial snapshot after restoring from localStorage
      pushSnapshotImmediate();

      // keyboard shortcuts: Ctrl/Cmd+Z = undo, Ctrl/Cmd+Y or Ctrl/Cmd+Shift+Z = redo
      const onKeyDown = (e: KeyboardEvent) => {
        const meta = e.ctrlKey || e.metaKey;
        if (!meta) return;
        const k = e.key.toLowerCase();
        if (k === "z" && !e.shiftKey) {
          e.preventDefault();
          undo();
        } else if (k === "y" || (k === "z" && e.shiftKey)) {
          e.preventDefault();
          redo();
        }
      };
      globalThis.addEventListener("keydown", onKeyDown);
      onCleanup(() => globalThis.removeEventListener("keydown", onKeyDown));
    } catch (e) {
      console.warn(e);
    }
  });

  createEffect(() => localStorage.setItem(LS_KEYS.blocks, JSON.stringify(blocks)));
  createEffect(() => localStorage.setItem(LS_KEYS.nodes, JSON.stringify(nodes)));
  createEffect(() => localStorage.setItem(LS_KEYS.sizes, JSON.stringify(sizes())));

  // ── PDF render ──────────────────────────────────────────────────────────────
  let renderSeq = 0;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => {
    slotUrls().forEach((url) => url && URL.revokeObjectURL(url));
    clearTimeout(debounceTimer);
    clearTimeout(historyDebounceTimer);
  });

  createEffect(() => {
    const text = nodes.map(renderNode).join("\n\n").trim();
    clearTimeout(debounceTimer);
    if (!text) return;
    debounceTimer = setTimeout(async () => {
      const seq = ++renderSeq;
      try {
        const pdf = await $typst.pdf({ mainContent: text });
        if (seq !== renderSeq) return;
        const newUrl = URL.createObjectURL(
          new Blob([pdf as BlobPart], { type: "application/pdf" }),
        );
        setPdfUrl(newUrl);
        setSlotUrls((prev) => {
          const next: [string, string] = [prev[0], prev[1]];
          const targetSlot = activeSlot() === 0 ? 1 : 0;
          if (prev[targetSlot]) URL.revokeObjectURL(prev[targetSlot]);
          next[targetSlot] = newUrl;
          return next;
        });
      } catch (err) {
        console.error("Typst PDF render failed:", err);
      }
    }, 600);
  });

  // ── Snippet (left panel) management ─────────────────────────────────────────
  function addBlock() {
    const id = uuid();
    setBlocks(produce((s) => s.push({ id, title: "Untitled", content: "" })));
    // schedule focusing the new block's title input
    setTimeout(() => {
      const el = blockTitleRefs[id];
      if (el) {
        el.focus();
        el.select();
      }
    }, 0);
    pushSnapshotImmediate();
  }

  function updateBlock(id: string, patch: Partial<Block>) {
    const idx = blocks.findIndex((x) => x.id === id);
    if (idx < 0) return;
    // determine new content (if any) so we can sync nodes referencing this block
    const newContent = patch.content ?? blocks[idx].content;
    setBlocks(idx, patch);
    // sync any nodes that reference this block: update template and preserve existing var values
    const varNames = parseVarNames(newContent);
    setNodes(
      produce((s) => {
        for (const element of s) {
          const n = element;
          if (n.type === "snippet" && n.blockId === id) {
            const existing = n.vars || {};
            n.template = newContent;
            n.vars = Object.fromEntries(varNames.map((vn) => [vn, existing[vn] ?? ""]));
          }
        }
      }),
    );
    pushSnapshotDebounced();
  }

  function removeBlock(id: string) {
    setBlocks(
      produce((s) => {
        const i = s.findIndex((x) => x.id === id);
        if (i >= 0) s.splice(i, 1);
      }),
    );
    pushSnapshotImmediate();
  }

  // ── Editor node management ───────────────────────────────────────────────────
  function addTextNode() {
    setNodes(produce((s) => s.push({ id: uuid(), type: "text" as const, content: "" })));
    pushSnapshotImmediate();
  }

  function updateTextNode(id: string, content: string) {
    const idx = nodes.findIndex((n) => n.id === id);
    if (idx >= 0) {
      setNodes(
        produce((s) => {
          const n = s[idx];
          if (n.type === "text") n.content = content;
        }),
      );
    }
    pushSnapshotDebounced();
  }

  function updateSnippetVar(nodeId: string, varName: string, value: string) {
    const idx = nodes.findIndex((n) => n.id === nodeId);
    if (idx >= 0) {
      setNodes(
        produce((s) => {
          const n = s[idx];
          if (n.type === "snippet") n.vars[varName] = value;
        }),
      );
    }
    pushSnapshotDebounced();
  }

  // Bake a single variable value into the snippet template
  function applyVar(nodeId: string, varName: string) {
    const idx = nodes.findIndex((n) => n.id === nodeId);
    if (idx < 0) return;
    const n = nodes[idx];
    if (n.type !== "snippet") return;
    const val = n.vars[varName] ?? "";
    // If this node came from a saved block, update the block so all nodes sync
    if (n.blockId) {
      const bidx = blocks.findIndex((b) => b.id === n.blockId);
      if (bidx >= 0) {
        const block = blocks[bidx];
        const newContent = block.content.replaceAll(`{{${varName}}}`, val);
        // update block content
        setBlocks(bidx, { content: newContent });
        // sync nodes referencing this block
        const varNames = parseVarNames(newContent);
        setNodes(
          produce((s) => {
            for (const element of s) {
              const nn = element;
              if (nn.type === "snippet" && nn.blockId === n.blockId) {
                const existing = nn.vars || {};
                nn.template = newContent;
                nn.vars = Object.fromEntries(varNames.map((vn) => [vn, existing[vn] ?? ""]));
              }
            }
          }),
        );
        pushSnapshotImmediate();
        return;
      }
    }

    // fallback: bake into this node only
    const newTemplate = n.template.replaceAll(`{{${varName}}}`, val);
    setNodes(
      produce((s) => {
        const nn = s[idx];
        if (nn.type === "snippet") {
          nn.template = newTemplate;
          delete nn.vars[varName];
        }
      }),
    );
    pushSnapshotImmediate();
  }

  function removeNode(id: string) {
    setNodes(
      produce((s) => {
        const i = s.findIndex((n) => n.id === id);
        if (i >= 0) s.splice(i, 1);
      }),
    );
    pushSnapshotImmediate();
  }

  // Snippet cross-panel HTML5 drag has been disabled — use the Insert button.

  // ── Drag: reorder nodes within editor  ────
  let editorListRef: HTMLDivElement | undefined;
  let blockListRef: HTMLDivElement | undefined;

  function startNodeDrag(e: PointerEvent, nodeId: string) {
    e.preventDefault();
    setDraggingNodeId(nodeId);

    const getInsertIdx = (clientY: number) => {
      if (!editorListRef) return nodes.length;
      const wraps = editorListRef.querySelectorAll<HTMLElement>("[data-node-wrap]");
      for (let i = 0; i < wraps.length; i++) {
        const r = wraps[i].getBoundingClientRect();
        if (clientY < r.top + r.height / 2) return i;
      }
      return wraps.length;
    };

    setDropIndex(getInsertIdx(e.clientY));

    const onMove = (ev: PointerEvent) => setDropIndex(getInsertIdx(ev.clientY));

    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      const srcIdx = nodes.findIndex((n) => n.id === nodeId);
      const target = dropIndex();
      setDraggingNodeId("");
      setDropIndex(null);
      if (srcIdx === -1 || target === null) return;
      const insertAt = srcIdx < target ? target - 1 : target;
      if (insertAt !== srcIdx) {
        setNodes(
          produce((s) => {
            const [m] = s.splice(srcIdx, 1);
            s.splice(insertAt, 0, m);
          }),
        );
        pushSnapshotImmediate();
      }
    };

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  }

  function startBlockDrag(e: PointerEvent, blockId: string) {
    // don't prevent native mouse dragstart — only prevent for touch/pen so
    // pointer-based reordering still works on touch devices
    if (e.pointerType !== "mouse") e.preventDefault();
    setDraggingBlockId(blockId);

    const getInsertIdx = (clientY: number) => {
      if (!blockListRef) return blocks.length;
      const wraps = blockListRef.querySelectorAll<HTMLElement>("[data-block-wrap]");
      for (let i = 0; i < wraps.length; i++) {
        const r = wraps[i].getBoundingClientRect();
        if (clientY < r.top + r.height / 2) return i;
      }
      return wraps.length;
    };

    setBlockDropIndex(getInsertIdx(e.clientY));

    const onMove = (ev: PointerEvent) => setBlockDropIndex(getInsertIdx(ev.clientY));

    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      const id = blockId;
      const target = blockDropIndex();
      setDraggingBlockId("");
      setBlockDropIndex(null);
      const srcIdx = blocks.findIndex((b) => b.id === id);
      if (srcIdx === -1 || target === null) return;
      const insertAt = srcIdx < target ? target - 1 : target;
      if (insertAt !== srcIdx) {
        setBlocks(
          produce((s) => {
            const [m] = s.splice(srcIdx, 1);
            s.splice(insertAt, 0, m);
          }),
        );
        pushSnapshotImmediate();
      }
    };

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  }

  // Snippet list reorder handlers \
  function onBlockListDragOver(e: DragEvent) {
    e.preventDefault();
    if (!blockListRef) return;
    const wraps = blockListRef.querySelectorAll<HTMLElement>("[data-block-wrap]");
    let idx = wraps.length;
    for (let i = 0; i < wraps.length; i++) {
      const r = wraps[i].getBoundingClientRect();
      if (e.clientY < r.top + r.height / 2) {
        idx = i;
        break;
      }
    }
    setBlockDropIndex(idx);
  }

  function onBlockListDrop(e: DragEvent) {
    e.preventDefault();
    const raw = e.dataTransfer?.getData("application/typst");
    // prefer using our local draggingBlockId if present
    const id =
      draggingBlockId() ||
      (raw
        ? (() => {
            try {
              return JSON.parse(raw).id as string;
            } catch {
              return undefined;
            }
          })()
        : undefined);
    if (!id) {
      setBlockDropIndex(null);
      setDraggingBlockId("");
      return;
    }
    const target = blockDropIndex() ?? blocks.length;
    const srcIdx = blocks.findIndex((x) => x.id === id);
    setDraggingBlockId("");
    setBlockDropIndex(null);
    if (srcIdx === -1) return;
    const insertAt = srcIdx < target ? target - 1 : target;
    if (insertAt !== srcIdx) {
      setBlocks(
        produce((s) => {
          const [m] = s.splice(srcIdx, 1);
          s.splice(insertAt, 0, m);
        }),
      );
      pushSnapshotImmediate();
    }
  }

  // ── Panel resizing ───────────────────────────────────────────────────────────
  let rootEl: HTMLDivElement | undefined;

  function startPanelDrag(which: "left" | "right", e: MouseEvent) {
    e.preventDefault();
    setIsDraggingPanel(true);
    const MIN = 10;
    const onMove = (ev: MouseEvent) => {
      // If the mouse button was released outside the window, stop dragging.
      if (ev.buttons === 0) {
        onUp();
        return;
      }
      if (!rootEl) return;
      const rect = rootEl.getBoundingClientRect();
      const total = rect.width;
      if (which === "left") {
        const right = sizes().right;
        const rawLeft = ((ev.clientX - rect.left) / total) * 100;
        const left = Math.min(100 - MIN - right, Math.max(MIN, rawLeft));
        setSizes({ left, middle: 100 - left - right, right });
      } else {
        const left = sizes().left;
        const rawRight = ((rect.right - ev.clientX) / total) * 100;
        const right = Math.min(100 - MIN - left, Math.max(MIN, rawRight));
        setSizes({ left, middle: 100 - left - right, right });
      }
    };
    const onUp = () => {
      setIsDraggingPanel(false);
      globalThis.removeEventListener("mousemove", onMove);
      globalThis.removeEventListener("mouseup", onUp);
      pushSnapshotImmediate();
    };
    globalThis.addEventListener("mousemove", onMove);
    globalThis.addEventListener("mouseup", onUp);
  }

  // ── Styles ───────────────────────────────────────────────────────────────────

  // --- Import / Export handlers
  let fileInputRef: HTMLInputElement | undefined;

  async function handleImportFile(file: File) {
    try {
      const data = await importJSON(file);
      if (!data) throw new Error("No data in file");
      if (Array.isArray(data.blocks)) setBlocks(data.blocks);
      if (Array.isArray(data.nodes)) setNodes(data.nodes);
      if (data.sizes) setSizes(data.sizes);
      pushSnapshotImmediate();
    } catch (err: any) {
      console.error("Import failed:", err);
      try {
        alert("Import failed: " + (err?.message ?? String(err)));
      } catch {}
    }
  }

  function triggerImport() {
    fileInputRef?.click();
  }

  function handleExport() {
    const payload = {
      blocks: structuredClone(blocks),
      nodes: structuredClone(nodes),
      sizes: structuredClone(sizes()),
    };
    exportJSON("applyst-export.json", payload);
  }

  return (
    <div ref={rootEl} class="font-sans h-screen flex flex-col overflow-hidden bg-[#0f172a]">
      {/* Transparent overlay to capture mouse events over iframes during panel drag */}
      <Show when={isDraggingPanel()}>
        <div
          style={{
            position: "fixed",
            inset: "0",
            "z-index": "9999",
            cursor: "col-resize",
          }}
        />
      </Show>
      {/* ── Header ── */}
      <header class="h-12 bg-[#1e293b] border-b border-[#334155] flex items-center px-5 gap-2.5 shrink-0">
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
          <rect x="2" y="2" width="14" height="14" rx="3" stroke="#3b82f6" stroke-width="1.5" />
          <path
            d="M5 6h8M5 9h6M5 12h4"
            stroke="#3b82f6"
            stroke-width="1.5"
            stroke-linecap="round"
          />
        </svg>
        <span class="text-[15px] font-bold text-[#f1f5f9] tracking-tight">Applyst</span>
        <span class="text-[11px] text-[#475569] ml-0.5">· runs on Typst</span>
        <div class="ml-auto flex items-center gap-2">
          <button
            onClick={triggerImport}
            class="px-2 py-1 rounded-md bg-transparent text-[#94a3b8] border border-[#33415533] text-[12px] cursor-pointer hover:bg-[#33415510] disabled:opacity-40 flex items-center gap-2"
            title="Import JSON"
          >
            <i class="i-mdi:import text-[16px]" aria-hidden="true" />
          </button>
          <button
            onClick={handleExport}
            class="px-2 py-1 rounded-md bg-transparent text-[#94a3b8] border border-[#33415533] text-[12px] cursor-pointer hover:bg-[#33415510] disabled:opacity-40 flex items-center gap-2"
            title="Export JSON"
          >
            <i class="i-mdi:export text-[16px]" aria-hidden="true" />
          </button>
          {/* hidden file input for import */}
          <input
            ref={(el) => (fileInputRef = el)}
            type="file"
            accept="application/json"
            onChange={(e) => {
              const f = (e.target as HTMLInputElement).files?.[0];
              if (f) handleImportFile(f);
              (e.target as HTMLInputElement).value = "";
            }}
            style={{ display: "none" }}
          />
          <button
            onClick={undo}
            disabled={historyIndex() <= 0}
            class="px-2 py-1 rounded-md bg-transparent text-[#94a3b8] border border-[#33415533] text-[12px] cursor-pointer hover:bg-[#33415510] disabled:opacity-40 flex items-center gap-2"
            title="Undo (Ctrl/Cmd+Z)"
          >
            <i class="i-mdi:undo text-[16px]" aria-hidden="true" />
          </button>

          <button
            onClick={redo}
            disabled={historyIndex() >= history().length - 1}
            class="px-2 py-1 rounded-md bg-transparent text-[#94a3b8] border border-[#33415533] text-[12px] cursor-pointer hover:bg-[#33415510] disabled:opacity-40 flex items-center gap-2"
            title="Redo (Ctrl/Cmd+Y / Ctrl/Cmd+Shift+Z)"
          >
            <i class="i-mdi:redo text-[16px]" aria-hidden="true" />
          </button>
          <div class="text-[11px] text-[#475569] ml-2">
            {Math.max(0, historyIndex() + 1)}/{history().length}
          </div>
        </div>
      </header>

      {/* ── Three-panel row ── */}
      <div class="flex flex-1 overflow-hidden">
        {/* ═══ Left: Snippet Library ═══════════════════════════════════════════ */}
        <div
          style={{ width: `${sizes().left}%` }}
          class="flex flex-col bg-[#1a2332] border-r border-[#1e293b] overflow-hidden"
        >
          <div class="px-3.5 py-2.5 border-b border-[#1e293b] flex items-center justify-between shrink-0">
            <span class="text-[11px] font-semibold text-[#64748b] uppercase tracking-widest">
              Snippets
            </span>
            <button
              onClick={addBlock}
              class="px-3 py-1 rounded-md bg-[#3b82f6] text-white text-[12px] font-medium border-none cursor-pointer hover:bg-blue-500"
            >
              + New
            </button>
          </div>
          <div
            ref={blockListRef}
            onDragOver={onBlockListDragOver}
            onDrop={onBlockListDrop}
            onDragLeave={() => setBlockDropIndex(null)}
            class="overflow-auto flex-1 p-2.5"
          >
            <Show when={blocks.length === 0}>
              <div class="text-center py-8 px-2 text-[#334155] text-[12px]">
                No snippets — click <strong class="text-[#3b82f6]">+ New</strong> to create one.
              </div>
            </Show>
            <Show when={blockDropIndex() === 0}>
              <div class="h-0.5 bg-[#3b82f6] rounded my-0.5" />
            </Show>
            <For each={blocks}>
              {(b, i) => {
                const vars = () => parseVarNames(b.content);
                return (
                  <>
                    <div
                      data-block-wrap
                      class="mb-2 rounded-lg border border-[#1e3a5f] bg-[#1e293b] cursor-grab"
                      style={{
                        opacity: draggingBlockId() === b.id ? "0.4" : "1",
                      }}
                    >
                      <div class="pt-2.5 px-2.5 pb-1.5">
                        <div class="flex items-center gap-2">
                          <span
                            onPointerDown={(e) => startBlockDrag(e as PointerEvent, b.id)}
                            class="text-[#334155] cursor-grab select-none shrink-0 leading-none touch-none hover:text-[#64748b]"
                            title="Drag to reorder"
                          >
                            ⠿
                          </span>
                          <input
                            value={b.title}
                            onInput={(e) =>
                              updateBlock(b.id, {
                                title: (e.target as HTMLInputElement).value,
                              })
                            }
                            ref={(el) => (blockTitleRefs[b.id] = el)}
                            class="flex-1 px-2 py-1 mb-1.5 border border-[#334155] rounded bg-[#0f172a] text-[#e2e8f0] text-[13px] font-semibold outline-none box-border"
                            placeholder="Snippet title"
                          />
                        </div>
                        <textarea
                          value={b.content}
                          onInput={(e) =>
                            updateBlock(b.id, {
                              content: (e.target as HTMLTextAreaElement).value,
                            })
                          }
                          rows={4}
                          class="w-full px-2 py-1 border border-[#334155] rounded bg-[#0f172a] text-[#94a3b8] text-[12px] font-mono resize-y outline-none box-border"
                          placeholder={"Typst content…\nUse {{varName}} for variables"}
                        />
                      </div>
                      <Show when={vars().length > 0}>
                        <div class="px-2.5 pb-1.5 flex flex-wrap gap-1">
                          <For each={vars()}>
                            {(v) => (
                              <span class="text-[10px] bg-[#0f172a] text-[#60a5fa] border border-[#1e3a5f] rounded px-1.5 py-px">
                                {`{{${v}}}`}
                              </span>
                            )}
                          </For>
                        </div>
                      </Show>
                      <div class="px-2.5 pt-1.5 pb-2 flex gap-1.5 justify-end border-t border-[#0f172a]">
                        <button
                          onClick={() => {
                            setNodes(produce((s) => s.push(blockToNode(b))));
                            pushSnapshotImmediate();
                          }}
                          class="px-2 py-0.5 rounded bg-transparent text-[#34d399] border border-[#34d39940] text-[11px] cursor-pointer hover:bg-[#34d39910]"
                        >
                          Insert
                        </button>
                        <button
                          onClick={() => removeBlock(b.id)}
                          class="px-2 py-0.5 rounded bg-transparent text-[#f87171] border border-[#f8717140] text-[11px] cursor-pointer hover:bg-[#f8717110]"
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                    <Show when={blockDropIndex() === i() + 1}>
                      <div class="h-0.5 bg-[#3b82f6] rounded my-0.5" />
                    </Show>
                  </>
                );
              }}
            </For>
          </div>
        </div>

        {/* ── Resize handle ── */}
        <button
          aria-label="Resize panels"
          class="w-[5px] shrink-0 bg-[#0a1120] border-none border-l border-r border-[#1e293b] cursor-col-resize p-0 hover:bg-[#3b82f6] transition-colors"
          onMouseDown={(e) => startPanelDrag("left", e as unknown as MouseEvent)}
        />

        {/* ═══ Middle: Editor ══════════════════════════════════════════════════ */}
        <section
          aria-label="Editor"
          style={{ width: `${sizes().middle}%` }}
          class="flex flex-col bg-[#0f172a] overflow-hidden"
        >
          <div class="px-3.5 py-2.5 border-b border-[#1e293b] flex items-center justify-between shrink-0">
            <span class="text-[11px] font-semibold text-[#64748b] uppercase tracking-widest">
              Editor
            </span>
            <div class="flex gap-1.5">
              <button
                onClick={addTextNode}
                class="px-3 py-1 rounded-md bg-[#3b82f6] text-white text-[12px] font-medium border-none cursor-pointer hover:bg-blue-500"
              >
                + Text
              </button>
              <button
                onClick={() => {
                  setNodes([]);
                  pushSnapshotImmediate();
                }}
                class="px-3 py-1 rounded-md bg-transparent text-[#f87171] border border-[#f8717140] text-[12px] cursor-pointer hover:bg-[#f8717110]"
              >
                Clear
              </button>
            </div>
          </div>
          <div ref={editorListRef} class="overflow-auto flex-1 p-2.5">
            {/* Empty state */}
            <Show when={nodes.length === 0}>
              <div class="border-2 border-dashed border-[#1e293b] rounded-xl p-12 text-center text-[#334155] text-[13px]">
                <div class="text-[28px] mb-2 opacity-35">✎</div>
                Click <strong class="text-[#3b82f6]">+ Text</strong> or use a snippet's
                <strong class="text-[#3b82f6]">Insert</strong> button to add content to the editor
              </div>
            </Show>

            {/* Drop indicator before first node */}
            <Show when={dropIndex() === 0}>
              <div class="h-0.5 bg-[#3b82f6] rounded my-0.5" />
            </Show>

            <For each={nodes}>
              {(node, i) => (
                <div data-node-wrap class="mb-2">
                  {/* The node card */}
                  <div
                    class="rounded-lg border border-[#1e293b] bg-[#1a2332] overflow-hidden transition-opacity duration-150"
                    style={{
                      opacity: draggingNodeId() === node.id ? "0.4" : "1",
                    }}
                  >
                    {/* Node header row */}
                    <div class="flex items-center gap-1.5 px-2 py-1.5 border-b border-[#0f172a]">
                      <span
                        class="text-[#334155] cursor-grab select-none shrink-0 leading-none touch-none hover:text-[#64748b]"
                        title="Drag to reorder"
                        onPointerDown={(e) => startNodeDrag(e, node.id)}
                      >
                        ⠿
                      </span>
                      <span
                        class={`text-[10px] font-bold tracking-widest uppercase flex-1 ${
                          node.type === "snippet" ? "text-[#60a5fa]" : "text-[#94a3b8]"
                        }`}
                      >
                        {node.type === "snippet" ? node.title : "Text"}
                      </span>
                      <button
                        onClick={() => removeNode(node.id)}
                        class="px-1.5 py-px rounded bg-transparent text-[#64748b] border border-[#33415599] text-[12px] cursor-pointer hover:text-[#f87171] hover:border-[#f8717140]"
                        title="Remove"
                      >
                        ✕
                      </button>
                    </div>

                    {/* Text node: plain textarea */}
                    <Show when={node.type === "text"}>
                      <textarea
                        value={(node as TextNode).content}
                        onInput={(e) =>
                          updateTextNode(node.id, (e.target as HTMLTextAreaElement).value)
                        }
                        rows={4}
                        placeholder="Write Typst content…"
                        class="w-full px-2.5 py-2 border-none bg-transparent text-[#94a3b8] text-[12px] font-mono resize-y outline-none box-border"
                      />
                    </Show>

                    {/* Snippet node: variable inputs */}
                    <Show when={node.type === "snippet"}>
                      {() => {
                        const vars = parseVarNames((node as SnippetNode).template);
                        return (
                          <Show
                            when={vars.length > 0}
                            fallback={
                              <div class="pl-7 pr-2.5 py-2 text-[11px] text-[#334155] italic">
                                No variables — snippet will render as-is
                              </div>
                            }
                          >
                            <div class="py-1 pb-2">
                              <For each={vars}>
                                {(varName) => (
                                  <div class="flex items-center gap-2 px-2 pl-7 py-1">
                                    <span class="text-[11px] text-[#60a5fa] min-w-[90px] shrink-0 font-mono">
                                      {varName}
                                    </span>
                                    <input
                                      value={(node as SnippetNode).vars[varName] ?? ""}
                                      onInput={(e) =>
                                        updateSnippetVar(
                                          node.id,
                                          varName,
                                          (e.target as HTMLInputElement).value,
                                        )
                                      }
                                      placeholder={`Enter ${varName}…`}
                                      class="flex-1 px-1.5 py-1 border border-[#1e293b] rounded bg-[#0f172a] text-[#e2e8f0] text-[12px] outline-none"
                                    />
                                    <button
                                      onClick={() => applyVar(node.id, varName)}
                                      class="ml-2 px-2 py-1 rounded bg-transparent text-[#34d399] border border-[#34d39933] hover:bg-[#34d39910] text-[12px]"
                                      title={`Apply ${varName} to snippet template`}
                                    >
                                      <i class="i-mdi:check text-[14px]" aria-hidden="true" />
                                    </button>
                                  </div>
                                )}
                              </For>
                            </div>
                          </Show>
                        );
                      }}
                    </Show>
                  </div>

                  {/* Drop indicator after this node */}
                  <Show when={dropIndex() === i() + 1}>
                    <div class="h-0.5 bg-[#3b82f6] rounded my-0.5" />
                  </Show>
                </div>
              )}
            </For>

            {/* Drop indicator at end (past all nodes) */}
            <Show
              when={
                dropIndex() !== null &&
                dropIndex()! > 0 &&
                dropIndex() === nodes.length &&
                nodes.length > 0
              }
            >
              <div class="h-0.5 bg-[#3b82f6] rounded my-0.5" />
            </Show>
          </div>
        </section>

        {/* ── Resize handle ── */}
        <button
          aria-label="Resize panels"
          class="w-[5px] shrink-0 bg-[#0a1120] border-none border-l border-r border-[#1e293b] cursor-col-resize p-0 hover:bg-[#3b82f6] transition-colors"
          onMouseDown={(e) => startPanelDrag("right", e as unknown as MouseEvent)}
        />

        {/* ═══ Right: PDF Preview ══════════════════════════════════════════════ */}
        <div
          style={{ width: `${sizes().right}%` }}
          class="flex flex-col bg-[#0f172a] overflow-hidden"
        >
          <div class="px-3.5 py-2.5 border-b border-[#1e293b] flex items-center justify-between shrink-0">
            <span class="text-[11px] font-semibold text-[#64748b] uppercase tracking-widest">
              Preview
            </span>
            <div class="flex items-center gap-1.5 text-[11px] text-[#334155]">
              <div
                aria-hidden="true"
                class="w-1.5 h-1.5 rounded-full bg-[#22c55e] shadow-[0_0_6px_rgba(34,197,94,0.5)]"
              />
              Live
            </div>
          </div>
          <div class="flex-1 relative bg-[#080f1a]">
            <Show when={!pdfUrl()}>
              <div
                class="absolute inset-0 flex flex-col items-center justify-center text-[#334155] text-[13px] gap-2"
                style={{ "z-index": "1" }}
              >
                <div class="text-[28px] opacity-30">📄</div>
                Add content to see a preview
              </div>
            </Show>
            <iframe
              src={slotUrls()[0] || undefined}
              onLoad={() => {
                if (slotUrls()[0] && activeSlot() !== 0) setActiveSlot(0);
              }}
              style={{
                opacity: activeSlot() === 0 ? "1" : "0",
                transition: "opacity 0.2s ease",
                position: "absolute",
                inset: "0",
                width: "100%",
                height: "100%",
                border: "none",
                "pointer-events": activeSlot() === 0 ? "auto" : "none",
              }}
              title="PDF Preview A"
            />
            <iframe
              src={slotUrls()[1] || undefined}
              onLoad={() => {
                if (slotUrls()[1] && activeSlot() !== 1) setActiveSlot(1);
              }}
              style={{
                opacity: activeSlot() === 1 ? "1" : "0",
                transition: "opacity 0.2s ease",
                position: "absolute",
                inset: "0",
                width: "100%",
                height: "100%",
                border: "none",
                "pointer-events": activeSlot() === 1 ? "auto" : "none",
              }}
              title="PDF Preview B"
            />
          </div>
        </div>
      </div>
    </div>
  );
}

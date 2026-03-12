# Applyst

A small web app for assembling Typst-powered cover letters from reusable snippets (but I guess you could use it for things that aren't cover letters).
Drag snippets into the editor, fill variables, click "Apply" to bake values into saved snippets, and get a live PDF preview, all fully in your browser; no login, no server.

## Features
- Drag & drop snippet library
- Variable inputs with per-variable "Apply" (bakes into snippet)
- Live PDF preview rendered by Typst
- Undo/redo history + snapshots
- LocalStorage persistence

## Stack
Solid.js, Typst (renderer + WASM compiler), UnoCSS, Vite

## Run locally

```bash
pnpm install
pnpm dev
```

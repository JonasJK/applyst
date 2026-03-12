import { defineConfig } from "unocss";
import presetWind4 from "@unocss/preset-wind4";
import presetIcons from "@unocss/preset-icons";

export default defineConfig({
  presets: [
    presetWind4(),
    presetIcons({
      scale: 1,
      extraProperties: {
        display: "inline-block",
        "vertical-align": "middle",
      },
    }),
  ],
  theme: {
    colors: {
      base: "#0f172a",
      surface: "#1a2332",
      panel: "#1e293b",
      border: "#1e293b",
      borderMid: "#334155",
      borderFaint: "#0f172a",
      accent: "#3b82f6",
      accentFaint: "#1e3a5f",
      muted: "#475569",
      dim: "#334155",
      textPrimary: "#f1f5f9",
      textSecondary: "#e2e8f0",
      textMuted: "#94a3b8",
      textDim: "#64748b",
      green: "#22c55e",
      greenMid: "#34d399",
      red: "#f87171",
      blue: "#60a5fa",
    },
  },
});

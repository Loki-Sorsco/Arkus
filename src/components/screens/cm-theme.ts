// CodeMirror theme shared by the file editor and the SQL console: oneDark supplies the syntax colours,
// this pulls backgrounds, gutters, selection and tooltips onto the graphite palette.
import { EditorView } from "@codemirror/view";
import { oneDark } from "@codemirror/theme-one-dark";
import { useLook } from "@/lib/theme";

/** Syntax theme for the current look: oneDark in dark mode, CodeMirror's light theme in light mode. */
export function useCmTheme(): "light" | typeof oneDark { const { theme } = useLook(); return theme === "light" ? "light" : oneDark; }

export const arkusTheme = EditorView.theme({
  "&": { backgroundColor: "var(--bg)", color: "var(--text)", fontSize: "12.5px", height: "100%" },
  ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.55" },
  ".cm-content": { caretColor: "var(--text)" },
  ".cm-gutters": { backgroundColor: "var(--bg)", color: "var(--dim)", borderRight: "1px solid var(--border)" },
  ".cm-activeLineGutter": { backgroundColor: "var(--surface-2)", color: "var(--muted)" },
  ".cm-activeLine": { backgroundColor: "var(--line-hl)" },
  ".cm-arkus-flash": { backgroundColor: "var(--accent-soft)", transition: "background-color .5s ease" },
  "&.cm-focused": { outline: "none" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection": { backgroundColor: "rgba(91,141,239,.28) !important" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--text)" },
  ".cm-matchingBracket": { backgroundColor: "rgba(91,141,239,.18)", outline: "1px solid rgba(91,141,239,.4)" },
  ".cm-tooltip": { backgroundColor: "var(--surface)", border: "1px solid var(--border)", color: "var(--text)" },
  ".cm-tooltip.cm-tooltip-autocomplete > ul": { fontFamily: "var(--font-mono)", fontSize: "12px" },
  ".cm-tooltip-autocomplete ul li[aria-selected]": { backgroundColor: "var(--surface-3)", color: "var(--text)" },
  ".cm-completionLabel": { color: "var(--text-2)" },
  ".cm-completionDetail": { color: "var(--dim)", fontStyle: "normal", marginLeft: "8px" },
  ".cm-panels": { backgroundColor: "var(--surface)", color: "var(--text)" },
}, { dark: true });

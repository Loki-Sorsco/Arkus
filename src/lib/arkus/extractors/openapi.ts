// OpenAPI 3 / Swagger 2 documents → RouteFact (framework "openapi", confidence 1).
// JSON is parsed natively; YAML goes through a tiny indentation-based subset parser (maps, lists, scalars, block strings).
import { normalizePath } from "../types";
import type { ExtractContext, Extractor, RouteFact, Facts } from "../types";
import { isSkipped, MAX_FILE_BYTES, safeRead, basename, toMethod } from "./util";

const SPEC_FILE = /^(openapi|swagger|api[-_]?docs?|api[-_]?spec)(\.v?\d+)?\.(json|ya?ml)$/i;
type J = Record<string, unknown>;
const obj = (v: unknown): J | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as J) : undefined);

// ---------- tiny YAML subset ----------
function yamlScalar(s: string): unknown {
  const t = s.trim();
  if (t === "" || t === "~" || t === "null") return null;
  if (t === "true") return true; if (t === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1).replace(/\\"/g, '"').replace(/''/g, "'");
  if (t.startsWith("[") && t.endsWith("]")) return t.slice(1, -1).split(",").map((x) => yamlScalar(x)).filter((x) => x !== null);
  if (t.startsWith("{") && t.endsWith("}")) { const o: J = {}; for (const kv of t.slice(1, -1).split(",")) { const i = kv.indexOf(":"); if (i > 0) o[kv.slice(0, i).trim()] = yamlScalar(kv.slice(i + 1)); } return o; }
  return t;
}
export function parseYamlSubset(src: string): unknown {
  const lines = src.split(/\r?\n/).map((l) => l.replace(/\s+#.*$/, "").replace(/^#.*$/, "")).filter((l) => l.trim() !== "" && l.trim() !== "---");
  let i = 0;
  const indentOf = (l: string) => l.length - l.trimStart().length;
  const splitKey = (s: string): [string, string] | undefined => { const m = /^("[^"]*"|'[^']*'|[^:]+?)\s*:(?:\s+(.*)|$)/.exec(s); if (!m) return undefined; return [m[1].replace(/^["']|["']$/g, ""), m[2] ?? ""]; };
  const block = (indent: number): unknown => {
    // block scalar lines collected by caller
    if (i >= lines.length) return null;
    const first = lines[i];
    if (first.trimStart().startsWith("- ")) {
      const arr: unknown[] = [];
      while (i < lines.length && indentOf(lines[i]) === indent && lines[i].trimStart().startsWith("- ")) {
        const rest = lines[i].trimStart().slice(2);
        if (splitKey(rest) && !/^["'[{]/.test(rest)) {
          // inline map item: "- name: x" — rewrite the line as a map at indent+2 and parse
          lines[i] = " ".repeat(indent + 2) + rest;
          arr.push(block(indent + 2));
        } else { i++; arr.push(yamlScalar(rest)); }
      }
      return arr;
    }
    const out: J = {};
    while (i < lines.length && indentOf(lines[i]) === indent) {
      const kv = splitKey(lines[i].trim());
      if (!kv) { i++; continue; }
      const [key, val] = kv; i++;
      if (val === "" ) {
        if (i < lines.length && indentOf(lines[i]) > indent) out[key] = block(indentOf(lines[i]));
        else if (i < lines.length && indentOf(lines[i]) === indent && lines[i].trimStart().startsWith("- ")) out[key] = block(indent);
        else out[key] = null;
      } else if (val === "|" || val === ">" || val === "|-" || val === ">-") {
        const buf: string[] = []; const bi = i < lines.length ? indentOf(lines[i]) : indent + 1;
        while (i < lines.length && indentOf(lines[i]) >= bi && indentOf(lines[i]) > indent) buf.push(lines[i++].slice(bi));
        out[key] = buf.join(val.startsWith("|") ? "\n" : " ");
      } else out[key] = yamlScalar(val);
    }
    return out;
  };
  return block(lines.length ? indentOf(lines[0]) : 0);
}

// ---------- schema helpers ----------
function deref(doc: J, node: unknown, depth = 0): J | undefined {
  const o = obj(node); if (!o || depth > 8) return o;
  const ref = o.$ref;
  if (typeof ref === "string" && ref.startsWith("#/")) {
    let cur: unknown = doc;
    for (const seg of ref.slice(2).split("/")) cur = obj(cur)?.[seg.replace(/~1/g, "/").replace(/~0/g, "~")];
    return deref(doc, cur, depth + 1);
  }
  return o;
}
function schemaKeys(doc: J, schema: unknown, depth = 0): { name: string; type?: string; required?: boolean }[] {
  const s = deref(doc, schema); if (!s || depth > 4) return [];
  if (Array.isArray(s.allOf)) return s.allOf.flatMap((x) => schemaKeys(doc, x, depth + 1));
  if (Array.isArray(s.oneOf) || Array.isArray(s.anyOf)) return schemaKeys(doc, ((s.oneOf ?? s.anyOf) as unknown[])[0], depth + 1);
  if (s.type === "array") return schemaKeys(doc, s.items, depth + 1);
  const props = obj(s.properties); if (!props) return [];
  const req = new Set(Array.isArray(s.required) ? (s.required as string[]) : []);
  return Object.entries(props).map(([name, p]) => { const ps = deref(doc, p); const type = ps ? (typeof ps.type === "string" ? ps.type : ps.$ref ? "object" : undefined) : undefined; return { name, type, required: req.has(name) }; });
}
function firstContentSchema(doc: J, holder: unknown): unknown {
  const h = deref(doc, holder); if (!h) return undefined;
  if (h.schema) return h.schema;
  const content = obj(h.content); if (!content) return undefined;
  const mt = Object.keys(content)[0]; return mt ? obj(content[mt])?.schema : undefined;
}

export const openapiExtractor: Extractor = {
  name: "openapi",
  applies(_det, files) { return files.some((f) => SPEC_FILE.test(basename(f.rel)) && !isSkipped(f.rel)); },
  async run(ctx: ExtractContext): Promise<Partial<Facts>> {
    const routes: RouteFact[] = [];
    for (const f of ctx.files) {
      if (!SPEC_FILE.test(basename(f.rel)) || isSkipped(f.rel) || f.size > MAX_FILE_BYTES) continue;
      const text = await safeRead(ctx, f.rel); if (text === undefined) continue;
      let doc: J | undefined;
      try {
        if (/\.json$/i.test(f.rel)) doc = obj(JSON.parse(text));
        else { ctx.log(`openapi: ${f.rel} is YAML — using the built-in subset parser (complex anchors/flow syntax unsupported)`, "warn"); doc = obj(parseYamlSubset(text)); }
      } catch (e) { ctx.log(`openapi: cannot parse ${f.rel}: ${(e as Error).message}`, "warn"); continue; }
      if (!doc || (!doc.openapi && !doc.swagger) || !obj(doc.paths)) { if (doc) ctx.log(`openapi: ${f.rel} has no paths/openapi field; skipped`, "warn"); continue; }
      const globalSecure = Array.isArray(doc.security) && doc.security.length > 0;
      const basePath = typeof doc.basePath === "string" ? doc.basePath : "";
      for (const [rawPath, item] of Object.entries(obj(doc.paths)!)) {
        const pi = deref(doc, item); if (!pi) continue;
        const idx = text.indexOf(rawPath); const line = idx >= 0 ? text.slice(0, idx).split("\n").length : undefined;
        const pathParams = Array.isArray(pi.parameters) ? pi.parameters : [];
        for (const m of ["get", "post", "put", "patch", "delete", "head", "options"]) {
          const op = obj(pi[m]); if (!op) continue;
          const params = [...pathParams, ...(Array.isArray(op.parameters) ? op.parameters : [])].map((p) => deref(doc, p)).filter(Boolean) as J[];
          let bodyKeys = schemaKeys(doc, firstContentSchema(doc, op.requestBody));
          const bodyParam = params.find((p) => p.in === "body"); if (!bodyKeys.length && bodyParam) bodyKeys = schemaKeys(doc, bodyParam.schema);
          if (!bodyKeys.length) { const fp = params.filter((p) => p.in === "formData"); if (fp.length) bodyKeys = fp.map((p) => ({ name: String(p.name), type: typeof p.type === "string" ? p.type : undefined, required: !!p.required })); }
          const responses = obj(op.responses) ?? {};
          const ok = responses["200"] ?? responses["201"] ?? responses["default"] ?? Object.values(responses)[0];
          const responseKeys = schemaKeys(doc, firstContentSchema(doc, ok)).map(({ name, type }) => ({ name, type }));
          const sec = op.security;
          const auth: boolean | "unknown" = Array.isArray(sec) ? sec.length > 0 : globalSecure ? true : "unknown";
          const summary = typeof op.summary === "string" ? op.summary : typeof op.description === "string" ? op.description.split("\n")[0] : undefined;
          routes.push({ method: toMethod(m), path: normalizePath(basePath + rawPath), framework: "openapi", file: f.rel, line, handlerName: typeof op.operationId === "string" ? op.operationId : undefined, auth, bodyKeys: bodyKeys.length ? bodyKeys : undefined, responseKeys: responseKeys.length ? responseKeys : undefined, description: summary, confidence: 1, evidence: [{ kind: "openapi", file: f.rel, line }] });
        }
      }
    }
    ctx.log(`openapi: ${routes.length} routes`);
    return { routes };
  },
};

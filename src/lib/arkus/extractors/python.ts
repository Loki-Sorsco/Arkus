// Python: FastAPI / Flask / Django routes, SQLAlchemy + Django models. Line/regex based.
import { normalizePath } from "../types";
import type { ExtractContext, Extractor, RouteFact, TableFact, ColumnFact, Facts, HttpMethod } from "../types";
import { lineOfOffset, isSkipped, MAX_FILE_BYTES, safeRead, basename, dirname, toMethod } from "./util";

const AUTH_RE = /Depends\(\s*(?:get_)?(?:current_user|current_active_user|user|auth|authenticate|verify_token|require_auth|get_token|oauth2_scheme|security|jwt_required|login_required|HTTPBearer)|@login_required|@jwt_required|@permission_classes|IsAuthenticated|@auth\.|@token_required|@require_auth/i;

interface PyFile { rel: string; text: string; lines: string[] }
interface Model { name: string; file: string; fields: { name: string; type?: string; required?: boolean }[] }

/** `class Foo(BaseModel):` → fields from the indented body. */
function pydanticModels(f: PyFile): Model[] {
  const out: Model[] = [];
  for (let i = 0; i < f.lines.length; i++) {
    const m = /^class\s+(\w+)\s*\(([^)]*)\)\s*:/.exec(f.lines[i]);
    if (!m || !/BaseModel|Schema|BaseSchema|TypedDict|dataclass/.test(m[2] + (f.lines[i - 1] ?? ""))) continue;
    const model: Model = { name: m[1], file: f.rel, fields: [] };
    for (let j = i + 1; j < f.lines.length; j++) {
      const l = f.lines[j];
      if (/^\S/.test(l) && l.trim()) break;
      const fm = /^\s+(\w+)\s*:\s*([^=#]+?)\s*(?:=\s*(.+))?$/.exec(l);
      if (fm && !/^(class|def|model_config|Config)$/.test(fm[1])) model.fields.push({ name: fm[1], type: fm[2].trim(), required: !fm[3] && !/Optional|None/.test(fm[2]) });
    }
    out.push(model);
  }
  return out;
}

function routesOf(f: PyFile, models: Map<string, Model>, out: RouteFact[], prefixes: Map<string, string>) {
  const text = f.text;
  const fw = /from\s+fastapi|import\s+fastapi/.test(text) ? "fastapi" : /from\s+flask|import\s+flask/.test(text) ? "flask" : /rest_framework|django/.test(text) ? "django" : "fastapi";
  const localPrefix = new Map<string, string>(); // router var → prefix
  for (const m of text.matchAll(/(\w+)\s*=\s*(?:APIRouter|Blueprint)\s*\(([^)]*)\)/g)) { const p = /(?:prefix|url_prefix)\s*=\s*["']([^"']+)["']/.exec(m[2]); localPrefix.set(m[1], p ? p[1] : ""); }
  const decoRe = /^\s*@(\w+)\.(get|post|put|patch|delete|head|options|route|api_route)\(\s*["']([^"']+)["']([^)]*)\)/;
  for (let i = 0; i < f.lines.length; i++) {
    const m = decoRe.exec(f.lines[i]);
    if (!m) continue;
    const [, recv, verb, path, rest] = m;
    const methods: string[] = [];
    if (verb === "route" || verb === "api_route") { const mm = /methods\s*=\s*\[([^\]]*)\]/.exec(rest); if (mm) for (const x of mm[1].split(",")) { const v = x.replace(/["'\s]/g, ""); if (v) methods.push(v); } if (!methods.length) methods.push("GET"); }
    else methods.push(verb);
    // handler def (skip stacked decorators)
    let j = i + 1; while (j < f.lines.length && /^\s*@/.test(f.lines[j])) j++;
    const def = /^\s*(?:async\s+)?def\s+(\w+)\s*\(([\s\S]*?)\)/.exec(f.lines.slice(j, j + 12).join("\n"));
    const handlerName = def?.[1];
    const params = def?.[2] ?? "";
    const bodyStart = j; let k = j + 1; while (k < f.lines.length && (/^\s+/.test(f.lines[k]) || !f.lines[k].trim())) k++;
    const bodyText = f.lines.slice(bodyStart, k).join("\n");
    const docm = /"""\s*([^\n"]+)/.exec(bodyText);
    const auth = AUTH_RE.test(f.lines.slice(Math.max(0, i - 3), j + 1).join("\n") + params) ? true : "unknown";
    let bodyKeys: RouteFact["bodyKeys"];
    for (const pm of params.matchAll(/(\w+)\s*:\s*(\w+)/g)) { const mod = models.get(pm[2]); if (mod) bodyKeys = mod.fields.map((x) => ({ name: x.name, type: x.type, required: x.required })); }
    if (!bodyKeys) { const ks = new Set<string>(); for (const bm of bodyText.matchAll(/(?:request\.(?:json|form|get_json\(\))|data|body|payload)\s*(?:\.get\(|\[)\s*["'](\w+)["']/g)) ks.add(bm[1]); if (ks.size) bodyKeys = [...ks].map((name) => ({ name })); }
    const prefix = (prefixes.get(`${f.rel}:${recv}`) ?? "") + (localPrefix.get(recv) ?? "");
    for (const mth of methods) {
      out.push({ method: toMethod(mth), path: normalizePath(prefix + path), framework: fw, file: f.rel, line: i + 1, handlerName, auth, bodyKeys: /^(get|head|options|delete)$/i.test(mth) ? undefined : bodyKeys, description: docm?.[1]?.trim(), confidence: prefix ? 0.8 : 1, evidence: [{ kind: "static", file: f.rel, line: i + 1 }] });
    }
  }
}

/** Django urls.py → RouteFact (method ANY; DRF @api_view methods when the view is found). */
function djangoUrls(f: PyFile, all: Map<string, PyFile>, out: RouteFact[], prefix: string, depth: number) {
  if (depth > 4) return;
  const viewsFile = all.get(dirname(f.rel) + "/views.py") ?? all.get((dirname(f.rel) ? dirname(f.rel) + "/" : "") + "views.py");
  const apiViewMethods = new Map<string, string[]>();
  if (viewsFile) for (const m of viewsFile.text.matchAll(/@api_view\(\s*\[([^\]]*)\]\s*\)\s*\n(?:\s*@[^\n]*\n)*\s*def\s+(\w+)/g)) apiViewMethods.set(m[2], m[1].split(",").map((x) => x.replace(/["'\s]/g, "")).filter(Boolean));
  for (const m of f.text.matchAll(/\b(?:path|re_path|url)\(\s*r?["']([^"']*)["']\s*,\s*([^,)]+)/g)) {
    const p = prefix + "/" + m[1].replace(/\^|\$/g, "").replace(/\(\?P<(\w+)>[^)]*\)/g, ":$1");
    const target = m[2].trim();
    const line = lineOfOffset(f.text, m.index!);
    const inc = /include\(\s*["']([\w.]+)["']/.exec(target) ?? /include\(\s*\(?\s*["']([\w.]+)["']/.exec(m[0] + f.text.slice(m.index! + m[0].length, m.index! + m[0].length + 80));
    if (inc) {
      const modPath = inc[1].replace(/\./g, "/") + ".py";
      const sub = [...all.values()].find((x) => x.rel === modPath || x.rel.endsWith("/" + modPath));
      if (sub && sub.rel !== f.rel) djangoUrls(sub, all, out, normalizePath(p).replace(/\/$/, ""), depth + 1);
      continue;
    }
    if (/include\(/.test(target)) continue;
    const viewName = target.replace(/\.as_view\(.*$/, "").split(".").pop() ?? target;
    const methods = apiViewMethods.get(viewName) ?? ["ANY"];
    const auth = viewsFile && new RegExp(`(@permission_classes\\(\\[[^\\]]*IsAuthenticated|@login_required|permission_classes\\s*=\\s*[\\[(][^\\])]*IsAuthenticated)[\\s\\S]{0,300}?(def|class)\\s+${viewName}\\b`).test(viewsFile.text) ? true : "unknown";
    for (const mth of methods) out.push({ method: toMethod(mth) as HttpMethod, path: normalizePath(p), framework: "django", file: f.rel, line, handlerName: viewName, auth, confidence: prefix ? 0.8 : 1, evidence: [{ kind: "static", file: f.rel, line }] });
  }
  for (const m of f.text.matchAll(/\brouter\.register\(\s*r?["']([^"']*)["']\s*,\s*(\w+)/g)) {
    const line = lineOfOffset(f.text, m.index!);
    const base = normalizePath(prefix + "/" + m[1].replace(/\^|\$/g, ""));
    out.push({ method: "ANY", path: base, framework: "django", file: f.rel, line, handlerName: m[2], auth: "unknown", confidence: 0.6, evidence: [{ kind: "static", file: f.rel, line, note: "DRF router" }] });
    out.push({ method: "ANY", path: normalizePath(base + "/:pk"), framework: "django", file: f.rel, line, handlerName: m[2], auth: "unknown", confidence: 0.6, evidence: [{ kind: "static", file: f.rel, line, note: "DRF router" }] });
  }
}

const SA_TYPES: Record<string, string> = { Integer: "integer", BigInteger: "bigint", SmallInteger: "smallint", String: "varchar", Text: "text", Boolean: "boolean", DateTime: "timestamp", Date: "date", Time: "time", Float: "float", Numeric: "numeric", DECIMAL: "numeric", JSON: "json", JSONB: "jsonb", UUID: "uuid", LargeBinary: "bytea", Enum: "enum", ARRAY: "array", int: "integer", str: "varchar", bool: "boolean", float: "float", datetime: "timestamp", date: "date", Decimal: "numeric", dict: "json", bytes: "bytea" };
const DJ_TYPES: Record<string, string> = { CharField: "varchar", TextField: "text", IntegerField: "integer", BigIntegerField: "bigint", SmallIntegerField: "smallint", PositiveIntegerField: "integer", BooleanField: "boolean", DateTimeField: "timestamp", DateField: "date", TimeField: "time", FloatField: "float", DecimalField: "numeric", EmailField: "varchar", URLField: "varchar", SlugField: "varchar", UUIDField: "uuid", JSONField: "json", FileField: "varchar", ImageField: "varchar", AutoField: "integer", BigAutoField: "bigint", ForeignKey: "integer", OneToOneField: "integer" };

function sqlalchemyModels(f: PyFile, out: TableFact[]) {
  for (let i = 0; i < f.lines.length; i++) {
    const cm = /^class\s+(\w+)\s*\(([^)]*)\)\s*:/.exec(f.lines[i]);
    if (!cm) continue;
    let j = i + 1; const body: string[] = [];
    while (j < f.lines.length && (!f.lines[j].trim() || /^\s/.test(f.lines[j]))) body.push(f.lines[j++]);
    const btxt = body.join("\n");
    const tn = /__tablename__\s*=\s*["'](\w+)["']/.exec(btxt);
    const isDjango = /models\.Model|AbstractUser|AbstractBaseUser/.test(cm[2]);
    if (!tn && !isDjango && !/Column\(|mapped_column\(/.test(btxt)) continue;
    const columns: ColumnFact[] = [];
    if (isDjango) {
      const app = basename(dirname(f.rel)) || "app";
      const meta = /db_table\s*=\s*["'](\w+)["']/.exec(btxt);
      for (const m of btxt.matchAll(/^\s+(\w+)\s*=\s*models\.(\w+)\(([^\n]*)\)/gm)) {
        const [, name, ftype, args] = m;
        const col: ColumnFact = { name: /ForeignKey|OneToOneField/.test(ftype) ? `${name}_id` : name, type: DJ_TYPES[ftype] ?? ftype.replace(/Field$/, "").toLowerCase(), nullable: /null\s*=\s*True/.test(args) || undefined, unique: /unique\s*=\s*True/.test(args) || undefined, pk: /primary_key\s*=\s*True/.test(args) || undefined, index: /db_index\s*=\s*True/.test(args) || undefined };
        const def = /default\s*=\s*([^,)]+)/.exec(args); if (def) col.default = def[1].trim();
        if (/ForeignKey|OneToOneField/.test(ftype)) { const t = /^\s*["']?(\w+)(?:\.(\w+))?["']?/.exec(args); if (t) col.references = { table: t[2] ? `${t[1]}_${t[2]}`.toLowerCase() : `${app}_${t[1]}`.toLowerCase(), column: "id" }; }
        if (ftype === "ManyToManyField") continue;
        columns.push(col);
      }
      if (!columns.some((c) => c.pk)) columns.unshift({ name: "id", type: "integer", pk: true });
      out.push({ name: meta ? meta[1] : `${app}_${cm[1]}`.toLowerCase(), modelName: cm[1], columns, file: f.rel, line: i + 1, source: "django" });
      continue;
    }
    for (const m of btxt.matchAll(/^\s+(\w+)\s*(?::\s*Mapped\[([^\]]+)\])?\s*=\s*(?:Column|mapped_column)\(([^\n]*)\)/gm)) {
      const [, name, mapped, args] = m;
      const tm = /^\s*["']?(\w+)["']?(?:\([^)]*\))?\s*,?\s*(\w+)?/.exec(args);
      const typeTok = (tm && /^(String|Integer|Text|Boolean|DateTime|Date|Float|Numeric|JSON|UUID|BigInteger|LargeBinary|Enum|ARRAY|JSONB|SmallInteger|Time|DECIMAL)$/.test(tm[1]) ? tm[1] : tm && tm[2] && /^(String|Integer|Text|Boolean|DateTime|Date|Float|Numeric|JSON|UUID|BigInteger|LargeBinary|Enum|ARRAY|JSONB|SmallInteger|Time|DECIMAL)$/.test(tm[2]) ? tm[2] : undefined) ?? (mapped ? mapped.replace(/Optional\[|\]|\s*\|\s*None/g, "").trim() : undefined);
      const col: ColumnFact = { name, type: SA_TYPES[typeTok ?? ""] ?? (typeTok ?? "unknown").toLowerCase(), pk: /primary_key\s*=\s*True/.test(args) || undefined, unique: /unique\s*=\s*True/.test(args) || undefined, index: /index\s*=\s*True/.test(args) || undefined, nullable: /nullable\s*=\s*True/.test(args) || (mapped ? /Optional|None/.test(mapped) : undefined) || undefined };
      if (/nullable\s*=\s*False/.test(args)) col.nullable = false;
      const fk = /ForeignKey\(\s*["'](\w+)\.(\w+)["']/.exec(args); if (fk) col.references = { table: fk[1], column: fk[2] };
      const def = /default\s*=\s*([^,)]+)/.exec(args); if (def) col.default = def[1].trim();
      columns.push(col);
    }
    if (columns.length || tn) out.push({ name: tn ? tn[1] : cm[1].toLowerCase(), modelName: cm[1], columns, file: f.rel, line: i + 1, source: "sqlalchemy" });
  }
}

export const pythonExtractor: Extractor = {
  name: "python",
  applies(det, files) {
    return det.languages.includes("py") || det.frameworks.some((f) => ["fastapi", "flask", "django"].includes(f)) || files.some((f) => f.rel.endsWith(".py"));
  },
  async run(ctx: ExtractContext): Promise<Partial<Facts>> {
    const routes: RouteFact[] = []; const tables: TableFact[] = [];
    const files = new Map<string, PyFile>();
    for (const f of ctx.files) {
      if (!f.rel.endsWith(".py") || isSkipped(f.rel) || f.size > MAX_FILE_BYTES || /(^|\/)(tests?|migrations)\//.test(f.rel) || /^test_|_test\.py$/.test(basename(f.rel))) continue;
      const text = await safeRead(ctx, f.rel); if (text === undefined) continue;
      files.set(f.rel, { rel: f.rel, text, lines: text.split(/\r?\n/) });
    }
    const models = new Map<string, Model>();
    for (const f of files.values()) try { for (const m of pydanticModels(f)) models.set(m.name, m); } catch { /* ignore */ }
    // include_router(x.router, prefix=...) / register_blueprint(bp, url_prefix=...) across files, best effort
    const prefixes = new Map<string, string>(); // "file:routerVar" → prefix
    for (const f of files.values()) {
      const imp = new Map<string, string>(); // local → module path
      for (const m of f.text.matchAll(/^\s*from\s+([\w.]+)\s+import\s+([^\n#]+)/gm)) for (const n of m[2].replace(/[()]/g, "").split(",")) { const [orig, alias] = n.trim().split(/\s+as\s+/); if (orig) imp.set(alias ?? orig, m[1] + "." + orig); }
      for (const m of f.text.matchAll(/^\s*import\s+([\w.]+)(?:\s+as\s+(\w+))?/gm)) imp.set(m[2] ?? m[1].split(".").pop()!, m[1]);
      for (const m of f.text.matchAll(/\.(?:include_router|register_blueprint)\(\s*([\w.]+)\s*(?:,[^)]*?(?:prefix|url_prefix)\s*=\s*["']([^"']*)["'])?/g)) {
        const [, target, prefix = ""] = m;
        const segs = target.split("."); const routerVar = segs.pop()!; const modLocal = segs.join(".");
        const modPath = modLocal ? imp.get(modLocal) ?? imp.get(segs[0]) : imp.get(routerVar);
        const candidates = modPath ? [modPath.replace(/^\.+/, "").replace(/\./g, "/")] : [];
        let targetFile: PyFile | undefined;
        for (const c of candidates) targetFile = [...files.values()].find((x) => x.rel === c + ".py" || x.rel.endsWith("/" + c + ".py") || x.rel === c + "/__init__.py" || x.rel.endsWith("/" + c + "/__init__.py") || (modLocal && x.rel.endsWith("/" + c + "/" + routerVar + ".py")));
        if (!targetFile && modLocal) targetFile = [...files.values()].find((x) => basename(x.rel) === modLocal.split(".").pop() + ".py");
        if (!targetFile) continue;
        const key = `${targetFile.rel}:${modLocal ? routerVar : routerVar}`;
        prefixes.set(key, (prefixes.get(key) ?? "") + prefix);
        // the included module may re-export a router variable under a different local name; also map common names
        if (!modLocal) prefixes.set(`${targetFile.rel}:router`, prefix);
      }
    }
    for (const f of files.values()) {
      try {
        if (/@\w+\.(get|post|put|patch|delete|route|api_route)\(/.test(f.text)) routesOf(f, models, routes, prefixes);
        if (basename(f.rel) === "urls.py" && /urlpatterns/.test(f.text)) {
          // only start from root urls files (those not included elsewhere)
          const included = [...files.values()].some((o) => o.rel !== f.rel && new RegExp(`include\\(\\s*["'][\\w.]*${basename(dirname(f.rel)) || "x"}\\.urls["']`).test(o.text));
          if (!included) djangoUrls(f, files, routes, "", 0);
        }
        if (/__tablename__|Column\(|mapped_column\(|models\.Model/.test(f.text)) sqlalchemyModels(f, tables);
      } catch (e) { ctx.log(`python: failed on ${f.rel}: ${(e as Error).message}`, "warn"); }
    }
    ctx.log(`python: ${routes.length} routes, ${tables.length} tables`);
    return { routes, tables };
  },
};

#!/usr/bin/env node
/**
 * Post-build patch: Force-enable Fast mode (speed selector) and optionally
 * inject a serviceTier="priority" dispatcher shim.
 *
 * The speed selector is gated by authMethod === "chatgpt" checks.
 * API-key users never see it because their authMethod differs.
 *
 * This patch locates two known Fast mode gates:
 *
 * 1. BinaryExpression nodes matching:
 *   X.authMethod !== "chatgpt"
 * inside functions that also reference "fast_mode", and replaces
 * the comparison with !1 (always false), removing the auth gate.
 *
 * 2. Minified statsig helper functions that return the computed fast gate
 * result, and replaces the final return value with true. This mirrors the
 * ct-only app.asar patch used by codex-openfast, but operates on the rebuild
 * tree before packaging/signing.
 *
 * Target: permissions-mode-helpers-*.js (or any chunk with the pattern)
 *
 * Optional service tier shim:
 *   node scripts/patch-fast-mode.js mac-arm64 --service-tier=fast
 *   node scripts/patch-fast-mode.js mac-arm64 --service-tier=standard
 *   node scripts/patch-fast-mode.js mac-arm64 --service-tier=inherit
 *
 * Default is inherit. In inherit mode the shim only normalizes a configured
 * default-service-tier value of "fast"/"priority" to request serviceTier
 * "priority". Runtime testing helpers are exposed as:
 *   window.codexRebuildServiceTier.fast()
 *   window.codexRebuildServiceTier.standard()
 *   window.codexRebuildServiceTier.inherit()
 */
const fs = require("fs");
const path = require("path");
const { parse } = require("acorn");
const { locateBundles, relPath, SRC_DIR } = require("./patch-util");

const SERVICE_TIER_START_MARKER =
  "/* codex-rebuild-service-tier-priority-shim-v1:start */";
const SERVICE_TIER_END_MARKER =
  "/* codex-rebuild-service-tier-priority-shim-v1:end */";

function walk(node, visitor) {
  if (!node || typeof node !== "object") return;
  if (node.type) visitor(node);
  for (const key of Object.keys(node)) {
    if (key === "type" || key === "start" || key === "end") continue;
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) {
        if (item && typeof item === "object" && item.type) walk(item, visitor);
      }
    } else if (child && typeof child === "object" && child.type) {
      walk(child, visitor);
    }
  }
}

function collectPatches(ast, source) {
  const patches = [];

  walk(ast, (node) => {
    // Match function bodies containing both authMethod and fast_mode
    const isFn =
      node.type === "FunctionDeclaration" ||
      node.type === "FunctionExpression" ||
      node.type === "ArrowFunctionExpression";
    if (!isFn) return;

    const fnSrc = source.slice(node.start, node.end);
    if (!fnSrc.includes("authMethod") || !fnSrc.includes("fast_mode")) return;

    // Inside this function, find: X.authMethod !== `chatgpt`
    walk(node, (child) => {
      if (child.type !== "BinaryExpression" || child.operator !== "!==") return;

      const childSrc = source.slice(child.start, child.end);
      if (!childSrc.includes("authMethod") || !childSrc.includes("chatgpt"))
        return;

      if (childSrc === "!1") return;

      // Avoid duplicate patches at same offset
      if (patches.some((p) => p.start === child.start)) return;

      patches.push({
        id: "fast_mode_auth_gate",
        start: child.start,
        end: child.end,
        replacement: "!1",
        original: childSrc,
      });
    });
  });

  return patches;
}

function collectStatsigFastGatePatches(source) {
  const ident = String.raw`[A-Za-z_$][A-Za-z0-9_$]*`;
  const quote = String.raw`[\`"']`;
  const pattern = new RegExp(
    String.raw`(function ${ident}\(\)\{let e=\(0,${ident}\.c\)\(3\),\{authMethod:t\}=${ident}\(\),\[n\]=${ident}\(${quote}statsig_default_enable_features${quote}\),r;return e\[0\]!==t\|\|e\[1\]!==n\?\.fast_mode\?\(r=n\?\.fast_mode===!0&&${ident}\(t\),e\[0\]=t,e\[1\]=n\?\.fast_mode,e\[2\]=r\):r=e\[2\],)(r|true)(\})`,
    "g",
  );

  const patches = [];
  for (const match of source.matchAll(pattern)) {
    const original = match[2];
    if (original === "true") continue;

    const start = match.index + match[1].length;
    patches.push({
      id: "statsig_fast_gate",
      start,
      end: start + original.length,
      replacement: "true",
      original,
    });
  }

  return patches;
}

function mergePatches(...groups) {
  const patches = [];
  for (const group of groups) {
    for (const patch of group) {
      if (patches.some((p) => p.start === patch.start)) continue;
      patches.push(patch);
    }
  }
  return patches;
}

function argValue(args, name) {
  const prefix = `--${name}=`;
  const arg = args.find((value) => value.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : "";
}

function normalizeServiceTierMode(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "fast" || normalized === "priority") return "fast";
  if (
    normalized === "standard" ||
    normalized === "off" ||
    normalized === "none" ||
    normalized === "null"
  ) {
    return "standard";
  }
  return "inherit";
}

function normalizeFastServiceTierValue(value) {
  const normalized = String(value || "").trim();
  return normalized || "priority";
}

function serviceTierShim(defaultMode, fastTierValue) {
  return `
${SERVICE_TIER_START_MARKER}
;(() => {
  const VERSION = "codex-rebuild-service-tier-priority-shim-v1";
  if (typeof window === "undefined" || window.__codexRebuildServiceTierShim === VERSION) return;
  window.__codexRebuildServiceTierShim = VERSION;

  const DEFAULT_MODE = ${JSON.stringify(defaultMode)};
  const DEFAULT_FAST_TIER_VALUE = ${JSON.stringify(fastTierValue)};
  const MODE_KEY = "codex-rebuild-service-tier-mode";
  const FAST_VALUE_KEY = "codex-rebuild-service-tier-fast-value";
  const REQUEST_METHODS = new Set(["thread/start", "thread/resume", "turn/start"]);
  const STYLE_ID = "codex-rebuild-service-tier-style";
  const BADGE_ID = "codex-rebuild-service-tier-badge";
  const modulePromises = new Map();
  let inheritedServiceTier = null;
  let inheritedServiceTierLoaded = false;
  let rewriteCount = 0;
  let lastRewrite = null;

  function normalizeMode(value) {
    const normalized = String(value || "").trim().toLowerCase();
    if (normalized === "fast" || normalized === "priority") return "fast";
    if (normalized === "standard" || normalized === "off" || normalized === "none" || normalized === "null") return "standard";
    return "inherit";
  }

  function isFastTierValue(value) {
    const normalized = String(value || "").trim().toLowerCase();
    return normalized === "fast" || normalized === "priority";
  }

  function fastTierValue() {
    try {
      return String(localStorage.getItem(FAST_VALUE_KEY) || "").trim() || DEFAULT_FAST_TIER_VALUE;
    } catch {
      return DEFAULT_FAST_TIER_VALUE;
    }
  }

  function configuredMode() {
    try {
      return normalizeMode(localStorage.getItem(MODE_KEY) || DEFAULT_MODE);
    } catch {
      return normalizeMode(DEFAULT_MODE);
    }
  }

  function effectiveMode() {
    const mode = configuredMode();
    if (mode !== "inherit") return mode;
    return isFastTierValue(inheritedServiceTier) ? "fast" : "inherit";
  }

  function serviceTierForMode(mode) {
    if (mode === "fast") return fastTierValue();
    if (mode === "standard") return null;
    return undefined;
  }

  function assetUrl(namePart) {
    const urls = [
      ...Array.from(document.scripts || []).map((script) => script.src),
      ...Array.from(document.querySelectorAll("link[href]") || []).map((link) => link.href),
      ...performance.getEntriesByType("resource").map((entry) => entry.name),
    ].filter(Boolean);
    return urls.find((url) => url.includes("/assets/") && url.includes(namePart) && url.split("?")[0].endsWith(".js")) || "";
  }

  async function loadAppModule(namePart) {
    if (!modulePromises.has(namePart)) {
      const promise = Promise.resolve().then(async () => {
        const url = assetUrl(namePart);
        if (!url) throw new Error("Codex asset not found: " + namePart);
        return await import(url);
      }).catch((error) => {
        modulePromises.delete(namePart);
        throw error;
      });
      modulePromises.set(namePart, promise);
    }
    return await modulePromises.get(namePart);
  }

  async function loadInheritedServiceTier() {
    try {
      const module = await loadAppModule("setting-storage-");
      if (typeof module.n !== "function") return;
      inheritedServiceTier = await module.n({ key: "default-service-tier", default: null });
      inheritedServiceTierLoaded = true;
      refreshBadge();
    } catch (error) {
      window.__codexRebuildServiceTierLastError = String(error && error.message || error);
      refreshBadge();
    }
  }

  function methodFromMessage(type, payload) {
    if (type === "send-cli-request-for-host" && payload && payload.method) return String(payload.method);
    return String(type || "");
  }

  function applyServiceTier(method, params) {
    if (!REQUEST_METHODS.has(method) || !params || typeof params !== "object") return params;
    if (isFastTierValue(params.serviceTier)) {
      const value = fastTierValue();
      if (params.serviceTier === value) return params;
      rewriteCount += 1;
      lastRewrite = { method, serviceTier: value, at: Date.now() };
      return { ...params, serviceTier: value };
    }
    const value = serviceTierForMode(effectiveMode());
    if (value === undefined) return params;
    if (params.serviceTier === value) return params;
    rewriteCount += 1;
    lastRewrite = { method, serviceTier: value || "standard", at: Date.now() };
    return { ...params, serviceTier: value };
  }

  function rewriteMessage(message) {
    if (!message || typeof message !== "object") return message;
    const type = String(message.type || "");

    if (type === "send-cli-request-for-host") {
      const method = methodFromMessage(type, message);
      const params = applyServiceTier(method, message.params);
      return params === message.params ? message : { ...message, params };
    }

    if ((type === "mcp-request" || type === "worker-request") && message.request && typeof message.request === "object") {
      const method = String(message.request.method || "");
      const params = applyServiceTier(method, message.request.params);
      return params === message.request.params ? message : { ...message, request: { ...message.request, params } };
    }

    if (type === "thread-prewarm-start" && message.request && typeof message.request === "object") {
      const params = applyServiceTier("thread/start", message.request.params);
      return params === message.request.params ? message : { ...message, request: { ...message.request, params } };
    }

    if (type === "start-conversation") {
      const value = serviceTierForMode(effectiveMode());
      return value === undefined || message.serviceTier === value ? message : { ...message, serviceTier: value };
    }

    if (type === "prewarm-thread-start-for-host" && message.params && typeof message.params === "object") {
      const params = applyServiceTier("thread/start", message.params);
      return params === message.params ? message : { ...message, params };
    }

    if (type === "start-thread-for-host") {
      const next = applyServiceTier("thread/start", message);
      return next === message ? message : next;
    }

    if (type === "start-turn-for-host" && message.params && typeof message.params === "object") {
      const params = applyServiceTier("turn/start", message.params);
      return params === message.params ? message : { ...message, params };
    }

    return message;
  }

  function dispatcherFromModule(module) {
    const exports = Object.values(module || {});
    for (const value of exports) {
      if (typeof value !== "function" || typeof value.getInstance !== "function") continue;
      let source = "";
      try { source = Function.prototype.toString.call(value); } catch {}
      if (!source.includes("dispatchMessage")) continue;
      try {
        const dispatcher = value.getInstance();
        if (dispatcher && typeof dispatcher.dispatchMessage === "function") return dispatcher;
      } catch {}
    }
    for (const value of exports) {
      if (!value || typeof value.getInstance !== "function") continue;
      try {
        const dispatcher = value.getInstance();
        if (dispatcher && typeof dispatcher.dispatchMessage === "function") return dispatcher;
      } catch {}
    }
    return null;
  }

  async function installDispatcherPatch() {
    try {
      const module = await loadAppModule("setting-storage-");
      const dispatcher = dispatcherFromModule(module);
      if (!dispatcher || typeof dispatcher.dispatchMessage !== "function") throw new Error("Codex dispatcher unavailable");
      if (dispatcher.__codexRebuildServiceTierOriginalDispatchMessage) return;
      dispatcher.__codexRebuildServiceTierOriginalDispatchMessage = dispatcher.dispatchMessage.bind(dispatcher);
      dispatcher.dispatchMessage = (type, payload) => {
        const message = rewriteMessage({ ...(payload || {}), type });
        const nextType = message && message.type ? message.type : type;
        const { type: _type, ...nextPayload } = message || {};
        return dispatcher.__codexRebuildServiceTierOriginalDispatchMessage(nextType, nextPayload);
      };
      window.__codexRebuildServiceTierPatchInstalled = true;
      refreshBadge();
    } catch (error) {
      window.__codexRebuildServiceTierLastError = String(error && error.message || error);
      refreshBadge();
    }
  }

  function setMode(mode) {
    localStorage.setItem(MODE_KEY, normalizeMode(mode));
    void loadInheritedServiceTier();
    setTimeout(refreshBadge, 0);
    return status();
  }

  function clearMode() {
    localStorage.removeItem(MODE_KEY);
    localStorage.removeItem(FAST_VALUE_KEY);
    void loadInheritedServiceTier();
    setTimeout(refreshBadge, 0);
    return status();
  }

  function status() {
    return {
      configuredMode: configuredMode(),
      effectiveMode: effectiveMode(),
      inheritedServiceTier,
      inheritedServiceTierLoaded,
      fastTierValue: fastTierValue(),
      patchInstalled: !!window.__codexRebuildServiceTierPatchInstalled,
      rewriteCount,
      lastRewrite,
      lastError: window.__codexRebuildServiceTierLastError || "",
    };
  }

  function installBadgeStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = [
      ".codex-rebuild-service-tier-button{position:fixed;right:14px;top:54px;z-index:2147483000;border:1px solid rgba(255,255,255,.18);border-radius:7px;background:#2f3437;color:#f4f4f5;font:12px/1.2 system-ui,sans-serif;padding:6px 9px;box-shadow:0 8px 22px rgba(0,0,0,.22);cursor:pointer}",
      ".codex-rebuild-service-tier-button[data-mode=\\"fast\\"]{border-color:rgba(16,163,127,.68);background:rgba(16,163,127,.22);color:#6ee7b7}",
      ".codex-rebuild-service-tier-button[data-mode=\\"standard\\"]{border-color:rgba(148,163,184,.45);background:rgba(51,65,85,.72);color:#e5e7eb}",
      ".codex-rebuild-service-tier-button[data-mode=\\"inherit\\"]{border-color:rgba(161,161,170,.35);background:rgba(39,39,42,.78);color:#a1a1aa}",
      ".codex-rebuild-service-tier-button[data-ready=\\"false\\"]{opacity:.62}",
    ].join("\\n");
    document.head.appendChild(style);
  }

  function badgeState() {
    const current = status();
    const mode = current.effectiveMode === "fast"
      ? "fast"
      : current.configuredMode === "standard"
        ? "standard"
        : "inherit";
    const label = mode === "fast" ? "fast" : mode === "standard" ? "standard" : "inherit";
    const configured = current.configuredMode;
    const inherited = current.inheritedServiceTier == null ? "default" : String(current.inheritedServiceTier);
    const title = [
      "Service tier: " + label,
      "Configured: " + configured,
      "Inherited default-service-tier: " + inherited,
      "Fast sends serviceTier=priority on thread/start, thread/resume, turn/start.",
      "Rewrites: " + current.rewriteCount,
      "Click: toggle fast/standard. Right click: inherit.",
      current.lastError ? "Last error: " + current.lastError : "",
    ].filter(Boolean).join("\\n");
    return { ...current, mode, label, title };
  }

  function refreshBadge() {
    const button = document.getElementById(BADGE_ID);
    if (!button) return;
    const state = badgeState();
    button.dataset.mode = state.mode;
    button.dataset.ready = String(!!state.patchInstalled);
    button.textContent = state.label;
    button.title = state.title;
    button.setAttribute("aria-label", state.title);
  }

  function toggleFromBadge() {
    const state = badgeState();
    setMode(state.effectiveMode === "fast" ? "standard" : "fast");
  }

  function installBadge() {
    if (!document.body) return;
    installBadgeStyle();
    let button = document.getElementById(BADGE_ID);
    if (!button) {
      button = document.createElement("button");
      button.id = BADGE_ID;
      button.type = "button";
      button.className = "codex-rebuild-service-tier-button";
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        toggleFromBadge();
      }, true);
      button.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        event.stopPropagation();
        setMode("inherit");
      }, true);
      document.body.appendChild(button);
    }
    refreshBadge();
  }

  function scheduleBadgeInstall() {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", installBadge, { once: true });
    } else {
      installBadge();
    }
  }

  window.codexRebuildServiceTier = {
    status,
    set(mode) { return setMode(mode); },
    fast() { return setMode("fast"); },
    standard() { return setMode("standard"); },
    inherit() { return setMode("inherit"); },
    setFastValue(value) {
      localStorage.setItem(FAST_VALUE_KEY, String(value || "").trim() || DEFAULT_FAST_TIER_VALUE);
      refreshBadge();
      return status();
    },
    clear() { return clearMode(); },
  };

  scheduleBadgeInstall();
  void loadInheritedServiceTier();
  void installDispatcherPatch();
  setInterval(() => void installDispatcherPatch(), 5000);
  setInterval(() => void loadInheritedServiceTier(), 15000);
  setInterval(refreshBadge, 1000);
})();
${SERVICE_TIER_END_MARKER}
`;
}

function locateServiceTierTargets(platforms) {
  const targets = [];
  for (const plat of platforms) {
    const assetsDir = path.join(SRC_DIR, plat, "_asar", "webview", "assets");
    if (!fs.existsSync(assetsDir)) continue;
    const files = fs.readdirSync(assetsDir).filter((file) => /^index-.*\.js$/.test(file));
    for (const file of files) {
      targets.push({ platform: plat, path: path.join(assetsDir, file) });
    }
  }
  return targets;
}

function replaceExistingShim(source, shim) {
  const start = source.indexOf(SERVICE_TIER_START_MARKER);
  const end = source.indexOf(SERVICE_TIER_END_MARKER);
  if (start === -1 || end === -1 || end < start) return null;
  const endPos = end + SERVICE_TIER_END_MARKER.length;
  const next = `${source.slice(0, start)}${shim}${source.slice(endPos)}`;
  return next === source ? source : next;
}

function injectServiceTierShim(platforms, isCheck, defaultMode, fastTierValue) {
  const targets = locateServiceTierTargets(platforms);
  if (targets.length === 0) {
    console.log("  [skip] No index chunk found for service tier shim");
    return 0;
  }

  const shim = serviceTierShim(defaultMode, fastTierValue);
  let patched = 0;

  for (const bundle of targets) {
    const source = fs.readFileSync(bundle.path, "utf-8");
    const label = `[${bundle.platform}] ${relPath(bundle.path)}`;
    const replaced = replaceExistingShim(source, shim);

    if (replaced === source) {
      console.log(`  [ok] ${label}: service tier shim already current`);
      continue;
    }

    if (isCheck) {
      const action = replaced == null ? "append" : "update";
      console.log(
        `  [?] ${label}: would ${action} service tier shim (default=${defaultMode}, fast=${fastTierValue})`,
      );
      patched += 1;
      continue;
    }

    const next = replaced == null ? `${source}\n${shim}` : replaced;
    fs.writeFileSync(bundle.path, next, "utf-8");
    console.log(
      `  [ok] ${label}: service tier shim ${replaced == null ? "injected" : "updated"} (default=${defaultMode}, fast=${fastTierValue})`,
    );
    patched += 1;
  }

  return patched;
}

function main() {
  const args = process.argv.slice(2);
  const isCheck = args.includes("--check");
  const platform = args.find((a) =>
    ["mac-arm64", "mac-x64", "win"].includes(a),
  );

  const platforms = platform
    ? [platform]
    : ["mac-arm64", "mac-x64", "win"].filter((p) =>
        fs.existsSync(path.join(SRC_DIR, p, "_asar", "webview", "assets")),
      );
  const defaultServiceTierMode = normalizeServiceTierMode(
    argValue(args, "service-tier") ||
      process.env.CODEX_REBUILD_SERVICE_TIER_MODE ||
      process.env.CODEX_REBUILD_FAST_SERVICE_TIER_MODE ||
      "inherit",
  );
  const fastServiceTierValue = normalizeFastServiceTierValue(
    argValue(args, "fast-service-tier") ||
      process.env.CODEX_REBUILD_FAST_SERVICE_TIER_VALUE ||
      "priority",
  );

  const targets = [];
  for (const plat of platforms) {
    const assetsDir = path.join(SRC_DIR, plat, "_asar", "webview", "assets");
    if (!fs.existsSync(assetsDir)) continue;
    for (const f of fs.readdirSync(assetsDir)) {
      if (!f.endsWith(".js")) continue;
      const fp = path.join(assetsDir, f);
      const src = fs.readFileSync(fp, "utf-8");
      if (
        src.includes("fast_mode") &&
        (src.includes("authMethod") ||
          src.includes("statsig_default_enable_features"))
      ) {
        targets.push({ platform: plat, path: fp });
      }
    }
  }

  if (targets.length === 0) {
    console.log("  [skip] No chunk contains fast_mode gate logic");
  } else {
    let totalPatched = 0;

    for (const bundle of targets) {
      const source = fs.readFileSync(bundle.path, "utf-8");

      const t0 = Date.now();
      let astPatches = [];
      try {
        const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
        astPatches = collectPatches(ast, source);
      } catch {
        // The statsig gate patch is regex-based and can still run on minified
        // chunks even when acorn cannot parse a particular bundle.
      }

      const patches = mergePatches(
        astPatches,
        collectStatsigFastGatePatches(source),
      );

      if (patches.length === 0) continue;

      console.log(
        `  [${bundle.platform}] ${relPath(bundle.path)} (parse ${Date.now() - t0}ms)`,
      );

      if (isCheck) {
        for (const p of patches) {
          console.log(`    [?] offset ${p.start}: ${p.original} -> ${p.replacement}`);
        }
        continue;
      }

      patches.sort((a, b) => b.start - a.start);

      let code = source;
      for (const p of patches) {
        console.log(`    * ${p.original} -> ${p.replacement}`);
        code = code.slice(0, p.start) + p.replacement + code.slice(p.end);
      }

      fs.writeFileSync(bundle.path, code, "utf-8");
      totalPatched += patches.length;
    }

    if (totalPatched > 0) {
      console.log(`  [ok] ${totalPatched} fast mode gate(s) patched`);
    } else {
      console.log("  [ok] fast_mode gates already patched or absent");
    }
  }

  injectServiceTierShim(
    platforms,
    isCheck,
    defaultServiceTierMode,
    fastServiceTierValue,
  );
}

main();

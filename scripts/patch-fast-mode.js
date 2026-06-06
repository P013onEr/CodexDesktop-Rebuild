#!/usr/bin/env node
/**
 * Post-build patch: Force-enable native Fast mode (speed selector).
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
 */
const fs = require("fs");
const path = require("path");
const { parse } = require("acorn");
const { relPath, SRC_DIR } = require("./patch-util");

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

function collectNativeFastAuthPatches(ast, source) {
  const patches = [];
  if (!source.includes("fast_mode")) return patches;

  walk(ast, (node) => {
    if (node.type !== "BinaryExpression") return;
    if (!["!==", "!=", "===", "=="].includes(node.operator)) return;

    const expr = source.slice(node.start, node.end);
    if (!expr.includes("authMethod") || !expr.includes("chatgpt")) return;
    if (expr === "!0" || expr === "!1") return;

    patches.push({
      id: "native_fast_auth_gate",
      start: node.start,
      end: node.end,
      replacement: node.operator.startsWith("!") ? "!1" : "!0",
      original: expr,
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

function collectGenericStatsigFastModePatches(source) {
  const ident = String.raw`[A-Za-z_$][A-Za-z0-9_$]*`;
  const fastExpr = new RegExp(
    String.raw`(${ident}\??\.fast_mode===!0&&${ident}\(${ident}\))`,
    "g",
  );
  const patches = [];

  if (!source.includes("fast_mode") || !source.includes("statsig_default_enable_features")) {
    return patches;
  }

  for (const match of source.matchAll(fastExpr)) {
    patches.push({
      id: "native_fast_statsig_gate",
      start: match.index,
      end: match.index + match[1].length,
      replacement: "!0",
      original: match[1],
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
      let nativeAuthPatches = [];
      try {
        const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
        astPatches = collectPatches(ast, source);
        nativeAuthPatches = collectNativeFastAuthPatches(ast, source);
      } catch {
        // The statsig gate patch is regex-based and can still run on minified
        // chunks even when acorn cannot parse a particular bundle.
      }

      const patches = mergePatches(
        astPatches,
        nativeAuthPatches,
        collectStatsigFastGatePatches(source),
        collectGenericStatsigFastModePatches(source),
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

}

main();

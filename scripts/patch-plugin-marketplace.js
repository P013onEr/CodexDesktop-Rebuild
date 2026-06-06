#!/usr/bin/env node
/**
 * Post-build patch: inject a runtime plugin marketplace unlock shim.
 *
 * Codex++ does this through CDP renderer injection. This rebuild patch appends
 * a small guarded IIFE to the webview entry chunk instead, so the app can:
 *   1. expose the plugin nav entry for non-ChatGPT auth modes,
 *   2. expand plugin marketplace list requests,
 *   3. bypass known official marketplace visibility filters,
 *   4. clear disabled install button state in the renderer.
 *
 * This is a client-side unlock only. Server-side account rollout/entitlement
 * checks can still reject plugins that the account is not allowed to install.
 */
const fs = require("fs");
const path = require("path");
const { SRC_DIR, relPath } = require("./patch-util");

const MARKER = "codex-rebuild-plugin-marketplace-unlock-v1";

function runtimeShim() {
  return `
/* ${MARKER} */
;(() => {
  const VERSION = "${MARKER}";
  if (typeof window === "undefined" || window.__codexRebuildPluginMarketplaceUnlock === VERSION) return;
  window.__codexRebuildPluginMarketplaceUnlock = VERSION;

  const MARKETPLACE_ALIASES = {
    "openai-bundled": "oai-bundled",
    "openai-curated": "oai-curated",
    "openai-primary-runtime": "oai-runtime",
  };
  const LEGACY_MARKETPLACE_ALIASES = {
    "codex-rebuild-openai-bundled": "openai-bundled",
    "codex-rebuild-openai-curated": "openai-curated",
    "codex-rebuild-openai-primary-runtime": "openai-primary-runtime",
  };
  const MARKETPLACE_LABELS = {
    "openai-bundled": "OAI Built-in",
    "openai-curated": "OAI Curated",
    "openai-primary-runtime": "OAI Runtime",
  };
  const OFFICIAL_MARKETPLACES = new Set([
    ...Object.keys(MARKETPLACE_ALIASES),
    ...Object.values(MARKETPLACE_ALIASES),
    ...Object.keys(LEGACY_MARKETPLACE_ALIASES),
  ]);
  const DISABLED_INSTALL_SELECTOR = [
    "button:disabled",
    "button[aria-disabled=\\"true\\"]",
    "[role=\\"button\\"][aria-disabled=\\"true\\"]",
    "button[data-disabled]",
    "[role=\\"button\\"][data-disabled]",
    "button.cursor-not-allowed",
    "[role=\\"button\\"].cursor-not-allowed",
    "button.pointer-events-none",
    "[role=\\"button\\"].pointer-events-none",
  ].join(", ");

  function log(event, payload = {}) {
    const events = window.__codexRebuildPluginMarketplaceEvents || [];
    events.push({ event, payload, at: Date.now() });
    window.__codexRebuildPluginMarketplaceEvents = events.slice(-50);
  }

  function restoreMarketplaceName(name) {
    const raw = String(name || "");
    if (LEGACY_MARKETPLACE_ALIASES[raw]) return LEGACY_MARKETPLACE_ALIASES[raw];
    for (const [official, alias] of Object.entries(MARKETPLACE_ALIASES)) {
      if (raw === alias) return official;
    }
    return raw;
  }

  function officialMarketplaceName(name) {
    return OFFICIAL_MARKETPLACES.has(restoreMarketplaceName(name));
  }

  function aliasMarketplaceName(name) {
    const restored = restoreMarketplaceName(name);
    return MARKETPLACE_ALIASES[restored] || restored;
  }

  function displayNameForMarketplace(name, fallback) {
    const restored = restoreMarketplaceName(name);
    if (MARKETPLACE_LABELS[restored]) return MARKETPLACE_LABELS[restored];
    return fallback || name;
  }

  function patchMarketplaceObject(marketplace) {
    if (!marketplace || typeof marketplace !== "object" || marketplace.__codexRebuildMarketplacePatched) return false;
    const currentName = String(marketplace.name || marketplace.marketplaceName || "");
    if (!officialMarketplaceName(currentName)) return false;
    const nextName = aliasMarketplaceName(currentName);
    const displayName = displayNameForMarketplace(nextName, marketplace.displayName || marketplace.title || marketplace.label || nextName);
    marketplace.name = nextName;
    marketplace.displayName = displayName;
    marketplace.title = displayName;
    marketplace.label = displayName;
    if (marketplace.interface && typeof marketplace.interface === "object") {
      marketplace.interface = { ...marketplace.interface, displayName, name: displayName, title: displayName, label: displayName };
    } else {
      marketplace.interface = { displayName, name: displayName, title: displayName, label: displayName };
    }
    marketplace.__codexRebuildMarketplacePatched = true;
    return true;
  }

  function isKnownBuildFlavorFilter(callback, sample) {
    if (!Array.isArray(sample) || sample.length === 0 || typeof callback !== "function") return false;
    let source = "";
    try { source = Function.prototype.toString.call(callback); } catch { return false; }
    if (!source.includes("marketplaceName")) return false;
    if (!sample.some((plugin) => officialMarketplaceName(plugin?.marketplaceName))) return false;
    return sample.some((plugin) => officialMarketplaceName(plugin?.marketplaceName) && !callback(plugin));
  }

  function isKnownMarketplaceHiddenFilter(callback, sample) {
    if (!Array.isArray(sample) || sample.length === 0 || typeof callback !== "function") return false;
    let source = "";
    try { source = Function.prototype.toString.call(callback); } catch { return false; }
    if (!source.includes(".includes") && !source.includes("includes(")) return false;
    if (!sample.some((marketplace) => officialMarketplaceName(marketplace?.name))) return false;
    return sample.some((marketplace) => officialMarketplaceName(marketplace?.name) && !callback(marketplace));
  }

  function installFilterPatch() {
    const originalFilter = Array.prototype.__codexRebuildOriginalFilter || Array.prototype.filter;
    if (!Array.prototype.__codexRebuildOriginalFilter) {
      Object.defineProperty(Array.prototype, "__codexRebuildOriginalFilter", {
        value: originalFilter,
        configurable: true,
        writable: true,
      });
    }
    if (Array.prototype.filter.__codexRebuildPluginMarketplacePatch === VERSION) return;
    const patchedFilter = function codexRebuildPluginMarketplaceFilter(callback, thisArg) {
      if (isKnownBuildFlavorFilter(callback, this)) {
        log("plugin_build_flavor_filter_bypassed", { count: this.length });
        return Array.from(this);
      }
      if (isKnownMarketplaceHiddenFilter(callback, this)) {
        log("plugin_marketplace_hidden_filter_bypassed", { count: this.length });
        return Array.from(this);
      }
      return originalFilter.call(this, callback, thisArg);
    };
    patchedFilter.__codexRebuildPluginMarketplacePatch = VERSION;
    Array.prototype.filter = patchedFilter;
    log("filter_patch_installed");
  }

  function assetUrl(namePart) {
    const urls = [
      ...Array.from(document.scripts || []).map((script) => script.src),
      ...Array.from(document.querySelectorAll("link[href]") || []).map((link) => link.href),
      ...performance.getEntriesByType("resource").map((entry) => entry.name),
    ].filter(Boolean);
    return urls.find((url) => url.includes("/assets/") && url.includes(namePart) && url.split("?")[0].endsWith(".js")) || "";
  }

  const modulePromises = new Map();
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

  function requestMethod(method, params) {
    if (method === "send-cli-request-for-host" && params?.method) return String(params.method);
    return String(method || "");
  }

  function patchListPluginParams(params) {
    if (!params || typeof params !== "object") return params;
    const next = { ...params };
    if (Object.prototype.hasOwnProperty.call(next, "marketplaceKinds")) delete next.marketplaceKinds;
    return next;
  }

  function restoreRequestParams(method, params) {
    if (!params || typeof params !== "object") return params;
    let next = params;
    if (Array.isArray(params.marketplaceKinds)) {
      next = {
        ...next,
        marketplaceKinds: Array.from(new Set(params.marketplaceKinds.map((kind) => {
          if (kind === "remote:openai-curated") return "openai-curated";
          return restoreMarketplaceName(kind);
        }))),
      };
    }
    if (method === "install-plugin") {
      next = next === params ? { ...params } : { ...next };
      if (next.remoteMarketplaceName) next.remoteMarketplaceName = restoreMarketplaceName(next.remoteMarketplaceName);
      if (typeof next.marketplacePath === "string" && next.marketplacePath.startsWith("remote:")) {
        const remoteMarketplaceName = next.marketplacePath.slice("remote:".length);
        delete next.marketplacePath;
        next.remoteMarketplaceName = restoreMarketplaceName(remoteMarketplaceName);
      }
    }
    return next;
  }

  function patchRequestParams(method, params) {
    const restored = restoreRequestParams(method, params);
    if (method === "list-plugins") return patchListPluginParams(restored);
    return restored;
  }

  function patchMarketplaceResult(method, result) {
    if (method !== "list-plugins") return result;
    let patched = 0;
    try {
      if (Array.isArray(result?.marketplaces)) {
        for (const marketplace of result.marketplaces) {
          if (patchMarketplaceObject(marketplace)) patched += 1;
        }
      }
      log("plugin_marketplace_response_patched", { patched });
    } catch (error) {
      log("plugin_marketplace_response_patch_failed", { message: String(error?.message || error) });
    }
    return result;
  }

  function patchRequestClient(client) {
    if (!client || typeof client.sendRequest !== "function") return false;
    if (client.__codexRebuildPluginMarketplaceRequestPatch === VERSION) return true;
    const originalSendRequest = client.__codexRebuildOriginalSendRequest || client.sendRequest.bind(client);
    client.__codexRebuildOriginalSendRequest = originalSendRequest;
    client.sendRequest = async function codexRebuildPatchedSendRequest(method, params, options) {
      const realMethod = requestMethod(String(method || ""), params);
      const requestParams = patchRequestParams(realMethod, params);
      const result = await originalSendRequest(method, requestParams, options);
      return patchMarketplaceResult(realMethod, result);
    };
    client.__codexRebuildPluginMarketplaceRequestPatch = VERSION;
    return true;
  }

  async function installRequestPatch() {
    try {
      const module = await loadAppModule("app-server-manager-signals-");
      const candidates = Object.values(module).filter((value) => value && typeof value === "object");
      let patched = 0;
      for (const candidate of candidates) {
        if (patchRequestClient(candidate)) patched += 1;
        if (typeof candidate.sendRequest !== "function" && typeof candidate.get === "function") {
          try {
            if (patchRequestClient(candidate.get())) patched += 1;
          } catch {}
        }
      }
      log("request_patch_installed", { candidates: candidates.length, patched });
    } catch (error) {
      log("request_patch_failed", { message: String(error?.message || error) });
    }
  }

  function reactFiberFrom(element) {
    const key = Object.keys(element || {}).find((name) => name.startsWith("__reactFiber"));
    return key ? element[key] : null;
  }

  function authContextValueFrom(element) {
    for (let fiber = reactFiberFrom(element); fiber; fiber = fiber.return) {
      for (const value of [fiber.memoizedProps?.value, fiber.pendingProps?.value]) {
        if (value && typeof value === "object" && typeof value.setAuthMethod === "function" && "authMethod" in value) return value;
      }
    }
    return null;
  }

  function spoofChatGptAuthMethod(element) {
    const auth = authContextValueFrom(element);
    if (!auth || auth.authMethod === "chatgpt") return false;
    auth.setAuthMethod("chatgpt");
    return true;
  }

  function pluginEntryButton() {
    const byIcon = document.querySelector('nav[role="navigation"] button svg path[d^="M7.94562 14.0277"]')?.closest("button");
    if (byIcon) return byIcon;
    return Array.from(document.querySelectorAll('nav[role="navigation"] button, button'))
      .find((button) => /^(\\u63d2\\u4ef6|Plugins)(\\s+-\\s+.*)?$/i.test((button.textContent || "").trim())) || null;
  }

  function enablePluginEntry() {
    const button = pluginEntryButton();
    if (!button) return;
    const spoofed = spoofChatGptAuthMethod(button);
    button.disabled = false;
    button.removeAttribute("disabled");
    button.style.display = "";
    button.querySelectorAll("*").forEach((node) => { node.style.display = ""; });
    const propsKey = Object.keys(button).find((key) => key.startsWith("__reactProps"));
    if (propsKey && button[propsKey]) button[propsKey].disabled = false;
    if (button.dataset.codexRebuildPluginEnabled !== "true") {
      button.dataset.codexRebuildPluginEnabled = "true";
      button.addEventListener("click", () => spoofChatGptAuthMethod(button), true);
    }
    log("plugin_entry_unlock_applied", { spoofed });
  }

  function patchReactDisabledProps(element) {
    Object.keys(element || {}).filter((key) => key.startsWith("__reactProps")).forEach((key) => {
      const props = element[key];
      if (!props || typeof props !== "object") return;
      props.disabled = false;
      props["aria-disabled"] = false;
      props["data-disabled"] = undefined;
    });
  }

  function clearDisabledState(element) {
    if (!(element instanceof HTMLElement)) return;
    if ("disabled" in element) element.disabled = false;
    element.removeAttribute("disabled");
    element.removeAttribute("aria-disabled");
    element.removeAttribute("data-disabled");
    element.removeAttribute("inert");
    element.classList.remove("disabled", "opacity-50", "cursor-not-allowed", "pointer-events-none");
    element.classList.add("codex-rebuild-force-install-unlocked");
    element.style.pointerEvents = "auto";
    element.style.opacity = "";
    element.style.cursor = "pointer";
    element.tabIndex = 0;
    patchReactDisabledProps(element);
  }

  function installButtonText(element) {
    return (element.textContent || "").trim();
  }

  function isInstallButtonText(text) {
    return /^\\u5b89\\u88c5\\s*/.test(text) || /^Install\\s*/i.test(text) || text === "Force Install";
  }

  function unlockNodes(button) {
    const nodes = [button];
    button.querySelectorAll?.("button, [role='button'], [disabled], [aria-disabled], [data-disabled], .cursor-not-allowed, .pointer-events-none")
      .forEach((node) => nodes.push(node));
    let parent = button.parentElement;
    for (let depth = 0; parent && depth < 3; depth += 1, parent = parent.parentElement) {
      if (parent.matches?.("button, [role='button'], [disabled], [aria-disabled], [data-disabled], .cursor-not-allowed, .pointer-events-none")) nodes.push(parent);
    }
    return Array.from(new Set(nodes));
  }

  function labelForceInstall(button) {
    const walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (isInstallButtonText((node.nodeValue || "").trim())) {
        node.nodeValue = "Force Install";
        return;
      }
    }
  }

  function unlockInstallButton(button) {
    unlockNodes(button).forEach(clearDisabledState);
    if (button.dataset.codexRebuildForceInstallUnlocked !== "true") {
      button.dataset.codexRebuildForceInstallUnlocked = "true";
      const keepUnlocked = () => unlockNodes(button).forEach(clearDisabledState);
      ["pointerdown", "mousedown", "mouseup", "click", "focus"].forEach((eventName) => {
        button.addEventListener(eventName, keepUnlocked, true);
      });
    }
    labelForceInstall(button);
  }

  function unlockInstallButtons() {
    Array.from(document.querySelectorAll(DISABLED_INSTALL_SELECTOR)).forEach((node) => {
      const button = node.closest?.("button, [role='button']") || node;
      if (!isInstallButtonText(installButtonText(button))) return;
      unlockInstallButton(button);
    });
  }

  function scan() {
    enablePluginEntry();
    unlockInstallButtons();
  }

  installFilterPatch();
  void installRequestPatch();
  scan();
  setInterval(scan, 1500);
  setInterval(() => void installRequestPatch(), 5000);
})();
`;
}

function platformDirs(platform) {
  const all = ["mac-arm64", "mac-x64", "win"];
  const platforms = platform ? [platform] : all;
  return platforms.filter((plat) =>
    fs.existsSync(path.join(SRC_DIR, plat, "_asar", "webview", "assets")),
  );
}

function locateTargets(platform) {
  const targets = [];
  for (const plat of platformDirs(platform)) {
    const assetsDir = path.join(SRC_DIR, plat, "_asar", "webview", "assets");
    const files = fs.readdirSync(assetsDir).filter((file) => /^index-.*\.js$/.test(file));
    if (files.length === 0) {
      console.warn(`  [!] ${plat}: no index-*.js entry chunk found`);
      continue;
    }
    for (const file of files) {
      targets.push({ platform: plat, path: path.join(assetsDir, file) });
    }
  }
  return targets;
}

function main() {
  const args = process.argv.slice(2);
  const isCheck = args.includes("--check");
  const platform = args.find((arg) => ["mac-arm64", "mac-x64", "win"].includes(arg));
  const targets = locateTargets(platform);

  if (targets.length === 0) {
    console.log("[skip] No webview entry chunks found for plugin marketplace unlock");
    return;
  }

  const shim = runtimeShim();
  let patched = 0;

  for (const target of targets) {
    const source = fs.readFileSync(target.path, "utf-8");
    const label = `[${target.platform}] ${relPath(target.path)}`;
    if (source.includes(MARKER)) {
      console.log(`  [ok] ${label}: already injected`);
      continue;
    }
    if (isCheck) {
      console.log(`  [?] ${label}: would append plugin marketplace runtime unlock`);
      patched += 1;
      continue;
    }
    fs.writeFileSync(target.path, `${source}\n${shim}`, "utf-8");
    console.log(`  [ok] ${label}: injected plugin marketplace runtime unlock`);
    patched += 1;
  }

  if (isCheck) {
    console.log(`  [?] patchable entry chunks: ${patched}`);
  } else {
    console.log(`  [ok] plugin marketplace unlock injected into ${patched} entry chunk(s)`);
  }
}

main();

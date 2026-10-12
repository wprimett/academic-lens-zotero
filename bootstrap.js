/* eslint-disable no-undef */

var chromeHandle;

function install(data, reason) {}

async function startup({ id, version, resourceURI, rootURI }, reason) {
  await Zotero.initializationPromise;

  if (!rootURI) {
    rootURI = resourceURI.spec;
  }
  if (!rootURI.endsWith("/")) {
    rootURI += "/";
  }

  var aomStartup = Components.classes[
    "@mozilla.org/addons/addon-manager-startup;1"
  ].getService(Components.interfaces.amIAddonManagerStartup);
  var manifestURI = Services.io.newURI(rootURI + "manifest.json");
  chromeHandle = aomStartup.registerChrome(manifestURI, [
    ["content", "academic-lens", rootURI + "content/"],
  ]);

  const ctx = {
    rootURI,
  };
  ctx._globalThis = ctx;

  Services.scriptloader.loadSubScript(
    `${rootURI}content/academic-lens.js`,
    ctx,
  );

  try {
    await Zotero.AcademicLens?.onStartup?.({ id, version, rootURI });
  } catch (error) {
    Zotero.logError(error);
  }

  // Initialize for all already-opened windows
  const windows = Zotero.getMainWindows ? Zotero.getMainWindows() : [];
  if (windows.length > 0) {
    for (const win of windows) {
      try {
        await Zotero.AcademicLens?.onMainWindowLoad?.(win);
      } catch (err) {
        Zotero.logError(err);
      }
    }
  } else if (typeof Zotero.getMainWindow === "function" && Zotero.getMainWindow()) {
    try {
      await Zotero.AcademicLens?.onMainWindowLoad?.(Zotero.getMainWindow());
    } catch (err) {
      Zotero.logError(err);
    }
  }
}

async function onMainWindowLoad({ window }, reason) {
  try {
    await Zotero.AcademicLens?.onMainWindowLoad?.(window);
  } catch (error) {
    Zotero.logError(error);
  }
}

async function onMainWindowUnload({ window }, reason) {
  try {
    await Zotero.AcademicLens?.onMainWindowUnload?.(window);
  } catch (error) {
    Zotero.logError(error);
  }
}

async function shutdown({ id, version, resourceURI, rootURI }, reason) {
  if (typeof Zotero === "undefined") {
    Zotero = Components.classes["@zotero.org/Zotero;1"].getService(
      Components.interfaces.nsISupports,
    ).wrappedJSObject;
  }
  try {
    await Zotero.AcademicLens?.onShutdown?.();
  } catch (err) {
    Zotero.logError(err);
  } finally {
    if (chromeHandle) {
      try {
        chromeHandle.destruct();
        chromeHandle = null;
      } catch (_) {}
    }
    try {
      delete Zotero.AcademicLens;
    } catch (_) {}
  }
}

function uninstall(data, reason) {}

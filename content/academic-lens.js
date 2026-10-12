/**
 * Academic Lens - Zotero 7 Addon
 * Local AI Research Assistant powered by Qwen.
 *
 * Key implementation note (XUL namespace pitfall):
 *   Zotero's item pane is a XUL <vbox>. If you call vbox.innerHTML = "...",
 *   Gecko parses child elements into the XUL namespace where <div> / <button>
 *   have no HTML layout, so flex/height rules are silently ignored and you see
 *   only native widgets (e.g. <textarea>). The fix (same as Beaver's ui.ts:78):
 *     1. createXULElement("vbox") — outer shell lives in XUL layout
 *     2. createElement("div")    — HTML namespace div, append to vbox
 *     3. set innerHTML on the HTML div → all children parse as HTML
 */

/* eslint-disable no-undef */

if (typeof Zotero === "undefined") {
  Zotero = Components.classes["@zotero.org/Zotero;1"].getService(
    Components.interfaces.nsISupports
  ).wrappedJSObject;
}

Zotero.AcademicLens = {
  // Configuration
  DEFAULT_ENDPOINT: "http://77.42.92.200:18181/",
  DEFAULT_MODEL: "Llama-3.2-3B-Instruct-Q4_K_M",
  FALLBACK_MODEL: "Qwen3.5-4B-Q4_K_S",
  DEFAULT_MAX_TOKENS: 800,

  endpoint: "http://77.42.92.200:18181/",
  modelName: "Llama-3.2-3B-Instruct-Q4_K_M",
  maxTokens: 800,

  // State
  rootURI: null,
  windows: new Map(),      // win → { isOpen: boolean }
  selectedDocuments: [],   // [{ id, title, authors, year, abstract, url, display }]
  chatHistory: [],         // [{ role, content }]
  abortController: null,
  isGenerating: false,
  stylesheetRegistered: false,
  connectionEnabled: true,

  /* ============================================================
     Lifecycle
  ============================================================ */

  async onStartup({ id, version, rootURI }) {
    this.rootURI = rootURI;
    this.loadSettings();
    this.registerGlobalStylesheet();
    this.registerPreferencesPane(id, rootURI);
    this.registerTabObserver();
    Zotero.debug("[AcademicLens] Addon started. Endpoint: " + this.endpoint);
  },


  async onShutdown() {
    this.unregisterTabObserver();
    this.unregisterGlobalStylesheet();
    for (const [win] of this.windows) {
      this.cleanupWindow(win);
    }
    this.windows.clear();
    Zotero.debug("[AcademicLens] Addon shut down.");
  },

  registerGlobalStylesheet() {
    try {
      const ssService = Components.classes["@mozilla.org/content/style-sheet-service;1"]
        .getService(Components.interfaces.nsIStyleSheetService);
      const styleURI = Services.io.newURI("chrome://academic-lens/content/style.css");
      if (!ssService.sheetRegistered(styleURI, Components.interfaces.nsIStyleSheetService.AUTHOR_SHEET)) {
        ssService.loadAndRegisterSheet(styleURI, Components.interfaces.nsIStyleSheetService.AUTHOR_SHEET);
        this.stylesheetRegistered = true;
        Zotero.debug("[AcademicLens] Registered global stylesheet via nsIStyleSheetService");
      }
    } catch (err) {
      Zotero.debug("[AcademicLens] Failed to register global stylesheet: " + err);
    }
  },

  unregisterGlobalStylesheet() {
    if (!this.stylesheetRegistered) return;
    try {
      const ssService = Components.classes["@mozilla.org/content/style-sheet-service;1"]
        .getService(Components.interfaces.nsIStyleSheetService);
      const styleURI = Services.io.newURI("chrome://academic-lens/content/style.css");
      if (ssService.sheetRegistered(styleURI, Components.interfaces.nsIStyleSheetService.AUTHOR_SHEET)) {
        ssService.unregisterSheet(styleURI, Components.interfaces.nsIStyleSheetService.AUTHOR_SHEET);
      }
      this.stylesheetRegistered = false;
    } catch (err) {
      Zotero.debug("[AcademicLens] Failed to unregister stylesheet: " + err);
    }
  },

  async onMainWindowLoad(win) {
    if (!win || win.closed || !win.document) return;

    try {
      if (Zotero.initializationPromise) await Zotero.initializationPromise;
      if (Zotero.unlockPromise)         await Zotero.unlockPromise;
      if (Zotero.uiReadyPromise)        await Zotero.uiReadyPromise;
    } catch (e) {
      Zotero.debug("[AcademicLens] Promise wait warning: " + e);
    }

    if (win.document.readyState === "loading") {
      win.addEventListener("DOMContentLoaded", () => this.initWindowWithRetry(win), { once: true });
      win.addEventListener("load",             () => this.initWindowWithRetry(win), { once: true });
    } else {
      await this.initWindowWithRetry(win);
    }
  },

  async initWindowWithRetry(win, retries = 30) {
    if (!win || win.closed || !win.document) return;

    const toolbar     = win.document.getElementById("zotero-tabs-toolbar");
    const itemPane    = win.document.getElementById("zotero-item-pane");
    const contextPane = win.document.getElementById("zotero-context-pane");

    if ((!toolbar || (!itemPane && !contextPane)) && retries > 0) {
      win.setTimeout(() => this.initWindowWithRetry(win, retries - 1), 200);
      return;
    }

    this.initWindowUI(win);
  },

  initWindowUI(win) {
    if (this.windows.has(win)) return;
    this.windows.set(win, { isOpen: false });

    Zotero.debug("[AcademicLens] Initializing window UI...");

    const step = (name, fn) => {
      try { fn(); }
      catch (err) {
        Zotero.debug(`[AcademicLens] ${name} FAILED: ${err}\n${err && err.stack}`);
        Zotero.logError(err);
      }
    };

    step("addToolbarButton",    () => this.addToolbarButton(win));
    step("addToolsMenuItem",    () => this.addToolsMenuItem(win));
    step("addContextMenuItems", () => this.addContextMenuItems(win));
    step("setupSidebar",        () => this.setupSidebar(win));

    // Open automatically so user sees the panel right away
    step("toggleSidebar",       () => this.toggleSidebar(win, true));
    // Zotero may restore a persisted collapsed item pane after load; re-open once settled
    win.setTimeout(() => step("toggleSidebar(delayed)", () => this.toggleSidebar(win, true)), 1500);
  },

  async onMainWindowUnload(win) {
    this.cleanupWindow(win);
    this.windows.delete(win);
  },

  cleanupWindow(win) {
    if (!win || !win.document) return;
    try {
      this.unobserveItemPane(win);
      win.document.getElementById("zotero-academic-lens-tb-toggle")?.remove();
      win.document.getElementById("menu-academic-lens")?.remove();
      win.document.getElementById("menu-academic-lens-prefs")?.remove();
      win.document.getElementById("context-academic-lens-add")?.remove();
      win.document.getElementById("academic-lens-pane-library")?.remove();
      win.document.getElementById("academic-lens-pane-reader")?.remove();

      // Restore native item-pane children
      const itemPane = win.document.getElementById("zotero-item-pane");
      if (itemPane) {
        for (const child of itemPane.children) {
          if (child.id !== "academic-lens-pane-library") {
            child.style.removeProperty("display");
          }
        }
      }

      const contextPane = win.document.getElementById("zotero-context-pane");
      if (contextPane) {
        for (const child of contextPane.children) {
          if (child.id !== "academic-lens-pane-reader") {
            child.style.removeProperty("display");
          }
        }
      }
    } catch (err) {
      Zotero.debug("[AcademicLens] Error during window cleanup: " + err);
    }
  },

  observeItemPane(win) {
    if (this._itemPaneObservers?.has(win)) return;
    if (!this._itemPaneObservers) this._itemPaneObservers = new Map();

    const domItemPane = win.document.getElementById("zotero-item-pane");
    if (!domItemPane) return;

    try {
      const observer = new win.MutationObserver(() => {
        const winState = this.windows.get(win);
        if (!winState || !winState.isOpen) return;

        const alPane = win.document.getElementById("academic-lens-pane-library");
        if (!alPane || alPane.style.display === "none") return;

        for (const child of domItemPane.children) {
          if (child !== alPane && child.style.display !== "none") {
            child.style.display = "none";
          }
        }

        if (domItemPane.collapsed) {
          domItemPane.collapsed = false;
          domItemPane.removeAttribute("collapsed");
        }
      });

      observer.observe(domItemPane, { childList: true, subtree: false });
      this._itemPaneObservers.set(win, observer);
    } catch (_) {}
  },

  unobserveItemPane(win) {
    const obs = this._itemPaneObservers?.get(win);
    if (obs) {
      obs.disconnect();
      this._itemPaneObservers.delete(win);
    }
  },

  /* ============================================================
     UI Injection
  ============================================================ */

  addToolbarButton(win) {
    const toolbar = win.document.getElementById("zotero-tabs-toolbar");
    if (!toolbar) return;
    if (win.document.getElementById("zotero-academic-lens-tb-toggle")) return;

    const btn = win.document.createXULElement("toolbarbutton");
    btn.setAttribute("id", "zotero-academic-lens-tb-toggle");
    btn.setAttribute("class", "zotero-tb-button");
    btn.setAttribute("tooltiptext", "Toggle Academic Lens");
    btn.setAttribute("aria-label", "Toggle Academic Lens");
    btn.setAttribute("aria-pressed", "false");
    btn.setAttribute("tabindex", "0");
    // XUL toolbarbutton list-style-image picks up the icon in most themes
    btn.setAttribute("image", "chrome://academic-lens/content/icons/icon.png");
    btn.style.listStyleImage = "url('chrome://academic-lens/content/icons/icon.png')";

    // Explicit <image> child guarantees the icon renders even when CSS is absent
    const img = win.document.createXULElement("image");
    img.setAttribute("src", "chrome://academic-lens/content/icons/icon.png");
    img.setAttribute("width", "18");
    img.setAttribute("height", "18");
    btn.appendChild(img);

    btn.addEventListener("command", () => this.toggleSidebar(win));

    const syncBtn = toolbar.querySelector("#zotero-tb-sync");
    if (syncBtn) {
      toolbar.insertBefore(btn, syncBtn);
    } else {
      toolbar.appendChild(btn);
    }

    Zotero.debug("[AcademicLens] Toolbar button injected.");
  },

  addToolsMenuItem(win) {
    const toolsPopup = win.document.getElementById("menu_ToolsPopup");
    if (!toolsPopup || win.document.getElementById("menu-academic-lens")) return;

    const mi = win.document.createXULElement("menuitem");
    mi.setAttribute("id", "menu-academic-lens");
    mi.setAttribute("label", "Academic Lens");
    mi.setAttribute("image", "chrome://academic-lens/content/icons/icon.png");
    mi.setAttribute("class", "menuitem-iconic");
    mi.addEventListener("command", () => this.toggleSidebar(win));
    toolsPopup.appendChild(mi);

    const miPrefs = win.document.createXULElement("menuitem");
    miPrefs.setAttribute("id", "menu-academic-lens-prefs");
    miPrefs.setAttribute("label", "Academic Lens Settings…");
    miPrefs.setAttribute("class", "menuitem-iconic");
    miPrefs.addEventListener("command", () => this.openSettingsWindow(win));
    toolsPopup.appendChild(miPrefs);
  },

  addContextMenuItems(win) {
    const itemMenu = win.document.getElementById("zotero-itemmenu");
    if (!itemMenu || win.document.getElementById("context-academic-lens-add")) return;

    const mi = win.document.createXULElement("menuitem");
    mi.setAttribute("id", "context-academic-lens-add");
    mi.setAttribute("label", "Ask Academic Lens About Selected Item(s)");
    mi.setAttribute("image", "chrome://academic-lens/content/icons/icon.png");
    mi.setAttribute("class", "menuitem-iconic");
    mi.addEventListener("command", async () => {
      const selected = win.ZoteroPane?.getSelectedItems();
      if (selected && selected.length > 0) {
        await this.addItems(selected, win);
        this.toggleSidebar(win, true);
      }
    });
    itemMenu.appendChild(mi);
  },

  /*
   * setupSidebar — the critical rendering fix
   *
   * Beaver pattern (ui.ts lines 68-84):
   *   const mountPoint = doc.createXULElement("vbox");   ← XUL shell
   *   const reactContainer = doc.createElement("div");   ← HTML namespace
   *   mountPoint.appendChild(reactContainer);
   *   // React then writes into reactContainer, which is in HTML namespace.
   *
   * We follow the same pattern: XUL <vbox> holds an HTML <div>, all the
   * sidebar HTML goes into that div so Gecko parses it in the HTML namespace
   * and applies normal flex box / block layout.
   */
  getSidebarHTML() {
    return `
      <div class="al-header">
        <div class="al-title-area">
          <img class="al-logo" src="chrome://academic-lens/content/icons/icon.png" alt="Logo" />
          <h3 class="al-title">Academic Lens</h3>
        </div>
        <div class="al-header-actions" style="display:flex;align-items:center;gap:6px;flex-shrink:0;">
          <button id="al-btn-close" title="Close Sidebar" aria-label="Close"
            style="display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;min-width:28px;min-height:28px;padding:4px;background:none;border:none;border-radius:6px;color:#888;font-size:16px;cursor:pointer;-moz-appearance:none;box-sizing:border-box;">✕</button>
        </div>
      </div>

      <!-- ── Inline Model and Endpoint Configuration Bar ── -->
      <div class="al-config-bar" id="al-config-bar">
        <div class="al-config-header">
          <div class="al-config-title">
            <span class="al-status-dot checking" id="al-cfg-status-dot" title="Checking status…"></span>
            <span>Endpoint Status:</span>
          </div>
          <div style="display:flex;align-items:center;gap:6px;">
            <button class="al-btn-toggle-conn disconnect" id="al-btn-toggle-conn" title="Toggle connection status">Disconnect</button>
            <button class="al-btn al-btn-secondary al-btn-xs" id="al-btn-cfg-test" title="Test endpoint &amp; model">⚡ Test</button>
          </div>
        </div>

        <div class="al-config-fields">
          <div class="al-config-row">
            <input type="text" class="al-config-input" id="al-input-model"
                   value="${this.escapeHtml(this.modelName)}"
                   placeholder="Model (e.g. Llama-3.2-3B-Instruct-Q4_K_M)"
                   title="Model name matching /v1/models" />
            <select class="al-config-select" id="al-select-model" style="display:none;" title="Select available model from endpoint">
              <option value="">Select model…</option>
            </select>
          </div>
          <div class="al-config-row">
            <input type="text" class="al-config-input" id="al-input-endpoint"
                   value="${this.escapeHtml(this.endpoint)}"
                   placeholder="Endpoint (e.g. http://77.42.92.200:18181/)"
                   title="OpenAI-compatible server URL" />
          </div>
        </div>

        <div class="al-config-status-row">
          <span class="al-conn-badge checking" id="al-cfg-conn-badge">Checking connection…</span>
          <button class="al-config-toggle" id="al-btn-fetch-models" title="Refresh list of models hosted on endpoint">↻ Fetch Models</button>
        </div>

        <div class="al-conn-warning" id="al-cfg-warning"></div>
      </div>

      <div class="al-context-section">
        <div class="al-context-header">
          <span class="al-context-title">Selected Sources (<span id="al-doc-count">0</span>)</span>
          <button class="al-btn al-btn-secondary al-btn-sm" id="al-btn-add-selected">+ Add Selected</button>
        </div>
        <div class="al-drop-zone" id="al-drop-zone">
          <span class="al-drop-icon">📄</span>
          Drag articles from library here
        </div>
        <div class="al-doc-list" id="al-doc-list"></div>
      </div>

      <div class="al-messages-area" id="al-messages-area">
        <div class="al-message assistant">
          <div class="al-msg-header">Academic Lens</div>
          <div class="al-msg-content">Welcome to <b>Academic Lens</b>. Drag one or more papers from your library here, then ask a research question below.</div>
        </div>

        <div class="al-quick-prompts">
          <button class="al-quick-btn" data-prompt="Summarize the key findings of these papers.">💡 Summarize findings</button>
          <button class="al-quick-btn" data-prompt="Compare the methodologies used across these papers.">🔬 Compare methods</button>
          <button class="al-quick-btn" data-prompt="What are the main contributions of these papers?">❓ Key contributions</button>
        </div>
      </div>

      <div class="al-composer-area">
        <textarea class="al-textarea" id="al-input-query" placeholder="Ask a question about the selected papers… (Enter to send, Shift+Enter for new line)" rows="2"></textarea>
        <div class="al-composer-actions">
          <div class="al-action-group">
            <button class="al-btn al-btn-secondary" id="al-btn-clear-chat">Clear</button>
          </div>
          <div class="al-action-group">
            <button id="send-btn" title="Send question (Enter)">Send</button>
          </div>
        </div>
      </div>
    `;
  },

  createSidebarMount(win, location) {
    const paneId = location === "reader" ? "academic-lens-pane-reader" : "academic-lens-pane-library";

    // ── 1. XUL shell — integrates into Zotero's XUL layout ──────────────
    const mountVBox = win.document.createXULElement("vbox");
    mountVBox.setAttribute("id", paneId);
    mountVBox.setAttribute("flex", "1");
    mountVBox.setAttribute("class", "al-vbox-shell");
    mountVBox.style.cssText = [
      "display: none",
      "flex: 1 1 0%",
      "min-height: 0",
      "width: 100%",
      "min-width: 300px",
      "height: 100%",
    ].join("; ");

    // ── 2. HTML root — parse all children as HTML ───────────────────────
    const htmlRoot = win.document.createElement("div");
    htmlRoot.setAttribute("id", "al-html-root-" + location);
    htmlRoot.setAttribute("class", "al-html-root");
    htmlRoot.style.cssText = [
      "display: flex",
      "flex-direction: column",
      "height: 100%",
      "width: 100%",
      "min-height: 0",
      "overflow: hidden",
      "box-sizing: border-box;",
    ].join("; ");

    htmlRoot.innerHTML = this.getSidebarHTML();

    mountVBox.appendChild(htmlRoot);

    this.bindEvents(win, htmlRoot);
    this.bindDragDrop(win, mountVBox, htmlRoot);

    return mountVBox;
  },

  setupSidebar(win) {
    if (!win || win.closed || !win.document) return;

    // Clean up any existing instances first
    try {
      win.document.getElementById("academic-lens-pane-library")?.remove();
      win.document.getElementById("academic-lens-pane-reader")?.remove();
    } catch (_) {}

    const itemPane = win.document.getElementById("zotero-item-pane");
    if (itemPane) {
      const libMount = this.createSidebarMount(win, "library");
      itemPane.appendChild(libMount);
      Zotero.debug("[AcademicLens] Mounted library sidebar to #zotero-item-pane");
    }

    const contextPane = win.document.getElementById("zotero-context-pane");
    if (contextPane) {
      const rdrMount = this.createSidebarMount(win, "reader");
      contextPane.appendChild(rdrMount);
      Zotero.debug("[AcademicLens] Mounted reader sidebar to #zotero-context-pane");
    }

    this.renderDocumentChips(win);
  },

  /* ============================================================
     Event Binding
  ============================================================ */

  bindEvents(win, root) {
    // Header close
    root.querySelector("#al-btn-close")?.addEventListener("click", () => this.toggleSidebar(win, false));

    // Inline Model and Endpoint input sync
    const modelInput = root.querySelector("#al-input-model");
    const modelSelect = root.querySelector("#al-select-model");
    const epInput = root.querySelector("#al-input-endpoint");
    const toggleConnBtn = root.querySelector("#al-btn-toggle-conn");

    modelInput?.addEventListener("change", () => {
      const val = modelInput.value.trim();
      if (val) {
        this.modelName = val;
        this.saveSettings();
        if (this.connectionEnabled) {
          this.testEndpoint(root);
        }
      }
    });

    modelSelect?.addEventListener("change", () => {
      const selected = modelSelect.value;
      if (selected && modelInput) {
        modelInput.value = selected;
        this.modelName = selected;
        this.saveSettings();
        if (this.connectionEnabled) {
          this.testEndpoint(root);
        }
      }
    });

    let epDebounce = null;
    epInput?.addEventListener("input", () => {
      if (epDebounce) win.clearTimeout(epDebounce);
      epDebounce = win.setTimeout(() => {
        const val = epInput.value.trim();
        if (val) {
          this.endpoint = val;
          this.saveSettings();
          if (this.connectionEnabled) {
            this.testEndpoint(root);
          }
        }
      }, 600);
    });

    toggleConnBtn?.addEventListener("click", () => {
      this.connectionEnabled = !this.connectionEnabled;
      if (this.connectionEnabled) {
        toggleConnBtn.textContent = "Disconnect";
        toggleConnBtn.className = "al-btn-toggle-conn disconnect";
        this.testEndpoint(root);
      } else {
        toggleConnBtn.textContent = "Reconnect";
        toggleConnBtn.className = "al-btn-toggle-conn reconnect";
        this.setPausedState(root);
      }
    });

    root.querySelector("#al-btn-cfg-test")?.addEventListener("click", () => {
      this.connectionEnabled = true;
      if (toggleConnBtn) {
        toggleConnBtn.textContent = "Disconnect";
        toggleConnBtn.className = "al-btn-toggle-conn disconnect";
      }
      this.testEndpoint(root);
    });

    root.querySelector("#al-btn-fetch-models")?.addEventListener("click", () => this.fetchAndSelectModel(root));

    // Initial check on mount
    win.setTimeout(() => {
      if (this.connectionEnabled) {
        this.testEndpoint(root);
      } else {
        this.setPausedState(root);
      }
    }, 250);



    // Add selected library items
    root.querySelector("#al-btn-add-selected")?.addEventListener("click", async () => {
      try {
        const selected = win.ZoteroPane?.getSelectedItems();
        if (selected && selected.length > 0) {
          await this.addItems(selected, win);
        } else {
          this._alert(win, "No items selected in your library. Click a paper in the list first.");
        }
      } catch (err) {
        Zotero.debug("[AcademicLens] Error adding selected items: " + err);
      }
    });

    // Quick-prompt chips
    root.querySelectorAll(".al-quick-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        const prompt = btn.getAttribute("data-prompt");
        if (!prompt) return;
        const ta = root.querySelector("#al-input-query");
        if (ta) { ta.value = prompt; ta.focus(); }
      });
    });

    // Composer
    const textarea = root.querySelector("#al-input-query");
    const sendBtn  = root.querySelector("#send-btn") || root.querySelector("#al-btn-send");
    const clearBtn = root.querySelector("#al-btn-clear-chat");

    sendBtn?.addEventListener("click", () => {
      if (this.isGenerating) {
        this.abortGeneration(win);
      } else {
        this.handleSend(win);
      }
    });

    textarea?.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === "c" || e.key === "C")) {
        if (this.isGenerating) {
          const hasSelection = (textarea.selectionStart !== textarea.selectionEnd) || !!win.getSelection()?.toString();
          if (!hasSelection) {
            e.preventDefault();
            this.abortGeneration(win);
            return;
          }
        }
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (!this.isGenerating) {
          this.handleSend(win);
        }
      }
    });

    root.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === "c" || e.key === "C") && this.isGenerating) {
        const hasSelection = (textarea && textarea.selectionStart !== textarea.selectionEnd) || !!win.getSelection()?.toString();
        if (!hasSelection) {
          e.preventDefault();
          this.abortGeneration(win);
        }
      }
    });

    clearBtn?.addEventListener("click", () => {
      const area = root.querySelector("#al-messages-area");
      if (area) area.innerHTML = "";
      this.chatHistory = [];
    });
  },

  /*
   * bindDragDrop — capturing drag listeners on the whole sidebar pane.
   *
   * Beaver's DragDropWrapper (react/components/input/DragDropWrapper.tsx)
   * attaches onDragEnter / onDragOver / onDragLeave / onDrop to the outer
   * wrapper div. In plain JS we do the same thing with useCapture=true so
   * the sidebar intercepts events before any child can swallow them.
   *
   * Critical: e.preventDefault() in dragover is what tells Gecko the drop
   * target accepts the drag (otherwise dropEffect stays "none" and no drop
   * event fires at all).
   */
  bindDragDrop(win, mountVBox, htmlRoot) {
    const dropZone = htmlRoot.querySelector("#al-drop-zone");
    let dragCount = 0;   // track enter/leave pairs to handle child-element crossings

    const isZoteroItemDrag = (dt) => dt.types.includes("zotero/item");

    const onDragEnter = (e) => {
      if (!isZoteroItemDrag(e.dataTransfer)) return;
      e.preventDefault();
      e.stopPropagation();
      dragCount++;
      if (dropZone) dropZone.classList.add("drag-active");
    };

    const onDragOver = (e) => {
      if (!isZoteroItemDrag(e.dataTransfer)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "copy";
      if (dropZone && !dropZone.classList.contains("drag-active")) {
        dropZone.classList.add("drag-active");
      }
    };

    const onDragLeave = (e) => {
      if (!isZoteroItemDrag(e.dataTransfer)) return;
      e.preventDefault();
      e.stopPropagation();
      dragCount--;
      if (dragCount <= 0) {
        dragCount = 0;
        if (dropZone) dropZone.classList.remove("drag-active");
      }
    };

    const onDrop = async (e) => {
      if (!isZoteroItemDrag(e.dataTransfer)) return;
      e.preventDefault();
      e.stopPropagation();
      dragCount = 0;
      if (dropZone) dropZone.classList.remove("drag-active");

      // Parse comma-separated item IDs from the drag data
      const rawIDs = e.dataTransfer.getData("zotero/item");
      if (rawIDs) {
        const ids = rawIDs.split(",")
          .map(s => parseInt(s.trim(), 10))
          .filter(n => !isNaN(n));
        if (ids.length > 0) {
          await this.addItemsByIds(ids, win);
          return;
        }
      }

      // Fallback: use whatever is currently selected in the library pane
      try {
        const selected = win.ZoteroPane?.getSelectedItems();
        if (selected && selected.length > 0) {
          await this.addItems(selected, win);
        }
      } catch (err) {
        Zotero.debug("[AcademicLens] Drop fallback error: " + err);
      }
    };

    // Attach with useCapture=true so we intercept before child elements
    mountVBox.addEventListener("dragenter", onDragEnter, true);
    mountVBox.addEventListener("dragover",  onDragOver,  true);
    mountVBox.addEventListener("dragleave", onDragLeave, true);
    mountVBox.addEventListener("drop",      onDrop,      true);
  },

  /* ============================================================
     Toggle Sidebar
  ============================================================ */

  toggleSidebar(win, forceState = null) {
    try {
      this._toggleSidebarImpl(win, forceState);
    } catch (err) {
      Zotero.debug("[AcademicLens] toggleSidebar FAILED: " + err + "\n" + (err && err.stack));
      Zotero.logError(err);
    }
  },

  _toggleSidebarImpl(win, forceState = null) {
    if (!win || win.closed || !win.document) return;
    const doc = win.document;

    const domItemPane    = doc.getElementById("zotero-item-pane");
    const domContextPane = doc.getElementById("zotero-context-pane");
    const tbBtn          = doc.getElementById("zotero-academic-lens-tb-toggle");

    // Lazily mount if the container exists but our pane is missing
    if (domItemPane && !doc.getElementById("academic-lens-pane-library")) {
      domItemPane.appendChild(this.createSidebarMount(win, "library"));
    }
    if (domContextPane && !doc.getElementById("academic-lens-pane-reader")) {
      domContextPane.appendChild(this.createSidebarMount(win, "reader"));
    }

    const alPaneLib = doc.getElementById("academic-lens-pane-library");
    const alPaneRdr = doc.getElementById("academic-lens-pane-reader");

    const isReaderTab = Boolean(
      (win.Zotero_Tabs && win.Zotero_Tabs.selectedType && win.Zotero_Tabs.selectedType !== "library") ||
      (!domItemPane && domContextPane)
    );

    const wasOpen    = Boolean(this.windows.get(win)?.isOpen);
    const shouldOpen = forceState !== null ? forceState : !wasOpen;

    Zotero.debug(`[AcademicLens] toggleSidebar: shouldOpen=${shouldOpen}, isReaderTab=${isReaderTab}, wasOpen=${wasOpen}`);

    // Helpers: show our pane inside a container (hiding native children), or restore the container
    const showIn = (container, pane) => {
      for (const child of container.children) {
        if (child !== pane) child.style.display = "none";
      }
      pane.style.display = "flex";
    };
    const hideIn = (container, pane) => {
      if (pane) pane.style.display = "none";
      if (!container) return;
      for (const child of container.children) {
        if (child !== pane) child.style.removeProperty("display");
      }
    };

    if (shouldOpen) {
      if (isReaderTab && domContextPane && alPaneRdr) {
        // Reader tab: only touch the context pane
        hideIn(domItemPane, alPaneLib);
        try {
          if (win.ZoteroContextPane?.collapsed) win.ZoteroContextPane.togglePane?.();
        } catch (_) {}
        showIn(domContextPane, alPaneRdr);
      } else if (domItemPane && alPaneLib) {
        // Library tab: only touch the item pane — never uncollapse the reader context pane here
        hideIn(domContextPane, alPaneRdr);
        try {
          if (win.ZoteroPane?.itemPane?.collapsed) win.ZoteroPane.itemPane.collapsed = false;
        } catch (_) {}
        showIn(domItemPane, alPaneLib);
      }

      tbBtn?.setAttribute("aria-pressed", "true");
      tbBtn?.setAttribute("selected", "true");
      this.windows.set(win, { isOpen: true });
      this.observeItemPane(win);
    } else {
      hideIn(domItemPane, alPaneLib);
      hideIn(domContextPane, alPaneRdr);

      tbBtn?.setAttribute("aria-pressed", "false");
      tbBtn?.removeAttribute("selected");
      this.windows.set(win, { isOpen: false });
      this.unobserveItemPane(win);
    }
  },

  /* Re-apply sidebar visibility when the user switches between library and reader tabs */
  registerTabObserver() {
    if (this._tabObserverID) return;
    try {
      this._tabObserverID = Zotero.Notifier.registerObserver({
        notify: (event, type) => {
          if (type !== "tab" || event !== "select") return;
          for (const [win, state] of this.windows) {
            if (state?.isOpen) {
              win.setTimeout(() => this.toggleSidebar(win, true), 50);
            }
          }
        }
      }, ["tab"], "academic-lens");
    } catch (err) {
      Zotero.debug("[AcademicLens] Could not register tab observer: " + err);
    }
  },

  unregisterTabObserver() {
    if (!this._tabObserverID) return;
    try { Zotero.Notifier.unregisterObserver(this._tabObserverID); } catch (_) {}
    this._tabObserverID = null;
  },

  /* ============================================================
     Settings Window (pop-out, Beaver pattern)
  ============================================================ */

  _settingsWindow: null,

  openSettingsWindow(win) {
    if (this._settingsWindow && !this._settingsWindow.closed) {
      this._settingsWindow.focus();
      return;
    }

    const hostWin = win || (typeof Zotero !== "undefined" && Zotero.getMainWindow ? Zotero.getMainWindow() : window);
    const settingsURL = "chrome://academic-lens/content/settings.xhtml";
    const opened = hostWin.openDialog(
      settingsURL,
      "academic-lens-settings-window",
      "chrome,resizable,centerscreen,dialog=false,width=560,height=640",
      null
    );

    if (opened) {
      this._settingsWindow = opened;
      opened.addEventListener("unload", () => {
        this._settingsWindow = null;
      }, { once: true });
    }

    Zotero.debug("[AcademicLens] Opened settings window.");
  },

  /* ============================================================
     Item Ingestion (Abstract & Metadata only)
  ============================================================ */

  async addItemsByIds(ids, win) {

    if (!ids || ids.length === 0) return;
    try {
      const items = await Zotero.Items.getAsync(ids);
      await this.addItems(items, win);
    } catch (err) {
      Zotero.debug("[AcademicLens] Failed to load items: " + err);
    }
  },

  async addItems(items, win) {
    const list = Array.isArray(items) ? items : [items];
    for (const item of list) {
      if (!item || !item.isRegularItem()) continue;
      if (this.selectedDocuments.some(d => d.id === item.id)) continue;  // no dups

      const title    = item.getField("title") || "Untitled";
      const creators = item.getCreators() || [];
      const firstAuthor = creators.length > 0
        ? (creators[0].lastName || creators[0].name || "Unknown")
        : "Unknown";
      const authors  = creators.map(c => c.lastName || c.name).filter(Boolean).join(", ") || firstAuthor;
      const rawDate  = item.getField("date") || item.getField("year") || "";
      const yearMatch = rawDate.match(/\b(19\d{2}|20\d{2})\b/);
      const year     = yearMatch ? yearMatch[1] : (rawDate ? rawDate.substring(0, 4) : "n.d.");
      const abstract = this.normalizeWs(item.getField("abstractNote") || "");
      const doi      = item.getField("DOI");
      const url      = item.getField("url") || (doi ? `https://doi.org/${doi}` : "");
      const display  = `${firstAuthor} (${year})`;

      this.selectedDocuments.push({ id: item.id, title, firstAuthor, authors, year, abstract, url, display });
    }

    this.renderDocumentChips(win);
  },

  removeDocument(id, win) {
    this.selectedDocuments = this.selectedDocuments.filter(d => d.id !== id);
    this.renderDocumentChips(win);
  },

  renderDocumentChips(win) {
    const panes = win.document.querySelectorAll("#academic-lens-pane-library, #academic-lens-pane-reader");
    if (!panes || panes.length === 0) return;

    panes.forEach(pane => {
      const listContainer = pane.querySelector("#al-doc-list");
      const countSpan     = pane.querySelector("#al-doc-count");
      if (countSpan) countSpan.textContent = String(this.selectedDocuments.length);
      if (!listContainer) return;

      listContainer.innerHTML = "";

      this.selectedDocuments.forEach((doc, idx) => {
        const docOwner = pane.ownerDocument || win.document;
        const chip = docOwner.createElement("div");
        chip.className = "al-doc-chip";
        chip.innerHTML = `
          <div class="al-doc-info">
            <div class="al-doc-header">[[${idx + 1}]] ${this.escapeHtml(doc.display)}</div>
            <div class="al-doc-title" title="${this.escapeHtml(doc.title)}">${this.escapeHtml(doc.title)}</div>
          </div>
          <button class="al-doc-remove" title="Remove">✕</button>
        `;
        chip.querySelector(".al-doc-remove")?.addEventListener("click", () => {
          this.removeDocument(doc.id, win);
        });
        listContainer.appendChild(chip);
      });
    });
  },

  /* ============================================================
     Text Cleaning (ported from app.py)
  ============================================================ */

  normalizeWs(text) {
    if (!text) return "";
    return text.replace(/[ \t\u3000]+/g, " ").trim();
  },

  stripBracketCitations(text) {
    if (!text) return "";
    return text.replace(/\[\d+(?:,\s*\d+)*\]/g, "");
  },

  cleanMojibake(text) {
    if (!text) return "";
    return text
      .replace(/â\x80\x94/g, " - ")
      .replace(/â\x80\x99/g, "'")
      .replace(/â\x80\x9c/g, '"')
      .replace(/â\x80\x9d/g, '"');
  },

  formatBulletPoints(text) {
    if (!text) return "";
    return text.replace(/^- /gm, "• ");
  },

  extractConfidence(text) {
    if (!text) return null;
    const m = text.match(/\|CONFIDENCE\|(\d+)\|/);
    return m ? parseInt(m[1], 10) : null;
  },

  cleanResponseTags(text) {
    if (!text) return "";
    return text.replace(/\|CONFIDENCE\|\d+\|/g, "").trim();
  },

  /* ============================================================
     Prompt Generation & Chat
  ============================================================ */

  buildContext() {
    return this.selectedDocuments.map((doc, idx) => {
      const clean = this.stripBracketCitations(doc.abstract || "No abstract available.");
      return (
        `--- START SOURCE [[${idx + 1}]] ---\n` +
        `Title: ${doc.title}\n` +
        `Authors: ${doc.authors} (${doc.year})\n` +
        `Abstract: ${clean}\n` +
        `--- END SOURCE [[${idx + 1}]] ---`
      );
    }).join("\n\n");
  },

  async handleSend(win) {
    const panes = win.document.querySelectorAll("#academic-lens-pane-library, #academic-lens-pane-reader");
    let pane = Array.from(panes).find(p => p.style.display !== "none");
    if (!pane) pane = win.document.getElementById("academic-lens-pane-library") || win.document.getElementById("academic-lens-pane-reader");
    if (!pane || this.isGenerating) return;

    const textarea = pane.querySelector("#al-input-query");
    const query    = textarea ? textarea.value.trim() : "";
    if (!query) return;

    if (this.selectedDocuments.length === 0) {
      this._alert(win, "Please add at least one article first.");
      return;
    }

    textarea.value = "";

    this.appendMessage(pane, "user", query);

    const assistantMsgEl = this.appendMessage(pane, "assistant", "");
    const contentEl      = assistantMsgEl?.querySelector(".al-msg-content");
    contentEl?.classList.add("al-streaming-cursor");

    const bookEl = win.document.createElement("div");
    bookEl.className = "book";
    bookEl.innerHTML = '<div class="book__pg"></div><div class="book__pg"></div><div class="book__pg"></div><div class="book__pg"></div><div class="book__pg"></div>';
    assistantMsgEl?.appendChild(bookEl);

    this.isGenerating = true;
    const sendBtn = pane.querySelector("#send-btn") || pane.querySelector("#al-btn-send");
    if (sendBtn) {
      sendBtn.textContent = "Cancel";
      sendBtn.classList.add("cancel");
      sendBtn.title = "Cancel response generation";
    }

    const AbortCtrl = (win && win.AbortController) || (typeof AbortController !== 'undefined' ? AbortController : (typeof window !== 'undefined' ? window.AbortController : null));
    if (AbortCtrl) {
      this.abortController = new AbortCtrl();
    } else {
      this.abortController = { signal: null, abort: () => {} };
    }

    const systemPrompt = (
      "You are a research assistant. Answer ONLY from the provided source materials.\n" +
      "After each bullet point cite the source with double brackets, e.g., [[1]].\n" +
      "At the end of your reply append a confidence score in the format: |CONFIDENCE|score|\n\n" +
      `<context>\n${this.buildContext()}\n</context>`
    );

    const messages = [
      { role: "system", content: systemPrompt },
      ...this.chatHistory.slice(-6).map(h => ({ role: h.role, content: h.content })),
      { role: "user", content: query }
    ];

    let fullText = "";

    try {
      const url = this.endpoint.replace(/\/+$/, "") + "/v1/chat/completions";

      const fetchFunc = (win && win.fetch) || (typeof fetch !== 'undefined' ? fetch : (typeof window !== 'undefined' ? window.fetch : null));
      const resp = await fetchFunc(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer ollama"
        },
        body: JSON.stringify({
          model:      this.modelName,
          messages,
          stream:     true,
          max_tokens: this.maxTokens
        }),
        signal: this.abortController.signal
      });

      if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);

      const reader  = resp.body.getReader();
      const TDecoder = (win && win.TextDecoder) || (typeof TextDecoder !== 'undefined' ? TextDecoder : (typeof window !== 'undefined' ? window.TextDecoder : null));
      const decoder = TDecoder ? new TDecoder("utf-8") : { decode: (v) => String.fromCharCode.apply(null, new Uint8Array(v)) };
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const t = line.trim();
          if (!t.startsWith("data:")) continue;
          const data = t.slice(5).trim();
          if (data === "[DONE]") break;
          try {
            const parsed = JSON.parse(data);
            const delta  = parsed.choices?.[0]?.delta?.content || "";
            if (delta) {
              fullText += this.cleanMojibake(delta);
              this.updateAssistantText(contentEl, fullText);
            }
          } catch (_) { /* incomplete chunk */ }
        }
      }

      assistantMsgEl?.querySelector(".book")?.remove();
      contentEl?.classList.remove("al-streaming-cursor");
      this.finalizeAssistantMessage(assistantMsgEl, fullText, win.document);

      this.chatHistory.push({ role: "user",      content: query });
      this.chatHistory.push({ role: "assistant", content: fullText });

    } catch (err) {
      assistantMsgEl?.querySelector(".book")?.remove();
      contentEl?.classList.remove("al-streaming-cursor");
      if (err.name === "AbortError") {
        if (contentEl) contentEl.textContent += " (cancelled)";
      } else {
        if (contentEl) contentEl.textContent = `⚠ Error connecting to ${this.endpoint}: ${err.message}`;
      }
    } finally {
      assistantMsgEl?.querySelector(".book")?.remove();
      this.isGenerating = false;
      this.abortController = null;
      if (sendBtn) {
        sendBtn.textContent = "Send";
        sendBtn.classList.remove("cancel");
        sendBtn.title = "Send question (Enter)";
      }
    }
  },

  abortGeneration(win) {
    if (this.abortController) {
      try {
        this.abortController.abort();
      } catch (_) {}
    }
    const panes = win?.document?.querySelectorAll?.("#academic-lens-pane-library, #academic-lens-pane-reader");
    panes?.forEach(pane => {
      pane.querySelectorAll(".book").forEach(b => b.remove());
      const cursor = pane.querySelector(".al-streaming-cursor");
      if (cursor) cursor.classList.remove("al-streaming-cursor");
      const sendBtn = pane.querySelector("#send-btn") || pane.querySelector("#al-btn-send");
      if (sendBtn) {
        sendBtn.textContent = "Send";
        sendBtn.classList.remove("cancel");
        sendBtn.title = "Send question (Enter)";
      }
    });
  },

  updateAssistantText(contentEl, rawText) {
    if (!contentEl) return;
    const parentMsg = contentEl.closest?.(".al-message") || contentEl.parentElement;
    const book = parentMsg?.querySelector(".book");
    if (book && rawText && rawText.trim().length > 0) {
      book.remove();
    }
    let text = this.cleanResponseTags(rawText);
    text = this.formatBulletPoints(text);
    contentEl.textContent = text;
  },

  finalizeAssistantMessage(msgEl, fullResponse, doc) {
    if (!msgEl) return;
    const contentEl = msgEl.querySelector(".al-msg-content");
    if (!contentEl) return;

    const confidence = this.extractConfidence(fullResponse);
    let cleaned      = this.cleanResponseTags(fullResponse);
    cleaned          = this.formatBulletPoints(cleaned);

    // Replace [[n]] with inline citation spans
    const docMap = {};
    this.selectedDocuments.forEach((d, i) => { docMap[i + 1] = d.display; });

    let html = this.escapeHtml(cleaned);
    html = html.replace(/\[\[(\d+)\]\]/g, (_, n) => {
      const label = docMap[n] || `Source ${n}`;
      return `<span class="al-citation-tag" title="Source ${n}">(${label})</span>`;
    });

    contentEl.innerHTML = html;

    if (confidence !== null) {
      let cls = confidence > 70 ? "al-conf-high" : confidence > 40 ? "al-conf-med" : "al-conf-low";
      const docToUse = doc || msgEl?.ownerDocument;
      if (docToUse) {
        const badge = docToUse.createElement("div");
        badge.className = `al-confidence-badge ${cls}`;
        badge.textContent = `Confidence: ${confidence}%`;
        msgEl.appendChild(badge);
      }
    }
  },

  appendMessage(pane, sender, text) {
    const area = pane.querySelector("#al-messages-area");
    if (!area) return null;

    const d   = pane.ownerDocument;
    const msg = d.createElement("div");
    msg.className = `al-message ${sender}`;

    const hdr = d.createElement("div");
    hdr.className   = "al-msg-header";
    hdr.textContent = sender === "user" ? "You" : "Academic Lens";

    const cnt = d.createElement("div");
    cnt.className   = "al-msg-content";
    cnt.textContent = text;

    msg.appendChild(hdr);
    msg.appendChild(cnt);
    area.appendChild(msg);
    area.scrollTop = area.scrollHeight;
    return msg;
  },

  escapeHtml(str) {
    if (!str) return "";
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  },

  /* ============================================================
     Endpoint Testing & Settings Persistence
  ============================================================ */

  setPausedState(root) {
    const dot = root.querySelector("#al-cfg-status-dot");
    const badge = root.querySelector("#al-cfg-conn-badge");
    const warning = root.querySelector("#al-cfg-warning");

    if (dot) dot.className = "al-status-dot paused";
    if (badge) {
      badge.className = "al-conn-badge paused";
      badge.textContent = "Disconnected (paused)";
    }
    if (warning) warning.classList.remove("visible");
  },

  async testEndpoint(root) {
    if (!this.connectionEnabled) {
      this.setPausedState(root);
      return;
    }

    const dot = root.querySelector("#al-cfg-status-dot");
    const badge = root.querySelector("#al-cfg-conn-badge");
    const warning = root.querySelector("#al-cfg-warning");
    const testBtn = root.querySelector("#al-btn-cfg-test");
    const epInput = root.querySelector("#al-input-endpoint");
    const modelInput = root.querySelector("#al-input-model");
    const modelSelect = root.querySelector("#al-select-model");

    const rawEp = epInput && typeof epInput.value === "string" ? epInput.value.trim() : (this.endpoint || "");
    const testUrl = (rawEp || this.DEFAULT_ENDPOINT).replace(/\/+$/, "");
    const targetModel = (modelInput && typeof modelInput.value === "string" ? modelInput.value.trim() : (this.modelName || ""));

    if (dot) dot.className = "al-status-dot checking";
    if (badge) {
      badge.className = "al-conn-badge checking";
      badge.textContent = "Checking endpoint…";
    }
    if (testBtn) testBtn.textContent = "…";

    try {
      if (!testUrl || !/^https?:\/\/.+/.test(testUrl)) {
        throw new Error("Invalid endpoint URL (must start with http:// or https://)");
      }

      const fetchFn = (typeof fetch !== "undefined" ? fetch : (root.ownerDocument?.defaultView?.fetch || win?.fetch || Zotero.getMainWindow()?.fetch));
      const r = await fetchFn(`${testUrl}/v1/models`, {
        method: "GET",
        headers: { "Authorization": "Bearer ollama" },
      });

      if (!r.ok) {
        throw new Error(`Endpoint returned HTTP ${r.status}`);
      }

      const json = await r.json();
      const availableModels = ((json && json.data) || []).map(m => m.id).filter(Boolean);

      // Populate dropdown if models exist
      if (modelSelect) {
        const doc = root.ownerDocument || (typeof document !== "undefined" ? document : null);
        if (availableModels.length > 0 && doc) {
          modelSelect.innerHTML = '<option value="">Select available model…</option>';
          availableModels.forEach(m => {
            const opt = doc.createElement("option");
            opt.value = m;
            opt.textContent = m;
            if (m === targetModel) opt.selected = true;
            modelSelect.appendChild(opt);
          });
          modelSelect.style.display = "inline-block";
        } else {
          modelSelect.style.display = "none";
        }
      }

      // Check if the specific model configured is actually hosted
      const hasExactModel = targetModel && availableModels.includes(targetModel);
      // Case-insensitive / prefix matching fallback (e.g. "llama3.2:3b" vs "llama3.2")
      const hasFuzzyModel = targetModel && availableModels.some(m => m.toLowerCase().includes(targetModel.toLowerCase()) || targetModel.toLowerCase().includes(m.toLowerCase()));

      if (hasExactModel || hasFuzzyModel) {
        if (dot) dot.className = "al-status-dot connected";
        if (badge) {
          badge.className = "al-conn-badge connected";
          badge.textContent = `✓ Ready (${targetModel})`;
        }
        if (warning) warning.classList.remove("visible");
      } else if (availableModels.length > 0) {
        // Endpoint is alive, but requested model is NOT hosted
        if (dot) dot.className = "al-status-dot model-missing";
        if (badge) {
          badge.className = "al-conn-badge model-missing";
          badge.textContent = `⚠ Model "${targetModel}" not found`;
        }
        if (warning) {
          warning.innerHTML = `Endpoint is online, but model <b>${this.escapeHtml(targetModel)}</b> is not hosted.<br/>` +
            `Available: <b>${this.escapeHtml(availableModels.join(", "))}</b>. Select from dropdown or run <code>ollama run ${this.escapeHtml(targetModel)}</code>.`;
          warning.classList.add("visible");
        }
      } else {
        // Endpoint online but no models loaded
        if (dot) dot.className = "al-status-dot model-missing";
        if (badge) {
          badge.className = "al-conn-badge model-missing";
          badge.textContent = "⚠ Endpoint online, no models";
        }
        if (warning) {
          warning.textContent = `Endpoint is reachable, but returned 0 models. Check that your LLM server has models pulled and loaded.`;
          warning.classList.add("visible");
        }
      }
    } catch (e) {
      if (dot) dot.className = "al-status-dot disconnected";
      if (badge) {
        badge.className = "al-conn-badge disconnected";
        badge.textContent = "✗ Endpoint not reachable";
      }
      if (warning) {
        warning.textContent = `⚠ Cannot connect to ${testUrl}: ${e.message}`;
        warning.classList.add("visible");
      }
    } finally {
      if (testBtn) testBtn.textContent = "⚡ Test";
    }
  },

  async fetchAndSelectModel(root) {
    const epInput = root.querySelector("#al-input-endpoint");
    const fetchBtn = root.querySelector("#al-btn-fetch-models");
    const rawEp = epInput && typeof epInput.value === "string" ? epInput.value.trim() : (this.endpoint || "");
    const testUrl = (rawEp || this.DEFAULT_ENDPOINT).replace(/\/+$/, "");

    if (!testUrl) return;
    if (fetchBtn) fetchBtn.textContent = "Fetching…";

    try {
      await this.testEndpoint(root);
      if (fetchBtn) fetchBtn.textContent = "✓ Updated";
    } catch (_) {
      if (fetchBtn) fetchBtn.textContent = "Failed";
    } finally {
      const timerWin = (root.ownerDocument?.defaultView || win || (typeof window !== "undefined" ? window : null));
      if (timerWin) timerWin.setTimeout(() => {
        if (fetchBtn) fetchBtn.textContent = "↻ Fetch Models";
      }, 2500);
    }
  },

  loadSettings() {
    try {
      const ep    = Zotero.Prefs.get("extensions.academic-lens.endpoint");
      const model = Zotero.Prefs.get("extensions.academic-lens.model");
      const tok   = Zotero.Prefs.get("extensions.academic-lens.maxTokens");
      if (ep)    this.endpoint   = ep;
      if (model) this.modelName  = model;
      if (tok)   this.maxTokens  = parseInt(tok, 10) || this.DEFAULT_MAX_TOKENS;
    } catch (_) {}
  },

  saveSettings() {
    try {
      Zotero.Prefs.set("extensions.academic-lens.endpoint",   this.endpoint);
      Zotero.Prefs.set("extensions.academic-lens.model",      this.modelName);
      Zotero.Prefs.set("extensions.academic-lens.maxTokens",  String(this.maxTokens));
      Zotero.debug("[AcademicLens] Settings saved: " + this.endpoint + " / " + this.modelName);
    } catch (_) {}
  },

  registerPreferencesPane(addonId, rootURI) {
    try {
      Zotero.PreferencePanes.register({
        pluginID: addonId,
        src:      rootURI + "content/preferences.xhtml",
        scripts:  [rootURI + "content/preferences.js"],
        id:       "academic-lens-prefpane",
        label:    "Academic Lens",
        image:    "chrome://academic-lens/content/icons/icon.png",
      });
      Zotero.debug("[AcademicLens] Preferences pane registered.");
    } catch (err) {
      Zotero.debug("[AcademicLens] Could not register prefs pane: " + err);
    }
  },

  /* Helper: cross-platform alert */
  _alert(win, msg) {
    try {
      win.alert(msg);
    } catch (_) {
      Zotero.debug("[AcademicLens] Alert: " + msg);
    }
  }
};

/* ================================================================
   AcademicLensPrefs — controller invoked by preferences.xhtml
   Handles the Zotero Preferences window pane.
================================================================ */

Zotero.AcademicLensPrefs = {

  _win: null,
  _saveTimer: null,

  init(win) {
    this._win = win;
    this._populate();
    this._bindEvents();
    Zotero.debug("[AcademicLensPrefs] Prefs pane initialised.");
  },

  // ── Populate fields from live settings ──────────────────────────

  _populate() {
    const al = Zotero.AcademicLens;
    this._set("al-prefs-endpoint",     al.endpoint  || al.DEFAULT_ENDPOINT);
    this._set("al-prefs-model",        al.modelName || al.DEFAULT_MODEL);

    const tok = al.maxTokens || al.DEFAULT_MAX_TOKENS;
    this._set("al-prefs-max-tokens",     String(tok));
    this._set("al-prefs-max-tokens-num", String(tok));
    this._syncTokenDisplay(tok);

    // Validate endpoint field visually on open
    this._validateEndpoint(this._val("al-prefs-endpoint"));
  },

  // ── Event wiring ─────────────────────────────────────────────────

  _bindEvents() {
    // Endpoint live validation
    this._on("al-prefs-endpoint", "input", () => {
      this._validateEndpoint(this._val("al-prefs-endpoint"));
    });

    // Model name live non-empty check
    this._on("al-prefs-model", "input", () => {
      const val = this._val("al-prefs-model").trim();
      const el  = this._el("al-prefs-model");
      if (el) {
        el.classList.toggle("invalid", val.length === 0);
        el.classList.toggle("valid",   val.length > 0);
      }
      const st = this._el("al-prefs-model-status");
      if (st) {
        if (val.length === 0) {
          this._status(st, "error", "Model name cannot be empty.");
        } else {
          st.textContent = "";
          st.className   = "al-prefs-status";
        }
      }
    });

    // Slider ↔ number input sync for max tokens
    this._on("al-prefs-max-tokens", "input", () => {
      const v = parseInt(this._val("al-prefs-max-tokens"), 10);
      if (!isNaN(v)) {
        this._set("al-prefs-max-tokens-num", String(v));
        this._syncTokenDisplay(v);
      }
    });
    this._on("al-prefs-max-tokens-num", "input", () => {
      const raw = parseInt(this._val("al-prefs-max-tokens-num"), 10);
      const v   = Math.min(8000, Math.max(100, raw || 100));
      this._set("al-prefs-max-tokens", String(v));
      this._syncTokenDisplay(v);
      const st = this._el("al-prefs-tokens-status");
      if (st) {
        if (isNaN(raw) || raw < 100) {
          this._status(st, "warn", "Minimum is 100 tokens.");
        } else if (raw > 8000) {
          this._status(st, "warn", "Maximum is 8000 tokens.");
        } else {
          st.textContent = ""; st.className = "al-prefs-status";
        }
      }
    });

    // Buttons
    this._on("al-prefs-test-btn",     "click", () => this._testEndpoint());
    this._on("al-prefs-fetch-models", "click", () => this._fetchModels());
    this._on("al-prefs-save",         "click", () => this._save());
    this._on("al-prefs-reset",        "click", () => this._reset());
  },

  _syncTokenDisplay(v) {
    const disp = this._el("al-prefs-tokens-display");
    if (disp) disp.textContent = String(v);
  },

  // ── Endpoint validation ──────────────────────────────────────────

  _validateEndpoint(val) {
    const trimmed = (val || "").trim();
    const ok      = /^https?:\/\/.+/.test(trimmed);
    const el      = this._el("al-prefs-endpoint");
    const st      = this._el("al-prefs-endpoint-status");
    if (el) {
      el.classList.toggle("valid",   ok);
      el.classList.toggle("invalid", trimmed.length > 0 && !ok);
    }
    if (st && trimmed.length > 0 && !ok) {
      this._status(st, "warn", "URL must start with http:// or https://");
    } else if (st && ok) {
      if (st.className.includes("warn") || st.className.includes("error")) {
        st.textContent = ""; st.className = "al-prefs-status";
      }
    }
    return ok || trimmed.length === 0;
  },

  // ── Test endpoint connectivity ────────────────────────────────────

  async _testEndpoint() {
    const ep      = this._val("al-prefs-endpoint").replace(/\/+$/, "");
    const statusEl = this._el("al-prefs-endpoint-status");
    const testBtn  = this._el("al-prefs-test-btn");

    if (!ep || !/^https?:\/\/.+/.test(ep)) {
      this._status(statusEl, "error", "Please enter a valid URL first.");
      return;
    }

    if (testBtn) { testBtn.textContent = "…"; testBtn.disabled = true; }
    this._status(statusEl, "info", "Connecting…");

    try {
      const fetchFn = (typeof fetch !== "undefined" ? fetch : (root.ownerDocument?.defaultView?.fetch || win?.fetch || Zotero.getMainWindow()?.fetch));
      const r = await fetchFn(ep + "/v1/models", { method: "GET" });
      if (r.ok) {
        const json  = await r.json();
        const count = (json && json.data) ? json.data.length : 0;
        this._status(statusEl, "success",
          `✓ Connected — ${count} model${count !== 1 ? "s" : ""} available`);
      } else {
        throw new Error("HTTP " + r.status);
      }
    } catch (e) {
      this._status(statusEl, "error", "✗ Unreachable: " + e.message);
    } finally {
      if (testBtn) { testBtn.textContent = "⚡ Test"; testBtn.disabled = false; }
    }
  },

  // ── Fetch model list from endpoint ────────────────────────────────

  async _fetchModels() {
    const ep     = this._val("al-prefs-endpoint").replace(/\/+$/, "");
    const listEl = this._el("al-prefs-model-list");
    const fetchBtn = this._el("al-prefs-fetch-models");

    if (!ep || !/^https?:\/\/.+/.test(ep)) {
      if (listEl) {
        listEl.innerHTML = "";
        const err = this._win.document.createElement("div");
        err.className = "al-prefs-status error";
        err.textContent = "Please enter and save a valid endpoint URL first.";
        listEl.appendChild(err);
      }
      return;
    }

    if (fetchBtn) { fetchBtn.textContent = "…"; fetchBtn.disabled = true; }
    if (listEl) {
      listEl.innerHTML = "";
      const loading = this._win.document.createElement("div");
      loading.className   = "al-prefs-status info";
      loading.textContent = "Fetching models…";
      listEl.appendChild(loading);
    }

    try {
      const r    = await fetch(ep + "/v1/models", { method: "GET" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const json   = await r.json();
      const models = ((json && json.data) || []).map(m => m.id).filter(Boolean);

      listEl.innerHTML = "";
      if (models.length === 0) {
        const empty = this._win.document.createElement("div");
        empty.className   = "al-prefs-status warn";
        empty.textContent = "⚠ No models returned by the endpoint.";
        listEl.appendChild(empty);
        return;
      }

      const currentModel = this._val("al-prefs-model");
      models.forEach(id => {
        const item = this._win.document.createElement("div");
        item.className = "al-prefs-model-item" + (id === currentModel ? " selected" : "");
        item.innerHTML = `<span class="al-prefs-model-dot"></span><span>${id}</span>`;
        item.addEventListener("click", () => {
          listEl.querySelectorAll(".al-prefs-model-item").forEach(i => {
            i.classList.remove("selected");
          });
          item.classList.add("selected");
          this._set("al-prefs-model", id);
          // Also clear model status
          const mst = this._el("al-prefs-model-status");
          if (mst) { mst.textContent = ""; mst.className = "al-prefs-status"; }
          const mel = this._el("al-prefs-model");
          if (mel) { mel.classList.remove("invalid"); mel.classList.add("valid"); }
        });
        listEl.appendChild(item);
      });
    } catch (e) {
      listEl.innerHTML = "";
      const err = this._win.document.createElement("div");
      err.className   = "al-prefs-status error";
      err.textContent = "✗ Could not fetch models: " + e.message;
      listEl.appendChild(err);
    } finally {
      if (fetchBtn) { fetchBtn.textContent = "↻ Fetch from endpoint"; fetchBtn.disabled = false; }
    }
  },

  // ── Save settings ────────────────────────────────────────────────

  _save() {
    const al         = Zotero.AcademicLens;
    const saveStatus = this._el("al-prefs-save-status");

    const newEp    = this._val("al-prefs-endpoint").trim();
    const newModel = this._val("al-prefs-model").trim();
    const rawTok   = parseInt(this._val("al-prefs-max-tokens-num") || this._val("al-prefs-max-tokens"), 10);
    const newTok   = Math.min(8000, Math.max(100, isNaN(rawTok) ? 800 : rawTok));

    // Validate
    if (!newEp || !/^https?:\/\/.+/.test(newEp)) {
      this._status(saveStatus, "error", "⚠ Endpoint URL is invalid (must start with http:// or https://).");
      return;
    }
    if (!newModel) {
      this._status(saveStatus, "error", "⚠ Model name cannot be empty.");
      return;
    }

    al.endpoint  = newEp;
    al.modelName = newModel;
    al.maxTokens = newTok;
    al.saveSettings();

    // Sync back to any open sidebar inputs
    for (const [win] of al.windows) {
      try {
        const epEl  = win.document.getElementById("al-input-endpoint");
        const mdEl  = win.document.getElementById("al-input-model");
        if (epEl) epEl.value = newEp;
        if (mdEl) mdEl.value = newModel;
      } catch (_) {}
    }

    // Show success, auto-clear after 3 s
    this._status(saveStatus, "success", "✓ Settings saved!");
    if (this._saveTimer) this._win.clearTimeout(this._saveTimer);
    this._saveTimer = this._win.setTimeout(() => {
      const el = this._el("al-prefs-save-status");
      if (el) { el.textContent = ""; el.className = "al-prefs-status"; }
      this._saveTimer = null;
    }, 3000);
  },

  // ── Reset to defaults ────────────────────────────────────────────

  _reset() {
    const al = Zotero.AcademicLens;
    this._set("al-prefs-endpoint",     al.DEFAULT_ENDPOINT);
    this._set("al-prefs-model",        al.DEFAULT_MODEL);
    this._set("al-prefs-max-tokens",   String(al.DEFAULT_MAX_TOKENS));
    this._set("al-prefs-max-tokens-num", String(al.DEFAULT_MAX_TOKENS));
    this._syncTokenDisplay(al.DEFAULT_MAX_TOKENS);

    // Clear validation states
    ["al-prefs-endpoint","al-prefs-model"].forEach(id => {
      const el = this._el(id);
      if (el) { el.classList.remove("valid","invalid"); }
    });
    ["al-prefs-endpoint-status","al-prefs-model-status","al-prefs-tokens-status"].forEach(id => {
      const el = this._el(id);
      if (el) { el.textContent = ""; el.className = "al-prefs-status"; }
    });

    const saveStatus = this._el("al-prefs-save-status");
    this._status(saveStatus, "info", "Fields reset to defaults — click Save to apply.");
  },

  // ── Helpers ──────────────────────────────────────────────────────

  _el(id)     { return this._win && this._win.document.getElementById(id); },
  _val(id)    { const el = this._el(id); return el ? el.value : ""; },
  _set(id, v) { const el = this._el(id); if (el) el.value = v; },
  _on(id, ev, fn) { const el = this._el(id); if (el) el.addEventListener(ev, fn); },

  _status(el, cls, msg) {
    if (!el) return;
    el.className   = "al-prefs-status " + cls;
    el.textContent = msg;
  },
};


// ==UserScript==
// @name          Kleinanzeigen - Superscript
// @namespace     https://github.com/RainbowLabsInc/Kleinanzeigen.de_Superscript
// @description   Alles in einem für Kleinanzeigen.de: Preisverlauf, neue und schon gesehene Anzeigen markieren, gespeicherte Suchen in einer Sidebar, Anzeigen direkt aus der Übersicht melden, Anbieter blockieren und ausblenden. Jedes Modul einzeln abschaltbar.
// @author        RainbowlabsInc
// @copyright     2026, RainbowlabsInc
// @license       MIT
// @version       0.2.3
// @icon          https://github.com/RainbowLabsInc/Kleinanzeigen.de_Superscript/raw/main/assets/icon48.png
// @homepage      https://github.com/RainbowLabsInc/Kleinanzeigen.de_Superscript
// @updateURL     https://github.com/RainbowLabsInc/Kleinanzeigen.de_Superscript/raw/main/superscript.user.js
// @downloadURL   https://github.com/RainbowLabsInc/Kleinanzeigen.de_Superscript/raw/main/superscript.user.js
// @match         https://www.kleinanzeigen.de/
// @match         https://www.kleinanzeigen.de/?*
// @match         https://www.kleinanzeigen.de/s-*
// @grant         GM_getValue
// @grant         GM_setValue
// @grant         GM_addValueChangeListener
// @grant         GM_registerMenuCommand
// @grant         GM_xmlhttpRequest
// @connect       raw.githubusercontent.com
// @connect       gist.githubusercontent.com
// @connect       *
// @noframes
// @run-at        document-idle
// ==/UserScript==

/*
 * Kleinanzeigen – Superscript
 * ---------------------------
 * Fasst mehrere Userscripts für Kleinanzeigen.de in einer Datei zusammen. Jedes Modul
 * lässt sich einzeln abschalten (Tampermonkey-Menü → „Superscript: Einstellungen“).
 *
 * Module:
 *   - Anzeige melden ......... unverändert aus vendor/anzeige-melden.user.js
 *   - Nutzer ausblenden ...... unverändert aus vendor/nutzer-ausblenden.user.js
 *   - Preisverlauf & Gesehen . src/preisverlauf.js (nur im Superscript)
 *   - Gespeicherte Suchen .... src/suchen.js (nur im Superscript)
 *
 * Die beiden übernommenen Scripts gibt es weiterhin einzeln. Ist eins davon zusätzlich
 * installiert, arbeitet pro Modul nur die zuerst gestartete Kopie, die andere bleibt still.
 *
 * superscript.user.js wird mit `node build.js` aus src/ und vendor/ erzeugt. Änderungen
 * bitte in den Quelldateien vornehmen, nicht in superscript.user.js.
 */

(function () {
    'use strict';

    const VERSION = '0.2.3';

    // Läuft auf der Startseite und auf Seiten unter /s-… (siehe @match).
    // Nur auf kleinanzeigen.de laufen – zusätzlich zu @match, falls der Script-Manager
    // die Header ignoriert oder das Script manuell mit breiteren Regeln eingebunden wird.
    if (window.location.protocol !== 'https:' || window.location.hostname !== 'www.kleinanzeigen.de') return;
    if (window.top !== window.self) return;

    // Doppelt installiert? Dann arbeitet nur die zuerst gestartete Kopie.
    const docRoot = document.documentElement;
    if (docRoot.hasAttribute('data-ks')) {
        console.warn('[Superscript] Script läuft bereits, diese Kopie bleibt inaktiv.');
        return;
    }
    docRoot.setAttribute('data-ks', VERSION);

    // ------------------------------------------------------------------
    // Kern: Speicher, Helfer, Module, Einstellungen
    // ------------------------------------------------------------------

    const KS = (() => {
        const MODULES_KEY = 'ks-modules'; // { <Modul-ID>: false } = abgeschaltet

        const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

        // Speicher des Userscript-Managers, sonst localStorage
        const hasGM = typeof GM_getValue === 'function' && typeof GM_setValue === 'function';

        function load(key, def) {
            try {
                if (hasGM) {
                    const v = GM_getValue(key);
                    return v === undefined ? def : v;
                }
                const raw = localStorage.getItem(key);
                return raw == null ? def : JSON.parse(raw);
            } catch (e) {
                return def;
            }
        }

        function save(key, value) {
            try {
                if (hasGM) GM_setValue(key, value);
                else localStorage.setItem(key, JSON.stringify(value));
                return true;
            } catch (e) {
                return false;
            }
        }

        // Ruft fn auf, wenn ein anderer Tab den Wert unter key ändert
        function onRemoteChange(key, fn) {
            if (hasGM && typeof GM_addValueChangeListener === 'function') {
                GM_addValueChangeListener(key, (name, oldValue, newValue, remote) => { if (remote) fn(); });
            } else if (!hasGM) {
                window.addEventListener('storage', e => { if (e.key === key) fn(); });
            }
        }

        function el(tag, props = {}, ...children) {
            const node = document.createElement(tag);
            for (const [k, v] of Object.entries(props)) {
                if (v == null || v === false) continue;
                if (k === 'dataset') Object.assign(node.dataset, v);
                else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
                else if (k in node && k !== 'list') node[k] = v;
                else node.setAttribute(k, v === true ? '' : v);
            }
            children.flat().forEach(c => c != null && c !== false && node.append(c));
            return node;
        }

        // Adresse einer Suche ohne Seitenzahl, damit Seite 2, 3 … zur selben Suche gehören:
        // /s-seite:2/…, /…/seite:2/…, ?pageNum=2. Parameter sortiert.
        function searchKey(href) {
            const url = new URL(href, window.location.origin);
            const p = url.pathname.replace(/\/s-seite:\d+\//, '/s-').replace(/\/seite:\d+(?=\/|$)/, '');
            const params = Array.from(url.searchParams)
                .filter(([k]) => !/^(pagenum|page|seite)$/i.test(k))
                .sort((a, b) => (a[0] + a[1]).localeCompare(b[0] + b[1]));
            return p + (params.length ? '?' + new URLSearchParams(params).toString() : '');
        }

        // Bausteine für Einstellungs-Abschnitte der Module
        const checkbox = (text, checked, onChange) => el('label', { className: 'ks-check' },
            el('input', { type: 'checkbox', checked, onchange: (e) => onChange(e.target.checked) }),
            el('span', {}, text));
        const radio = (name, text, checked, onChange) => el('label', { className: 'ks-check' },
            el('input', { type: 'radio', name, checked, onchange: () => onChange() }),
            el('span', {}, text));

        // --- Module

        const modules = [];        // { id, label, description, version, source, status }
        const sections = {};       // <Modul-ID> -> () => Node[] (Einstellungs-Abschnitt)

        const disabledMap = () => {
            const raw = load(MODULES_KEY, {});
            return isObj(raw) ? raw : {};
        };
        const isEnabled = (id) => disabledMap()[id] !== false;

        // Startet ein Modul, sofern es eingeschaltet ist. guard: Attribut am <html>, das die
        // Einzel-Version des Scripts setzt – ist es schon da, läuft das Script bereits separat.
        function module(id, meta, fn) {
            const m = { id, ...meta, status: 'off' };
            modules.push(m);
            if (!isEnabled(id)) return;
            if (meta.guard && docRoot.hasAttribute(meta.guard)) {
                m.status = 'external';
                return;
            }
            try {
                fn();
                m.status = 'on';
            } catch (e) {
                m.status = 'error';
                console.error(`[Superscript] Modul „${meta.label}“ ist mit einem Fehler abgebrochen:`, e);
            }
        }

        function setEnabled(id, on) {
            const map = disabledMap();
            if (on) delete map[id]; else map[id] = false;
            save(MODULES_KEY, map);
        }

        const addSettings = (id, render) => { sections[id] = render; };

        // --- Styles

        const styleEl = document.createElement('style');
        styleEl.textContent = `
            .ks-overlay {
                position: fixed; inset: 0; z-index: 2147483200; background: rgba(0,0,0,.4);
                display: grid; place-items: center; padding: 16px;
            }
            .ks-panel {
                box-sizing: border-box; width: min(600px, 100%); max-height: calc(100vh - 32px); overflow: auto;
                background: #fff; color: #1e1e1e; border: 1px solid #d0d0cc; border-radius: 12px;
                box-shadow: 0 12px 32px rgba(0,0,0,.22); font: inherit; font-size: 14px; line-height: 1.4; text-align: left;
            }
            .ks-panel *, .ks-panel *::before, .ks-panel *::after { box-sizing: border-box; }
            .ks-panel button, .ks-panel input { font: inherit; font-size: 14px; color: inherit; }
            .ks-head {
                position: sticky; top: 0; z-index: 1; display: flex; align-items: center; gap: 8px;
                padding: 10px 10px 10px 14px; background: #fff; border-bottom: 1px solid #eceae6;
            }
            .ks-title { flex: 1; min-width: 0; font-weight: 700; }
            .ks-icon-btn {
                flex: none; width: 32px; height: 32px; display: inline-grid; place-items: center;
                border: 0; border-radius: 8px; background: transparent; cursor: pointer; font-size: 18px; line-height: 1;
            }
            .ks-icon-btn:hover, .ks-icon-btn:focus-visible { background: #f2f1ee; outline: none; }
            .ks-body { padding: 12px 14px 14px; display: grid; gap: 12px; }
            .ks-section { display: grid; gap: 8px; padding-top: 12px; border-top: 1px solid #eceae6; }
            .ks-section:first-of-type { padding-top: 0; border-top: 0; }
            .ks-section h3 { margin: 0; font-size: 15px; font-weight: 700; }
            .ks-module { display: grid; gap: 2px; padding: 8px 10px; border: 1px solid #e3e1dc; border-radius: 8px; }
            .ks-check { display: flex; gap: 8px; align-items: flex-start; font-size: 13px; cursor: pointer; }
            .ks-check input { margin: 2px 0 0; accent-color: #1e1e1e; flex: none; }
            .ks-module > .ks-check { font-size: 14px; font-weight: 600; }
            .ks-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
            .ks-spacer { flex: 1; }
            .ks-hint, .ks-muted { margin: 0; font-size: 12px; color: #6b6b6b; }
            .ks-module .ks-muted { padding-left: 24px; }
            .ks-status[data-status="external"], .ks-status[data-status="error"] { color: #8a4b00; }
            .ks-note { margin: 0; padding: 8px 10px; border-radius: 8px; background: #f2f1ee; font-size: 13px; }
            .ks-note[data-kind="ok"] { background: #edf7ee; color: #1f5e23; }
            .ks-action {
                padding: 7px 14px; border-radius: 999px; border: 1px solid #c9c7c2; background: #fff;
                font-weight: 600; cursor: pointer; white-space: nowrap;
            }
            .ks-action:hover:not(:disabled), .ks-action:focus-visible { border-color: #1e1e1e; outline: none; }
            .ks-action[data-primary] { background: #1e1e1e; border-color: #1e1e1e; color: #fff; }
            .ks-action[data-danger]:hover:not(:disabled) { border-color: #c62828; color: #c62828; }
            .ks-action:disabled { opacity: .45; cursor: not-allowed; }
        `;
        const ensureStyles = () => { if (!styleEl.isConnected) (document.head || docRoot).appendChild(styleEl); };

        // --- Einstellungen (Dialog)

        let panel = null; // { overlay, box, changed, cleanup }

        function closeSettings() {
            if (!panel) return;
            panel.cleanup();
            panel.overlay.remove();
            panel = null;
        }

        function openSettings() {
            closeSettings();
            ensureStyles();
            const box = el('div', { className: 'ks-panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Superscript-Einstellungen' });
            const overlay = el('div', { className: 'ks-overlay' }, box);
            overlay.addEventListener('pointerdown', e => { if (e.target === overlay) closeSettings(); });
            const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeSettings(); } };
            document.addEventListener('keydown', onKey, true);
            panel = { overlay, box, changed: false, cleanup: () => document.removeEventListener('keydown', onKey, true) };
            document.body.appendChild(overlay);
            renderSettings();
            const first = box.querySelector('input');
            if (first) first.focus();
        }

        const statusText = {
            on: 'aktiv',
            off: 'ausgeschaltet',
            external: 'pausiert: das Script ist zusätzlich einzeln installiert und läuft bereits',
            error: 'mit einem Fehler abgebrochen (Details in der Browser-Konsole)',
        };

        function renderSettings() {
            if (!panel) return;
            const { box } = panel;
            const scrollTop = box.scrollTop;

            const moduleRows = modules.map(m => el('div', { className: 'ks-module' },
                checkbox(`${m.label} ${m.version}`, isEnabled(m.id), (on) => {
                    setEnabled(m.id, on);
                    panel.changed = true;
                    renderSettings();
                }),
                el('span', { className: 'ks-muted' }, m.description),
                el('span', { className: 'ks-muted ks-status', dataset: { status: m.status } },
                    `Status: ${statusText[m.status] || m.status}`, m.source ? ' · ' : '',
                    m.source ? el('a', { href: m.source, target: '_blank', rel: 'noopener' }, 'einzeln installieren') : null)));

            const moduleSections = modules
                .filter(m => m.status === 'on' && sections[m.id])
                .map(m => el('section', { className: 'ks-section' }, sections[m.id]()));

            box.replaceChildren(
                el('div', { className: 'ks-head' },
                    el('span', { className: 'ks-title' }, 'Superscript'),
                    el('button', { type: 'button', className: 'ks-icon-btn', 'aria-label': 'Schließen', title: 'Schließen', onclick: closeSettings }, '×')),
                el('div', { className: 'ks-body' },
                    el('section', { className: 'ks-section' },
                        el('h3', {}, 'Module'),
                        moduleRows,
                        panel.changed ? el('div', { className: 'ks-note ks-row', dataset: { kind: 'ok' } },
                            el('span', { className: 'ks-spacer' }, 'Gilt nach dem Neuladen der Seite.'),
                            el('button', { type: 'button', className: 'ks-action', onclick: () => window.location.reload() }, 'Seite neu laden')) : null,
                        el('p', { className: 'ks-hint' }, 'Ist ein Modul zusätzlich als einzelnes Script installiert, arbeitet nur die zuerst gestartete Kopie. '
                            + 'Am besten die einzelnen Scripts in Tampermonkey deaktivieren.')),
                    moduleSections,
                    el('p', { className: 'ks-hint' }, `Superscript ${VERSION} · Alles wird nur lokal in deinem Browser gespeichert · `,
                        el('a', { href: 'https://github.com/RainbowLabsInc/Kleinanzeigen.de_Superscript', target: '_blank', rel: 'noopener' }, 'Projektseite'))));
            box.scrollTop = scrollTop;
        }

        if (typeof GM_registerMenuCommand === 'function') {
            GM_registerMenuCommand('Superscript: Einstellungen', openSettings);
        }

        return { VERSION, isObj, load, save, onRemoteChange, el, checkbox, radio, searchKey, module, addSettings, openSettings };
    })();

    // ------------------------------------------------------------------
    // Module
    // ------------------------------------------------------------------

// ========================================================================
// Modul „Anzeige melden“ 0.4.5: vendor/anzeige-melden.user.js
// Unverändert übernommen aus https://github.com/RainbowLabsInc/Kleinanzeigen.de_Anzeige_melden
// ========================================================================
KS.module("melden", {"label":"Anzeige melden","version":"0.4.5","description":"Button „Melden“ neben dem Preis: Anzeigen direkt aus der Übersicht melden, mit eigenen Bausteinen.","guard":"data-klm-variant","source":"https://github.com/RainbowLabsInc/Kleinanzeigen.de_Anzeige_melden"}, function () {
/*
 * Funktionsweise
 * --------------
 * 1. Übersicht (Suchergebnisse, /s-..., und die Startseite):
 *    Jede Anzeigen-Karte bekommt neben dem Preis einen "Melden"-Button.
 *    Ein Klick öffnet ein kleines Menü direkt am Button: Baustein (Grund + Text) wählen,
 *    Text bei Bedarf anpassen, Meldung bestätigen, absenden.
 *    Gesendet wird genau die Anfrage, die auch der offizielle Melden-Dialog schickt
 *    (POST /flags/ads/<id>.json mit dem Sicherheits-Token der Anzeigenseite).
 *    Pro Klick wird genau eine Anzeige gemeldet, jeweils mit Bestätigung.
 *
 * 2. Rückfall "Offiziellen Dialog öffnen":
 *    Die Anzeige öffnet sich in einem kleinen Popup-Fenster (URL-Hash #klm-report).
 *    (Ein eingebettetes iframe ist nicht möglich: Kleinanzeigen verbietet das Einbetten
 *    seiner Seiten per X-Frame-Options/CSP.) Das Script klickt dort "Anzeige melden",
 *    blendet alles außer dem Dialog aus und meldet den Status per postMessage zurück;
 *    nach dem Absenden schließt sich das Popup selbst.
 *
 * Hinweis: Kleinanzeigen ändert das Frontend häufig. Das Script sucht Elemente daher
 * zuerst über feste Merkmale (z. B. die ID des Melden-Buttons) und fällt sonst auf
 * Text und Struktur zurück. Alle Selektoren und Texte stehen gesammelt in CONFIG.
 */

(function () {
    'use strict';

    const CONFIG = {
        hash: '#klm-report',
        msgType: 'klm-report',
        // Fenstername des Popups – bleibt erhalten, auch wenn die Seite den URL-Hash entfernt
        popupName: 'klm-report',
        storageKey: 'klm-reported-ads',
        // Wie lange auf den Melden-Button / -Dialog gewartet wird
        triggerTimeoutMs: 10000,
        // Abstand zwischen Klick-Versuchen auf den Melden-Button
        clickRetryMs: 1500,
        // Größe des Popup-Fensters
        popupWidth: 600,
        popupHeight: 780,
        // Offizieller Melden-Button auf der Detailseite (Stand 10/2026: <button id="viewad-action-flag-link">)
        triggerSelectors: ['#viewad-action-flag-link'],
        // Fallback über den Text, falls sich die ID ändert
        triggerText: /^\s*(anzeige\s+)?melden\s*$/i,
        triggerTextLoose: /anzeige\s+melden/i,
        // Mögliche Container des Melden-Dialogs
        dialogSelectors: [
            '[role="dialog"]',
            '[aria-modal="true"]',
            'dialog[open]',
            '.mfp-content',
            '.modal-dialog',
        ],
        // Beschriftung des Absenden-Buttons im Melden-Dialog
        submitText: /(absenden|abschicken|senden|melden)/i,
        // Texte, die nach erfolgreichem Absenden erscheinen können (zusätzlich zur
        // Erkennung der Bestätigungsansicht ohne Eingabefelder)
        successText: /(vielen dank|danke für (deine|ihre) meldung|erfolgreich gemeldet|meldung (wurde )?(erhalten|gesendet|übermittelt))/i,

        // Direktes Melden aus der Übersicht (Stand 10/2026, aus dem offiziellen Dialog abgelesen)
        flagUrl: (adId) => `/flags/ads/${encodeURIComponent(adId)}.json`,
        textMaxLength: 500,
        templatesKey: 'klm-templates',
        lastTemplateKey: 'klm-last-template',
        userNameKey: 'klm-user-name',
        // Gesendet wird die reasonId der zweiten Ebene. Bisher bekannt sind nur die
        // Unterpunkte von "Verdächtiger oder betrügerischer Inhalt"; alle anderen Gründe
        // gehen über den offiziellen Dialog.
        reasonGroup: 'Verdächtiger oder betrügerischer Inhalt',
        reasons: [
            { id: 'FRAUD_SUSPICIOUS_PRICE', label: 'Verdächtiger Preis' },
            { id: 'FRAUD_IDENTITY_THEFT', label: 'Identitätsdiebstahl/-missbrauch' },
            { id: 'FRAUD_SUSPICIOUS_EXCHANGES_WITH_SELLER', label: 'Verdächtiges Verhalten' },
            { id: 'FRAUD_OTHER', label: 'Anderer Verstoß (verdächtiger Inhalt)' },
        ],
        // Fertige Bausteine; Platzhalter: {titel}, {preis}, {id}, {link}
        defaultTemplates: [
            { name: 'Lockpreis', reasonId: 'FRAUD_SUSPICIOUS_PRICE',
                text: 'Der angegebene Preis ({preis}) ist nicht der tatsächliche Verkaufspreis. Laut Beschreibung wird ein deutlich anderer Preis verlangt.' },
            { name: 'Platzhalter-Preis für die Sortierung', reasonId: 'FRAUD_SUSPICIOUS_PRICE',
                text: 'Der Preis {preis} ist nur ein Platzhalter, damit die Anzeige bei der Sortierung nach Preis ganz oben erscheint.' },
            { name: 'Nur Tausch statt Verkauf', reasonId: 'FRAUD_SUSPICIOUS_PRICE',
                text: 'Angegeben ist ein Preis von {preis}, laut Beschreibung wird aber nur getauscht und nicht verkauft.' },
            { name: 'Verdacht auf Betrug', reasonId: 'FRAUD_OTHER',
                text: 'Die Anzeige wirkt betrügerisch: ' },
        ],
        // Bestätigung wie im offiziellen Dialog
        confirmText: 'Ich bestätige, dass ich diese Meldung in gutem Glauben abgebe und sie auf einem tatsächlichen Verstoß der Grundsätze basiert. Mir ist bewusst, dass falsche Meldungen Konsequenzen haben können.',
    };

    // Nur auf kleinanzeigen.de laufen – zusätzlich zu @match, falls der Script-Manager
    // die Header ignoriert oder das Script manuell mit breiteren Regeln eingebunden wird.
    const ALLOWED_HOST = 'www.kleinanzeigen.de';
    if (window.location.protocol !== 'https:' || window.location.hostname !== ALLOWED_HOST) return;

    // Es gibt zwei Varianten dieses Scripts (Bausteine / offizieller Dialog). Sind beide
    // installiert, arbeitet nur die zuerst gestartete – sonst gäbe es doppelte Buttons und Klicks.
    const root = document.documentElement;
    if (root.hasAttribute('data-klm-variant')) {
        console.warn(`[Anzeige melden] Variante "${root.getAttribute('data-klm-variant')}" ist bereits aktiv, "bausteine" bleibt inaktiv. Bitte nur eine Variante installieren.`);
        return;
    }
    root.setAttribute('data-klm-variant', 'bausteine');

    const path = window.location.pathname;
    const isDetailPage = path.startsWith('/s-anzeige/');
    // Übersicht: Suchergebnisse und Bestandslisten (/s-…) sowie die Startseite
    const isSearchPage = (path === '/' || path.startsWith('/s-')) && !isDetailPage;

    // ------------------------------------------------------------------
    // Gemeinsame Helfer
    // ------------------------------------------------------------------

    function isVisible(el) {
        if (!el || !el.isConnected) return false;
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    }

    function getAdIdFromUrl(url) {
        // /s-anzeige/<slug>/<adId>-<kategorie>-<ort>
        const m = String(url).match(/\/s-anzeige\/[^/]+\/(\d+)/);
        return m ? m[1] : null;
    }

    function loadReported() {
        try {
            return JSON.parse(localStorage.getItem(CONFIG.storageKey) || '{}') || {};
        } catch (e) {
            return {};
        }
    }

    function saveReported(adId) {
        try {
            const data = loadReported();
            data[adId] = Date.now();
            localStorage.setItem(CONFIG.storageKey, JSON.stringify(data));
        } catch (e) { /* Storage nicht verfügbar – Markierung gilt nur bis zum Neuladen */ }
    }

    // RainbowLabsInc-Logo (48x48 PNG, eingebettet – das Script lädt nichts von externen Servern)
    const logoDataUri = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAIAAADYYG7QAAAKa0lEQVR42u2Ya4xdV3XH19p7n+c959x75947b9tjexxiZ0iCYyckUBIIjwJCiQhSVYHVSkV86EtVi4TUCtQPbUGiUpMiNR8Q/dCWghAVrREJTkVpEsV5kJD4kWb8yHhsj+2ZO3fu+zz3Y/XDTO1xlBAnRShCPtrSOXuftc/+7XXWWXv/D4ZhHd5JB4N32HEd6DrQdaBfNRAiXnvnt2T8NoGI6No7vyXj6zH0awv0msB8S1XG2C823tzypnfXq9y2/bc9m3dwUP/yyMTb64abpkKIKGxSOQEyBCAAAAIwvwIgBGAIRJATZUTrLcgFCdeRUjDR1xkAAoCN6CJyBE1A/x8gRNwcGZerCMARJGBfG46w3eI3WGJWWDuFGGci9LTwamnHugj5olKnZHFKytNS97VxET2GhoCufvLr5n0iwmvZwnIACRAbMyr4J3z3Ps/f7/qjnm15FjmAKE2ELB6cqZqRtl1ucQOsndNRmf8oHR4cJqcL5SB6DPU1+OpNgNZjpWvMqOAHQv93S9FcFEAd81pS+LFT6Qk7B6nANSAzaYhrgJwlrUAkgduPWC9YSvV3k8G3ev35XIWcsTeLrV8ExAAUQGzMb0elL5fLu6NQzpi00SJnDawhq6rjK2NN7YiACBGQoQGTg1fo26Yvso6mAcCw5K7V3JXGckoP9tsPtQcE4CHqtwHEARIin+FXa+UvRCNmqxVva6J3kfyEz4C/FdiY+OxfvPfg43ngkzYABMioKOiGreVDD79UMZ3kHMoFwhaYrucsTXrNkUNp/IfN1kKhyoypNwoPx/FflyYmmrb4d8fqn6nXhzfncssJDC6xW2X0Pki2i8N2/TuqvrCzMny8kMMmxxxNAiZ2Dc782cTpHcOYO/UpWZ/VpgpGKvI6qZ/NJbVPueGLRXaiUD6iuUagyzT/Mda4vVHt7uvw8ISZToMPQ7GNH8wn/mY48y/p+PPZuwbdd/UfeaU/aEpSucpymRml7LvveXFk5Kc5/6+8HJMzM5bVd+mcGMuTNOo2BpX77eqzeTpfqNLrMb0WiAEUQHXBvj/euHW02tu7IpxT5j2m/AF4ztT+vLfrX4uJ1d6dpvm5ovUFvfwB9cy3Zd5n3EZgiEww8PZ8PeW/w/s7B8Z5iqf/XYQB4txs34QMOzIPu6VB9EleeSpPzyjtItKbekgD/NNo7YP1kd6+VW6dxruwtJf+sTvzlWzmYrILlv4oaX5erN245VXYMd++uPi9TPYZYwAEQMj4Pv++cjwem+3D4kPWcC4Wrf8UWSsL3j+1xseAlrUMutXOyN1W+IN42Ddg4VWZ8yogAdAz5k+r4R/UGr33DLh3EvaDfzM9uLbr7+Uka9+Tnv9L6Lx7z3xn7qX+bedgNuk+0/reMO8gMiJDZIDh/ZX7b2o2ovP98jDtujOD7N6SVj/3z59Jww82WmIE4JLO3HiqMzrG+L8NE/tqJ10BYgAx0Zxrfas2anYzGJ2nG2V4B3yjvfMf1Ji78kD30pcaK3Dn02vbzupZWE31j7X62ZHBgiLtCF9wRwjHsoKbKyWAkxPoha2wvpRqFy6Ie4IiPBEdX8yC35xsks+wWWSo9w/G5nX+fFb4m5iuACGABHioVr1tqpzccJaqnehe+FEy/rVii7P68c7yF7de6N9+OB5Lkgfck1oe/uNjf/3E8rOcWxZ3kHHGBGeCI3ty+enHLjzyvsg/UI6WCzs4b3MRn/f3h4rPR/8Dubh7up33GKYxDsI5FX4/HqYGOF4NxACGhu7y7b+qjaZ7MgwW7N+gS2XvS8PZuL93cOHL0xfS/YezrdT7NH9+O5dfXXny+NrxsvDSvJ/LYSHj9ZLLoUAEQytAB0bmboWlPndoKeR2cta/K2CtI/75PZjNjsfyHEhdbOmMnlXycJp7bMNJ7LJ7COlzpZJTs01lmaaMvRW+2d+2JBvy0u8HPeuWF5JxGt7Hfj6B8LLOHm/9zGeWAsOY9ZpiCBxmn+ieeDK9FHH/o3R8l72y66ieXu4OV3+vSHY8nExnEWM3IlQHqjI8UCqHm5Y5tk6TE0wK/lEvyCcKsNbc3TCvwsd0KNY+nCU3zR1fq8XyY/xoDaip5dcu/bCbtYSwaH2pQ7pSGAAD5JyRfGj5kWN5s4Tex/D4FPRvOhpbwwo2f+uoCX6SjJZmCaqUNlZvduy9rp0YYpeBGEBG5r2OPRm6xUgbKsqegEeTRlvW894nJprJ6BLstRa3Uj8j9pVzP/jJxWN2QjoxFCuKFRUGJIEkkIYSRUNlEiUSml9e+JPT37kge1WgO8WpkTbsWOwkw/ereOcj2YiKECdRV3peSX7c9zUQbt4PIeKHXM8qs9hes8agb4vDgxLr75XJjpmF9piJb2JLjoi+ufjoY/apqS9u6xYBpqhXpFpM9XJOuQYCtBjWHbHF4SMWcXLBefXZ+OsL//7gns/vUGszorW2OHpmZgy79x4JXj6tSzunhukrSgfJ3Y7vsa6+DKQBHIR3W7YJFWDmjMFLMjhjfDO4szRglZbZzldrqJoq/ucLT0wcuL23L8LBFoTCxR6DlJKCFAIAMsBQgHCMsY22tYejo9ahv33i6HDxNn98B6ycHNSrnaxVu6Ula8/k1d31YRKALMVbRDhl8aXC2AgCARTBiGBTtqNKBTiFqMAxGQxl1agtUT8PMjPBOyXuHlx5vhmRt/OBpZOCmcLYyFTssKYbtYUdA5ABq+hXc9lQFJGxSMvepAfbTv7w4lP7bvjsNLUjXYy0s5ViksmRBeXoErAQlJuOWLhNiIU8c5EJBJBAo5yHQmgnRc+QC01tGR0aWQ8H0jOqIQYKxNOdY6WJfeLFqfG4TZyBO0iqJmlsz9JZcgAQQSPPmDPIvVXkA8kKA5a0Kne80HoiM6YMRQ3jsBuACqEYWzZCWQxdo6wisKDBuAEABAEABiBizOZQYG44FBy6GUPpQl5y49yl1KUi17ACia/2quee9XSKouzYo2UnKqqoXDS2IIaoQaQ6QMi7Ds8LUBoMJ3tfbD+3WnQqlutDYqWSScKiuqqtXCMJ0EJrZqqcbyxfCAAEHDECgKxNLmAEjs1QOliKLLsIRFERgW+k5U2zi1NBLoA7AGioKSzb7QZGIXFBiGgIQJlMNewln2crayWLKeIej2Y1FDWr4ZrItirc9TDwrBCjiMAHYxNjzIGNVC0MgMvwSF783Vqv9opjYtsaYMvqJ+kRan3jxHLVrA6ldU4WZ09nwocJyfuOEzlOud+/wDWDVrKR9RlQCXAAAFjkXoG+xRGRuPFiM/nwpUO3BLt/Wiy9ykvDFyx+/pDxut+2rOIlonOBtRo/miQuMkP/t4U1ABkRGESDRoGDhqMGlIaBYaiAa8qmozvK8iOFzK5o8s1yHQEsgAI2ZOLGiRg62n/51d5BIFug5kRME5BlSOTEgAMwAkYWwvqyvwGE6/IONx5NAAQIhOsvdN1SG0moEPCNxAzSRnbDzVQAQCjQBgQihI3dDyESXjai9RE3JcaNOr12fnRFuROiWP8I8I1FE14toS5fmfUx4YqMpTdQtG9JSv/y/3Vc/4P2awD0v06aZcbhM9VEAAAAAElFTkSuQmCC';
    const logoImg = `<img class="klm-logo" src="${logoDataUri}" alt="" aria-hidden="true" width="20" height="20">`;

    const checkSvg = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;

    // ------------------------------------------------------------------
    // Teil 1: Detailseite im Popup – Melden-Dialog automatisch öffnen
    // ------------------------------------------------------------------

    function runReportPopup() {
        const target = window.opener;
        const adId = getAdIdFromUrl(window.location.href);

        function post(status, extra = {}) {
            if (!target) return;
            try {
                target.postMessage({ type: CONFIG.msgType, status, adId, ...extra }, window.location.origin);
            } catch (e) { /* Opener geschlossen */ }
        }

        const style = document.createElement('style');
        style.textContent = `
            html.klm-focus, html.klm-focus body { background: transparent !important; overflow: hidden !important; }
            html.klm-focus body * { visibility: hidden !important; }
            html.klm-focus [data-klm-dialog], html.klm-focus [data-klm-dialog] * { visibility: visible !important; }
        `;
        document.head.appendChild(style);

        function findTrigger() {
            for (const sel of CONFIG.triggerSelectors) {
                const el = Array.from(document.querySelectorAll(sel)).find(isVisible);
                if (el) return el;
            }
            // Nur sichtbare Kandidaten – Kleinanzeigen rendert Buttons teils doppelt (Desktop/Mobil)
            const candidates = Array.from(document.querySelectorAll('a, button, [role="button"], [role="menuitem"]')).filter(isVisible);
            const byText = (re) => candidates.find(el => {
                const label = [el.textContent, el.getAttribute('aria-label'), el.getAttribute('title')].filter(Boolean).join(' ');
                return re.test(label.trim());
            });
            return byText(CONFIG.triggerText) || byText(CONFIG.triggerTextLoose) || null;
        }

        // Dialoge/Formulare, die schon vor dem Klick da waren (z. B. Cookie-Banner, Suchfeld), ignorieren
        let preExisting = new Set();
        const allDialogs = () => CONFIG.dialogSelectors.flatMap(sel => Array.from(document.querySelectorAll(sel)));
        const allForms = () => Array.from(document.querySelectorAll('form, [role="radiogroup"]'));

        function findDialog() {
            const dialog = allDialogs().find(el => !preExisting.has(el) && isVisible(el));
            if (dialog) return dialog;
            // Fallback: neu aufgetauchtes Formular mit Auswahlfeldern rund ums Melden
            const form = allForms().find(el => !preExisting.has(el) && isVisible(el)
                && el.querySelector('input, textarea, select') && /meld|grund/i.test(el.textContent));
            if (!form) return null;
            // Bis zum fixierten Container (Modal) hochlaufen, sonst das Formular selbst nehmen
            for (let el = form; el && el !== document.body; el = el.parentElement) {
                if (getComputedStyle(el).position === 'fixed') return el;
            }
            return form;
        }

        function pageShowsSuccess() {
            return CONFIG.successText.test(document.body ? document.body.innerText : '');
        }

        function waitFor(fn, timeoutMs) {
            return new Promise(resolve => {
                const found = fn();
                if (found) return resolve(found);
                const obs = new MutationObserver(() => {
                    const hit = fn();
                    if (hit) { obs.disconnect(); clearTimeout(timer); resolve(hit); }
                });
                obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
                const timer = setTimeout(() => { obs.disconnect(); resolve(fn() || null); }, timeoutMs);
            });
        }

        function watchDialog(dialog) {
            let finished = false;
            let closing = false;
            let submitted = false;

            // Popup schließen – egal ob gemeldet oder abgebrochen. Die Übersicht fragt
            // selbst nach, falls keine Meldung erkannt wurde.
            const finish = (success) => {
                if (finished) return;
                finished = true;
                obs.disconnect();
                document.removeEventListener('click', onClick, true);
                document.removeEventListener('submit', onSubmit, true);
                document.documentElement.classList.remove('klm-focus');
                post('closed', { success });
                if (target) setTimeout(() => window.close(), success ? 1500 : 300);
            };

            // Klick auf "Absenden"/"Melden" im Dialog merken
            const onClick = (e) => {
                const btn = e.target.closest('button, [type="submit"], [role="button"]');
                if (btn && dialog.contains(btn) && CONFIG.submitText.test(btn.textContent || btn.value || '')) {
                    submitted = true;
                }
            };
            const onSubmit = (e) => { if (dialog.contains(e.target)) submitted = true; };
            document.addEventListener('click', onClick, true);
            document.addEventListener('submit', onSubmit, true);

            // Nach dem Absenden zeigt der Dialog eine Bestätigung ohne Eingabefelder
            const showsConfirmation = () => submitted && isVisible(dialog)
                && !Array.from(dialog.querySelectorAll('input:not([type="hidden"]), textarea, select')).some(isVisible);

            const obs = new MutationObserver(() => {
                if (closing || finished) return;
                // Erfolg, während der Dialog noch offen ist (Danke-Text oder Bestätigungsansicht)
                if (pageShowsSuccess() || showsConfirmation()) {
                    closing = true;
                    post('success');
                    finish(true);
                    return;
                }
                // Dialog geschlossen? (entfernt oder unsichtbar, und kein neuer Dialog offen)
                if (!isVisible(dialog)) {
                    const next = findDialog();
                    if (next && next !== dialog) {
                        // Dialog wurde ersetzt (z. B. Schritt 2 / Danke-Seite) – weiter beobachten
                        dialog.removeAttribute('data-klm-dialog');
                        dialog = next;
                        dialog.setAttribute('data-klm-dialog', '');
                        return;
                    }
                    // Fokus-Modus aufheben, damit innerText auch Toasts außerhalb des Dialogs sieht,
                    // dann kurz warten – eine Erfolgsmeldung kann erst nach dem Schließen erscheinen
                    closing = true;
                    document.documentElement.classList.remove('klm-focus');
                    setTimeout(() => finish(submitted || pageShowsSuccess()), 1200);
                }
            });
            obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
        }

        (async () => {
            const trigger = await waitFor(findTrigger, CONFIG.triggerTimeoutMs);
            if (!trigger) {
                post('trigger-not-found');
                return;
            }
            preExisting = new Set([...allDialogs(), ...allForms()].filter(isVisible));
            trigger.scrollIntoView({ block: 'center' });

            // Der Button ist oft schon sichtbar, bevor React die Klick-Logik angehängt hat.
            // Darum mehrfach klicken, bis der Dialog erscheint.
            let dialog = null;
            const deadline = Date.now() + CONFIG.triggerTimeoutMs;
            while (!dialog && Date.now() < deadline) {
                const btn = findTrigger() || trigger;
                btn.click();
                dialog = await waitFor(findDialog, CONFIG.clickRetryMs);
            }
            if (!dialog) {
                post('dialog-not-found');
                return;
            }
            dialog.setAttribute('data-klm-dialog', '');
            document.documentElement.classList.add('klm-focus');
            post('dialog-open');
            watchDialog(dialog);
        })();
    }

    // ------------------------------------------------------------------
    // Teil 2: Übersicht – Melden-Buttons einfügen + Popup steuern
    // ------------------------------------------------------------------

    function runOverview() {
        injectOverviewStyles();

        let scheduled = false;
        const schedule = () => {
            if (scheduled) return;
            scheduled = true;
            requestAnimationFrame(() => { scheduled = false; injectButtons(); });
        };
        injectButtons();
        new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });

        window.addEventListener('message', onPopupMessage);
    }

    // Die Seite baut Teile des Dokuments nach dem Laden neu auf; dann die Styles erneut einhängen
    const overviewStyle = document.createElement('style');
    const ensureOverviewStyles = () => { if (!overviewStyle.isConnected) (document.head || document.documentElement).appendChild(overviewStyle); };

    function injectOverviewStyles() {
        const style = overviewStyle;
        style.textContent = `
            .klm-price-row { display: flex !important; align-items: center; flex-wrap: wrap; gap: 8px; }
            /* Wrapper: der Button darin ist ein atomares Inline-Element und erbt so keine Link-Unterstreichung der Karte */
            .klm-wrap { margin-left: auto; display: block; }
            .kx-btn-row { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 8px; margin: 6px 0 0; }
            .klm-btn {
                display: inline-flex; align-items: center; gap: 6px;
                padding: 4px 12px; border-radius: 999px;
                border: 1px solid #d0d0cc; background: #fff; color: #555;
                font: inherit; font-size: 13px; font-weight: 600; line-height: 20px;
                cursor: pointer; white-space: nowrap; text-decoration: none;
                transition: background-color .15s, border-color .15s, color .15s;
            }
            .klm-logo { width: 20px; height: 20px; border-radius: 5px; flex: none; display: block; margin-left: -6px; }
            .klm-btn:hover, .klm-btn:focus-visible { border-color: #c62828; color: #c62828; background: #fdecea; outline: none; }
            .klm-btn[data-state="reported"] { border-color: #a5d6a7; color: #2e7d32; background: #edf7ee; }
            .klm-btn[data-state="busy"] { opacity: .6; cursor: progress; }

            .klm-toast {
                position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%);
                z-index: 2147483000; max-width: min(560px, calc(100vw - 32px));
                display: flex; align-items: center; flex-wrap: wrap; gap: 8px 12px;
                padding: 10px 14px; border-radius: 10px;
                background: #1e1e1e; color: #fff; font: inherit; font-size: 14px; line-height: 1.4;
                box-shadow: 0 8px 24px rgba(0,0,0,.25);
            }
            .klm-toast[data-kind="ok"] { background: #2e7d32; }
            .klm-toast[data-kind="warn"] { background: #8a4b00; }
            .klm-toast-text { flex: 1 1 220px; }
            .klm-toast button {
                padding: 4px 10px; border-radius: 6px; border: 1px solid rgba(255,255,255,.6);
                background: transparent; color: inherit; font: inherit; font-size: 13px; cursor: pointer;
            }
            .klm-toast button:hover { background: rgba(255,255,255,.15); }

            .klm-menu {
                position: absolute; z-index: 2147482000; box-sizing: border-box;
                max-height: calc(100vh - 32px); overflow: auto;
                background: #fff; color: #1e1e1e; border: 1px solid #d0d0cc; border-radius: 12px;
                box-shadow: 0 12px 32px rgba(0,0,0,.22);
                font: inherit; font-size: 14px; line-height: 1.4; text-align: left;
            }
            .klm-menu *, .klm-menu *::before, .klm-menu *::after { box-sizing: border-box; }
            .klm-menu-head {
                position: sticky; top: 0; z-index: 1; display: flex; align-items: center; gap: 8px;
                padding: 10px 10px 10px 14px; background: #fff; border-bottom: 1px solid #eceae6;
            }
            .klm-menu-title { flex: 1; min-width: 0; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
            .klm-menu-body { padding: 12px 14px 14px; display: grid; gap: 12px; }
            .klm-menu button, .klm-menu input, .klm-menu select, .klm-menu textarea { font: inherit; font-size: 14px; color: inherit; }
            .klm-icon-btn {
                flex: none; width: 32px; height: 32px; display: inline-grid; place-items: center;
                border: 0; border-radius: 8px; background: transparent; cursor: pointer; font-size: 18px; line-height: 1;
            }
            .klm-icon-btn:hover, .klm-icon-btn:focus-visible { background: #f2f1ee; outline: none; }
            .klm-list { display: grid; gap: 4px; margin: 0; padding: 0; border: 0; }
            .klm-option {
                display: flex; gap: 10px; align-items: flex-start; padding: 8px 10px;
                border: 1px solid #e3e1dc; border-radius: 8px; cursor: pointer;
            }
            .klm-option:hover { border-color: #c62828; }
            .klm-option:has(input:checked) { border-color: #c62828; background: #fdecea; }
            .klm-option input { margin: 3px 0 0; accent-color: #c62828; flex: none; }
            .klm-option-name { font-weight: 600; display: block; }
            .klm-option-reason { display: block; font-size: 12px; color: #6b6b6b; }
            .klm-field { display: grid; gap: 4px; }
            .klm-field > span { font-size: 12px; font-weight: 600; color: #555; }
            .klm-input {
                width: 100%; padding: 8px 10px; border: 1px solid #c9c7c2; border-radius: 8px; background: #fff;
            }
            .klm-input:focus { outline: 2px solid #1e1e1e; outline-offset: -1px; }
            textarea.klm-input { resize: vertical; min-height: 96px; }
            .klm-counter { justify-self: end; font-size: 12px; color: #6b6b6b; }
            .klm-confirm { display: flex; gap: 8px; align-items: flex-start; font-size: 12px; color: #444; cursor: pointer; }
            .klm-confirm input { margin: 2px 0 0; accent-color: #c62828; flex: none; }
            .klm-note { margin: 0; padding: 8px 10px; border-radius: 8px; background: #f2f1ee; font-size: 13px; }
            .klm-note[data-kind="error"] { background: #fdecea; color: #8e1c1c; }
            .klm-note[data-kind="ok"] { background: #edf7ee; color: #1f5e23; }
            .klm-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
            .klm-actions .klm-spacer { flex: 1; }
            .klm-action {
                padding: 7px 14px; border-radius: 999px; border: 1px solid #c9c7c2; background: #fff;
                font-weight: 600; cursor: pointer; white-space: nowrap;
            }
            .klm-action:hover:not(:disabled), .klm-action:focus-visible { border-color: #1e1e1e; outline: none; }
            .klm-action[data-primary] { background: #c62828; border-color: #c62828; color: #fff; }
            .klm-action[data-primary]:hover:not(:disabled) { background: #a51f1f; border-color: #a51f1f; }
            .klm-action:disabled { opacity: .45; cursor: not-allowed; }
            .klm-link {
                justify-self: start; padding: 0; border: 0; background: none; color: #555; text-decoration: underline;
                font-size: 13px; cursor: pointer;
            }
            .klm-link:hover { color: #c62828; }
            .klm-tpl { display: grid; gap: 8px; padding: 10px; border: 1px solid #e3e1dc; border-radius: 8px; }
            .klm-tpl-head { display: flex; gap: 4px; align-items: center; }
            .klm-tpl-head .klm-input { flex: 1; font-weight: 600; }
            .klm-tpl-head .klm-icon-btn { width: 28px; height: 28px; font-size: 15px; }
            .klm-tpl-head .klm-icon-btn:disabled { opacity: .3; cursor: default; background: transparent; }
            .klm-hint { margin: 0; font-size: 12px; color: #6b6b6b; }
            .klm-hint code { font-size: 12px; background: #f2f1ee; padding: 0 3px; border-radius: 3px; }
        `;
        ensureOverviewStyles();
    }

    function findAdCards() {
        const cards = new Set();

        // Klassisches Layout
        document.querySelectorAll('article.aditem[data-adid]').forEach(el => cards.add(el));

        // Generisch: vom Anzeigen-Link so weit nach oben laufen, wie der Container
        // nur Links auf genau diese eine Anzeige enthält -> das ist die Karte.
        document.querySelectorAll('a[href*="/s-anzeige/"]').forEach(link => {
            if (link.closest('article.aditem[data-adid]')) return;
            // Karte schon versorgt? Nur überspringen, solange ihr Button noch da ist
            const done = link.closest('[data-klm-injected]');
            if (done && done.querySelector('.klm-btn')) return;
            const adId = getAdIdFromUrl(link.href);
            if (!adId) return;
            let card = null;
            let el = link.parentElement;
            while (el && el !== document.body && containsOnlyAd(el, adId)) {
                card = el;
                el = el.parentElement;
            }
            if (card) cards.add(card);
        });

        return Array.from(cards);
    }

    function containsOnlyAd(el, adId) {
        return Array.from(el.querySelectorAll('a[href*="/s-anzeige/"]'))
            .every(a => getAdIdFromUrl(a.href) === adId);
    }

    function getCardInfo(card) {
        const link = card.querySelector('a[href*="/s-anzeige/"]');
        const href = card.dataset.href ? new URL(card.dataset.href, location.origin).href : (link ? link.href : null);
        const adId = card.dataset.adid || (href ? getAdIdFromUrl(href) : null);
        const titleEl = card.querySelector('h2, h3, .text-module-begin a, .ellipsis');
        const title = (titleEl ? titleEl.textContent : (link ? link.textContent : '')).trim();
        return { href, adId, title };
    }

    // Preis-Bestandteile: "2 €", "3.399 €", "VB", "Zu verschenken", "ab"
    const pricePartsRe = /\d[\d.,]*\s*€|zu verschenken|VB|ab/gi;

    function isPriceOnly(text) {
        const t = text.trim();
        // „VB“ allein (Verhandlungsbasis ohne Betrag) zählt auch als Preis
        return t.length > 0 && (/€|zu verschenken/i.test(t) || /^vb$/i.test(t)) && t.replace(pricePartsRe, '').replace(/\s+/g, '') === '';
    }

    // Buttons dieses und anderer Scripts (Nutzer ausblenden, Superscript) beim Lesen des Preises
    // ignorieren. Sonst findet das zweite Script die Preiszeile nicht mehr, sobald das erste seinen
    // Button hineingesetzt hat, und setzt keinen Button.
    const FOREIGN_UI = '.klm-wrap, .kua-ui, .kps-ui, .kss-ui';

    function textWithoutUi(node) {
        let text = node.textContent;
        node.querySelectorAll(FOREIGN_UI).forEach(ui => { text = text.split(ui.textContent).join(''); });
        return text;
    }

    // Reines Preis-Element: keine eigenen Kind-Elemente außer fremden Buttons, nur Preistext
    const isPriceLeaf = (el) => Array.from(el.children).every(c => c.matches(FOREIGN_UI))
        && !el.closest(FOREIGN_UI) && isPriceOnly(textWithoutUi(el));

    function findPriceRow(card) {
        // Klassisches Layout
        const classic = card.querySelector('.aditem-main--middle--price-shipping');
        if (classic) return classic;

        // Generisch: erstes Element, das nur aus Preistext besteht ...
        const first = Array.from(card.querySelectorAll('p, span, div, strong, b')).find(isPriceLeaf);
        if (!first) return null;

        // ... dann hoch bis zur Zeile, die noch ausschließlich Preise enthält
        // (z. B. "2 € VB" + durchgestrichener Altpreis "3.399 €"), aber keine km/EZ-Tags.
        let row = first;
        while (row.parentElement && row.parentElement !== card && isPriceOnly(textWithoutUi(row.parentElement))) {
            row = row.parentElement;
        }
        return row;
    }

    // Rückfall ohne Preiszeile (z. B. „VB“ ohne Betrag oder „Zu verschenken“ auf der Startseite,
    // wo die Karte dann keinen Preis zeigt): eigene Button-Zeile unter dem Titel. Die Zeile
    // (.kx-btn-row) teilen sich „Anzeige melden“ und „Nutzer ausblenden“, damit beide Buttons
    // nebeneinander stehen.
    function buttonRowFallback(card) {
        const existing = card.querySelector('.kx-btn-row');
        if (existing) return existing;
        const title = card.querySelector('h2, h3, .text-module-begin a, .ellipsis');
        if (!title) return null;
        const link = title.closest('a');
        const anchor = link && link !== card && card.contains(link) ? link : title;
        const row = document.createElement('div');
        row.className = 'kx-btn-row';
        anchor.insertAdjacentElement('afterend', row);
        return row;
    }

    function injectButtons() {
        const reported = loadReported();
        ensureOverviewStyles();

        findAdCards().forEach(card => {
            // Schon da? Baut die Seite die Karte neu auf, fehlt der Button: dann neu einsetzen
            if (card.dataset.klmInjected && card.querySelector('.klm-btn')) return;
            const info = getCardInfo(card);
            if (!info.href || !info.adId) return;

            const row = findPriceRow(card) || buttonRowFallback(card);
            if (!row) return;
            card.dataset.klmInjected = 'true';
            // Aktueller Preis = erstes reines Preis-Element (ohne durchgestrichenen Altpreis)
            const priceEl = [row, ...row.querySelectorAll('*')].find(isPriceLeaf) || row;
            info.price = textWithoutUi(priceEl).replace(/\s+/g, ' ').trim();

            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'klm-btn';
            btn.dataset.adid = info.adId;
            setButtonState(btn, reported[info.adId] ? 'reported' : 'idle');

            // Karte ist oft komplett verlinkt – Klick darf nicht zur Anzeige navigieren
            const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
            ['mousedown', 'mouseup', 'pointerdown', 'pointerup'].forEach(t => btn.addEventListener(t, e => e.stopPropagation()));
            btn.addEventListener('click', (e) => {
                stop(e);
                if (btn.dataset.state === 'busy') return;
                toggleMenu(info, btn);
            });

            const wrap = document.createElement('span');
            wrap.className = 'klm-wrap';
            wrap.appendChild(btn);
            row.classList.add('klm-price-row');
            row.appendChild(wrap);
        });
    }

    function setButtonState(btn, state) {
        btn.dataset.state = state;
        if (state === 'reported') {
            btn.innerHTML = `${logoImg}${checkSvg}<span>Gemeldet</span>`;
            btn.title = 'Diese Anzeige wurde von dir bereits gemeldet (erneut melden: klicken)';
        } else {
            btn.innerHTML = `${logoImg}<span>Melden</span>`;
            btn.title = 'Anzeige melden, ohne die Übersicht zu verlassen';
        }
    }


    // ------------------------------------------------------------------
    // Bausteine (lokal gespeichert)
    // ------------------------------------------------------------------

    const newId = () => Math.random().toString(36).slice(2, 10);
    const knownReason = (id) => CONFIG.reasons.find(r => r.id === id);

    function loadTemplates() {
        try {
            const list = JSON.parse(localStorage.getItem(CONFIG.templatesKey) || 'null');
            if (Array.isArray(list)) {
                const valid = list.filter(t => t && typeof t.name === 'string' && typeof t.text === 'string' && knownReason(t.reasonId));
                if (valid.length) return valid.map(t => ({ id: t.id || newId(), name: t.name, reasonId: t.reasonId, text: t.text }));
            }
        } catch (e) { /* kaputter Speicher -> Standard */ }
        return defaultTemplates();
    }

    function defaultTemplates() {
        return CONFIG.defaultTemplates.map(t => ({ id: newId(), ...t }));
    }

    function saveTemplates(list) {
        try { localStorage.setItem(CONFIG.templatesKey, JSON.stringify(list)); return true; } catch (e) { return false; }
    }

    function readSetting(key) {
        try { return localStorage.getItem(key) || ''; } catch (e) { return ''; }
    }

    function writeSetting(key, value) {
        try { localStorage.setItem(key, value); } catch (e) { /* egal */ }
    }

    function fillPlaceholders(text, info) {
        const values = {
            titel: info.title || '',
            preis: info.price || '',
            id: info.adId || '',
            link: info.href ? info.href.split('#')[0] : '',
        };
        return text.replace(/\{(titel|preis|id|link)\}/g, (_, key) => values[key]).slice(0, CONFIG.textMaxLength);
    }

    // ------------------------------------------------------------------
    // Direkt melden: Token + Name von der Anzeigenseite, dann derselbe Request wie der Dialog
    // ------------------------------------------------------------------

    function parseReportContext(html) {
        const pick = (patterns) => {
            for (const re of patterns) {
                const m = html.match(re);
                if (m) return m[1];
            }
            return null;
        };
        const token = pick([
            /const csrfToken = "([^"\\]+)"/,
            /"csrfToken":"([^"\\]+)"/,
            /csrfToken&quot;:\[0,&quot;([^&]+)&quot;\]/,
        ]);
        let userName = null;
        const m = html.match(/const loggedInUserName = ("(?:[^"\\]|\\.)*")/);
        if (m) {
            try { userName = JSON.parse(m[1]); } catch (e) { /* egal */ }
        }
        return { token, userName };
    }

    // Lädt die Anzeigenseite (wie beim Öffnen) und liest dort Sicherheits-Token und Namen aus –
    // dieselben Werte, die der offizielle Dialog verwendet.
    async function loadReportContext(info) {
        let ctx = { token: null, userName: null };
        try {
            const res = await fetch(info.href.split('#')[0], { credentials: 'same-origin' });
            if (res.ok) ctx = parseReportContext(await res.text());
        } catch (e) { /* Rückfall unten */ }
        if (!ctx.token) {
            const own = parseReportContext(document.documentElement.innerHTML);
            ctx = { token: own.token, userName: ctx.userName || own.userName };
        }
        return ctx;
    }

    async function sendReport(adId, { reasonId, text, userName, token }) {
        const res = await fetch(CONFIG.flagUrl(adId), {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json', 'x-csrf-token': token },
            body: JSON.stringify([{ reasonId, text, userName, anonymousExplicitContentReport: false }]),
        });
        // Antworttext für die Fehleranzeige (gekürzt, ohne HTML-Tags)
        let detail = '';
        if (!res.ok) {
            try {
                detail = (await res.text()).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
            } catch (e) { /* egal */ }
        }
        return { code: res.status, detail };
    }

    // ------------------------------------------------------------------
    // Melden-Menü an der Karte
    // ------------------------------------------------------------------

    function el(tag, props = {}, ...children) {
        const node = document.createElement(tag);
        for (const [k, v] of Object.entries(props)) {
            if (v == null || v === false) continue;
            if (k === 'dataset') Object.assign(node.dataset, v);
            else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
            else if (k in node && k !== 'list') node[k] = v;
            else node.setAttribute(k, v === true ? '' : v);
        }
        children.flat().forEach(c => c != null && node.append(c));
        return node;
    }

    let menu = null; // { root, info, btn, ctx, cleanup }

    function toggleMenu(info, btn) {
        if (menu && menu.btn === btn) { closeMenu(); return; }
        openMenu(info, btn);
    }

    function closeMenu() {
        if (!menu) return;
        menu.cleanup();
        menu.root.remove();
        const btn = menu.btn;
        menu = null;
        if (btn.isConnected) btn.focus({ preventScroll: true });
    }

    function openMenu(info, btn) {
        closeMenu();
        const root = el('div', { className: 'klm-menu', role: 'dialog', 'aria-label': 'Anzeige melden' });
        const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeMenu(); } };
        const onOutside = (e) => {
            if (!menu || root.contains(e.target) || btn.contains(e.target)) return;
            closeMenu();
        };
        const onResize = () => menu && positionMenu();
        document.addEventListener('keydown', onKey, true);
        document.addEventListener('pointerdown', onOutside, true);
        window.addEventListener('resize', onResize);

        menu = {
            root, info, btn,
            ctx: loadReportContext(info),
            cleanup: () => {
                document.removeEventListener('keydown', onKey, true);
                document.removeEventListener('pointerdown', onOutside, true);
                window.removeEventListener('resize', onResize);
            },
        };
        document.body.appendChild(root);
        renderReportView();
    }

    function positionMenu() {
        const { root, btn } = menu;
        const r = btn.getBoundingClientRect();
        const vw = document.documentElement.clientWidth;
        const width = Math.min(400, vw - 32);
        root.style.width = width + 'px';
        const left = Math.min(Math.max(16, r.right - width), vw - 16 - width);
        root.style.left = (left + window.scrollX) + 'px';
        root.style.top = (r.bottom + 8 + window.scrollY) + 'px';
    }

    function revealMenu() {
        positionMenu();
        menu.root.scrollIntoView({ block: 'nearest' });
    }

    function menuHeader(title, extraButtons = []) {
        return el('div', { className: 'klm-menu-head' },
            el('span', { className: 'klm-menu-title', title }, title),
            extraButtons,
            el('button', { type: 'button', className: 'klm-icon-btn', 'aria-label': 'Schließen', title: 'Schließen', onclick: closeMenu }, '×'));
    }

    function renderReportView() {
        const { root, info, btn } = menu;
        const templates = loadTemplates();
        const lastId = readSetting(CONFIG.lastTemplateKey);
        let selected = templates.find(t => t.id === lastId) || templates[0];
        let sending = false;

        const text = el('textarea', { className: 'klm-input', rows: 4, maxLength: CONFIG.textMaxLength, required: true });
        const counter = el('span', { className: 'klm-counter' });
        const name = el('input', { className: 'klm-input', type: 'text', autocomplete: 'name', required: true, placeholder: 'wird geladen …' });
        const confirm = el('input', { type: 'checkbox' });
        const status = el('p', { className: 'klm-note', role: 'status', hidden: true });
        const sendBtn = el('button', { type: 'button', className: 'klm-action', dataset: { primary: '' } }, 'Melden');
        let token = null;
        let ctxLoaded = false;

        const showStatus = (msg, kind) => {
            status.hidden = !msg;
            status.textContent = msg || '';
            if (kind) status.dataset.kind = kind; else delete status.dataset.kind;
        };
        const update = () => {
            counter.textContent = `${text.value.length}/${CONFIG.textMaxLength}`;
            sendBtn.disabled = sending || !ctxLoaded || !token || !selected
                || !text.value.trim() || !name.value.trim() || !confirm.checked;
        };
        const applyTemplate = (t) => {
            selected = t;
            text.value = fillPlaceholders(t.text, info);
            update();
        };

        const options = templates.map(t => {
            const radio = el('input', { type: 'radio', name: 'klm-template', value: t.id, checked: t === selected,
                onchange: () => applyTemplate(t) });
            return el('label', { className: 'klm-option' }, radio,
                el('span', {},
                    el('span', { className: 'klm-option-name' }, t.name),
                    el('span', { className: 'klm-option-reason' }, knownReason(t.reasonId).label)));
        });

        text.addEventListener('input', update);
        name.addEventListener('input', update);
        confirm.addEventListener('change', update);

        sendBtn.addEventListener('click', async () => {
            if (sendBtn.disabled) return;
            sending = true;
            update();
            showStatus('Meldung wird gesendet …');
            const userName = name.value.trim();
            let code = 0, detail = '';
            try {
                ({ code, detail } = await sendReport(info.adId, { reasonId: selected.reasonId, text: text.value.trim(), userName, token }));
            } catch (e) { code = 0; }
            if (!menu || menu.root !== root) return;
            if (code >= 200 && code < 300) {
                writeSetting(CONFIG.lastTemplateKey, selected.id);
                writeSetting(CONFIG.userNameKey, userName);
                markReported(info.adId);
                closeMenu();
                showToast(`Anzeige gemeldet: ${knownReason(selected.reasonId).label}`, 'ok', [], 4000);
                return;
            }
            sending = false;
            update();
            const server = detail ? ` Antwort von Kleinanzeigen: „${detail}“` : '';
            showStatus(code === 0
                ? 'Die Meldung konnte nicht gesendet werden (Netzwerkfehler). Du kannst es erneut versuchen oder den offiziellen Dialog nutzen.'
                : code === 401 || code === 403
                    ? `Kleinanzeigen hat die Meldung abgelehnt (Status ${code}). Mögliche Gründe: Du hast diese Anzeige schon gemeldet, oder du bist nicht eingeloggt.${server}`
                    : `Kleinanzeigen hat die Meldung abgelehnt (Status ${code}). Bitte den offiziellen Dialog nutzen.${server}`, 'error');
        });

        const reportedAt = loadReported()[info.adId];
        const body = el('div', { className: 'klm-menu-body' },
            reportedAt ? el('p', { className: 'klm-note', dataset: { kind: 'ok' } },
                `Du hast diese Anzeige am ${new Date(reportedAt).toLocaleDateString('de-DE')} bereits gemeldet.`) : null,
            el('fieldset', { className: 'klm-list' },
                el('legend', { className: 'klm-hint', style: 'margin-bottom:4px' }, `Grund (${CONFIG.reasonGroup})`),
                options),
            el('label', { className: 'klm-field' }, el('span', {}, 'Nachricht'), text, counter),
            el('label', { className: 'klm-field' }, el('span', {}, 'Name (wird wie im offiziellen Dialog mitgesendet)'), name),
            el('label', { className: 'klm-confirm' }, confirm, el('span', {}, CONFIG.confirmText)),
            status,
            el('div', { className: 'klm-actions' },
                el('span', { className: 'klm-spacer' }),
                el('button', { type: 'button', className: 'klm-action', onclick: closeMenu }, 'Abbrechen'),
                sendBtn),
            el('button', { type: 'button', className: 'klm-link', onclick: () => { closeMenu(); openReportPopup(info, btn); } },
                'Anderer Grund? Offiziellen Melden-Dialog öffnen'));

        const gear = el('button', { type: 'button', className: 'klm-icon-btn', 'aria-label': 'Bausteine bearbeiten',
            title: 'Bausteine bearbeiten', onclick: renderSettingsView }, '⚙');
        root.replaceChildren(menuHeader(`Melden: ${info.title || 'Anzeige ' + info.adId}`, [gear]), body);
        if (selected) applyTemplate(selected);
        update();
        revealMenu();
        (root.querySelector('input[name="klm-template"]:checked') || text).focus({ preventScroll: true });

        menu.ctx.then(ctx => {
            if (!menu || menu.root !== root) return;
            ctxLoaded = true;
            token = ctx.token;
            if (!name.value.trim()) name.value = ctx.userName || readSetting(CONFIG.userNameKey);
            name.placeholder = 'Dein Name';
            if (!token) showStatus('Kein Sicherheits-Token gefunden. Bist du eingeloggt? Alternativ den offiziellen Dialog nutzen.', 'error');
            update();
        });
    }

    function renderSettingsView() {
        const { root } = menu;
        let list = loadTemplates();
        const listBox = el('div', { className: 'klm-list' });
        const status = el('p', { className: 'klm-note', role: 'status', hidden: true });

        const drawList = () => {
            listBox.replaceChildren(...list.map((t, i) => {
                const reason = el('select', { className: 'klm-input', onchange: (e) => { t.reasonId = e.target.value; } },
                    CONFIG.reasons.map(r => el('option', { value: r.id, selected: r.id === t.reasonId }, r.label)));
                const move = (d) => { list.splice(i + d, 0, list.splice(i, 1)[0]); drawList(); };
                return el('div', { className: 'klm-tpl' },
                    el('div', { className: 'klm-tpl-head' },
                        el('input', { className: 'klm-input', type: 'text', value: t.name, 'aria-label': 'Name des Bausteins',
                            maxLength: 60, oninput: (e) => { t.name = e.target.value; } }),
                        el('button', { type: 'button', className: 'klm-icon-btn', title: 'Nach oben', 'aria-label': 'Nach oben',
                            disabled: i === 0, onclick: () => move(-1) }, '↑'),
                        el('button', { type: 'button', className: 'klm-icon-btn', title: 'Nach unten', 'aria-label': 'Nach unten',
                            disabled: i === list.length - 1, onclick: () => move(1) }, '↓'),
                        el('button', { type: 'button', className: 'klm-icon-btn', title: 'Löschen', 'aria-label': 'Baustein löschen',
                            disabled: list.length === 1, onclick: () => { list.splice(i, 1); drawList(); } }, '🗑')),
                    reason,
                    el('textarea', { className: 'klm-input', rows: 3, maxLength: CONFIG.textMaxLength, value: t.text,
                        'aria-label': 'Text des Bausteins', oninput: (e) => { t.text = e.target.value; } }));
            }));
        };

        const save = () => {
            const clean = list.map(t => ({ ...t, name: t.name.trim(), text: t.text.trim() }));
            if (clean.some(t => !t.name || !t.text)) {
                status.hidden = false;
                status.dataset.kind = 'error';
                status.textContent = 'Jeder Baustein braucht einen Namen und einen Text.';
                return;
            }
            if (!saveTemplates(clean)) {
                status.hidden = false;
                status.dataset.kind = 'error';
                status.textContent = 'Speichern nicht möglich (Browser-Speicher nicht verfügbar).';
                return;
            }
            renderReportView();
        };

        drawList();
        const body = el('div', { className: 'klm-menu-body' },
            el('p', { className: 'klm-hint' }, 'Platzhalter im Text: ',
                el('code', {}, '{titel}'), ' ', el('code', {}, '{preis}'), ' ', el('code', {}, '{id}'), ' ', el('code', {}, '{link}'),
                '. Gespeichert wird nur lokal in deinem Browser.'),
            listBox,
            el('div', { className: 'klm-actions' },
                el('button', { type: 'button', className: 'klm-action',
                    onclick: () => { list.push({ id: newId(), name: 'Neuer Baustein', reasonId: CONFIG.reasons[0].id, text: '' }); drawList(); } },
                    '+ Neuer Baustein'),
                el('button', { type: 'button', className: 'klm-link',
                    onclick: () => { list = defaultTemplates(); drawList(); } }, 'Standard wiederherstellen')),
            status,
            el('div', { className: 'klm-actions' },
                el('span', { className: 'klm-spacer' }),
                el('button', { type: 'button', className: 'klm-action', onclick: renderReportView }, 'Zurück'),
                el('button', { type: 'button', className: 'klm-action', dataset: { primary: '' }, onclick: save }, 'Speichern')));

        root.replaceChildren(menuHeader('Bausteine bearbeiten'), body);
        revealMenu();
        root.querySelector('input').focus({ preventScroll: true });
    }

    // ------------------------------------------------------------------
    // Popup + Statusleiste
    // ------------------------------------------------------------------

    let current = null; // { info, btn, popup, poll, done }

    function openReportPopup(info, btn) {
        finishCurrent();

        const url = info.href.split('#')[0] + CONFIG.hash;
        const w = CONFIG.popupWidth, h = CONFIG.popupHeight;
        const left = Math.max(0, Math.round(window.screenX + (window.outerWidth - w) / 2));
        const top = Math.max(0, Math.round(window.screenY + (window.outerHeight - h) / 2));
        // Muss direkt im Klick-Handler passieren, sonst blockiert der Browser das Popup
        const popup = window.open(url, CONFIG.popupName, `popup=yes,width=${w},height=${h},left=${left},top=${top}`);

        if (!popup) {
            showToast('Popup wurde vom Browser blockiert. Bitte Popups für kleinanzeigen.de erlauben.', 'warn', [
                { label: 'In neuem Tab öffnen', onClick: () => { window.open(url, '_blank'); hideToast(); } },
            ]);
            return;
        }
        try { popup.focus(); } catch (e) { /* egal */ }

        btn.dataset.state = 'busy';
        current = { info, btn, popup, done: false, poll: null };
        showToast(`Melden-Fenster geöffnet: ${info.title || 'Anzeige ' + info.adId}`);

        // Erkennen, wenn der Nutzer das Popup selbst schließt
        current.poll = setInterval(() => {
            if (!current || !current.popup.closed) return;
            const c = current;
            finishCurrent();
            if (!c.done) askMarkReported(c.info);
        }, 500);
    }

    function finishCurrent() {
        if (!current) return;
        clearInterval(current.poll);
        if (current.btn.dataset.state === 'busy') {
            setButtonState(current.btn, loadReported()[current.info.adId] ? 'reported' : 'idle');
        }
        current = null;
    }

    function markReported(adId) {
        saveReported(adId);
        document.querySelectorAll(`.klm-btn[data-adid="${adId}"]`).forEach(b => setButtonState(b, 'reported'));
    }

    function askMarkReported(info) {
        showToast('Melden-Fenster geschlossen. Hast du die Anzeige gemeldet?', null, [
            { label: 'Als gemeldet markieren', onClick: () => { markReported(info.adId); hideToast(); } },
            { label: 'Nein', onClick: hideToast },
        ], 10000);
    }

    let toastTimer = null;

    function showToast(text, kind, actions = [], autoHideMs = 0) {
        hideToast();
        const toast = document.createElement('div');
        toast.className = 'klm-toast';
        toast.setAttribute('role', 'status');
        if (kind) toast.dataset.kind = kind;
        const span = document.createElement('span');
        span.className = 'klm-toast-text';
        span.textContent = text;
        toast.appendChild(span);
        actions.forEach(a => {
            const b = document.createElement('button');
            b.type = 'button';
            b.textContent = a.label;
            b.addEventListener('click', a.onClick);
            toast.appendChild(b);
        });
        const x = document.createElement('button');
        x.type = 'button';
        x.textContent = '×';
        x.setAttribute('aria-label', 'Hinweis schließen');
        x.addEventListener('click', hideToast);
        toast.appendChild(x);
        document.body.appendChild(toast);
        if (autoHideMs) toastTimer = setTimeout(hideToast, autoHideMs);
    }

    function hideToast() {
        clearTimeout(toastTimer);
        document.querySelectorAll('.klm-toast').forEach(t => t.remove());
    }

    function onPopupMessage(e) {
        if (e.origin !== window.location.origin) return;
        const data = e.data;
        if (!data || data.type !== CONFIG.msgType || !current) return;
        if (e.source !== current.popup) return;
        if (data.adId && data.adId !== current.info.adId) return;

        switch (data.status) {
            case 'dialog-open':
                showToast('Bitte im Melden-Fenster den Grund auswählen und absenden.');
                break;
            case 'trigger-not-found':
                showToast('„Anzeige melden“ wurde nicht automatisch gefunden – bitte im Fenster manuell auf „Melden“ klicken.', 'warn');
                break;
            case 'dialog-not-found':
                showToast('Der Melden-Dialog wurde nicht erkannt – bitte im Fenster manuell fortfahren.', 'warn');
                break;
            case 'success':
            case 'closed':
                if ((data.status === 'success' || data.success) && !current.done) {
                    current.done = true;
                    markReported(current.info.adId);
                    showToast('Anzeige gemeldet.', 'ok', [], 4000);
                }
                break;
        }
    }

    // ------------------------------------------------------------------
    // Start
    // ------------------------------------------------------------------

    const isReportPopup = window.location.hash === CONFIG.hash || (window.name === CONFIG.popupName && !!window.opener);
    if (isDetailPage && isReportPopup) {
        runReportPopup();
    } else if (isSearchPage && window.top === window.self) {
        runOverview();
    }
})();
});

// ========================================================================
// Modul „Nutzer ausblenden“ 0.3.4: vendor/nutzer-ausblenden.user.js
// Unverändert übernommen aus https://github.com/RainbowLabsInc/Kleinanzeigen.de-User_ausblenden
// ========================================================================
KS.module("blockliste", {"label":"Nutzer ausblenden","version":"0.3.4","description":"Button „Ausblenden“ neben dem Preis: Anbieter blockieren, einzelne Anzeigen ausblenden, Listen teilen und abonnieren.","guard":"data-kua","source":"https://github.com/RainbowLabsInc/Kleinanzeigen.de-User_ausblenden"}, function () {
/*
 * Funktionsweise
 * --------------
 * Anbieter werden über ihre ID gespeichert:
 *   - private Anbieter: die Zahl aus dem Link zur Bestandsliste
 *     (/s-bestandsliste.html?userId=<ID>),
 *   - gewerbliche Anbieter: "pro:<shop>" aus dem Link zur Shop-Seite (/pro/<shop>,
 *     auf der Anzeigenseite im Kasten #viewad-bizteaser).
 *
 * Die Karten in den Suchergebnissen enthalten den Anbieter in der Regel nicht. Darum
 * merkt sich das Script, welche Anzeige zu welchem Anbieter gehört (Anzeigen-Index):
 *   - beim Blockieren: Bestandsliste bzw. Shop-Seite des Anbieters einmal laden,
 *   - danach höchstens einmal am Tag erneut (für neue Anzeigen, abschaltbar),
 *   - beim Öffnen einer Anzeige oder einer Bestandsliste (ohne zusätzliche Anfrage),
 *   - optional: unbekannte Anzeigen der Übersicht im Hintergrund prüfen (aus, weil
 *     dafür pro Anzeige eine Anfrage an Kleinanzeigen nötig ist).
 *
 * 1. Übersicht (Suchergebnisse, /s-..., und die Startseite):
 *    Anzeigen blockierter Anbieter und einzeln ausgeblendete Anzeigen werden
 *    eingeklappt (Hinweiszeile) oder ganz ausgeblendet. Neben dem Preis sitzt ein
 *    "Ausblenden"-Button mit einem kleinen Menü, unten links der Button "Blockliste".
 * 2. Anzeigenseite (/s-anzeige/...): Button "Blockieren" am Anbieter-Namen und fest
 *    unten links, Hinweisleiste bei blockierten Anbietern.
 * 3. Bestandsliste (/s-bestandsliste.html): Leiste zum Blockieren/Freigeben.
 *
 * Kleinanzeigen baut Teile der Seite nach dem Laden neu auf. Das Script beobachtet
 * die Seite und setzt fehlende Buttons, Hinweise und Styles wieder ein.
 *
 * Die Blockliste lässt sich als JSON oder als Textliste (ähnlich einer Filterliste)
 * exportieren. Fremde Listen werden nach einer Vorschau mit der eigenen zusammengeführt;
 * übernommene Einträge merken sich ihre Herkunft und lassen sich gemeinsam wieder
 * freigeben. Listen unter einer festen Adresse lassen sich abonnieren: Sie werden
 * täglich neu geladen und mit der Blockliste abgeglichen. Das Format ist im README
 * beschrieben.
 *
 * Alle Selektoren und Grenzwerte stehen gesammelt in CONFIG.
 */

(function () {
    'use strict';

    const VERSION = '0.3.4';

    const CONFIG = {
        keys: {
            users: 'kua-users',          // { <userId>: { name, note, added, source?, sub? } }
            ads: 'kua-hidden-ads',       // { <adId>: <Zeitstempel> } einzeln ausgeblendete Anzeigen
            index: 'kua-ad-index',       // { <adId>: <userId> } bekannte Zuordnung Anzeige -> Anbieter
            scanned: 'kua-scanned',      // { <userId>: <Zeitstempel> } letzte geladene Bestandsliste
            settings: 'kua-settings',
            subs: 'kua-subs',            // { <url>: { title, added, lastCheck, lastSuccess, error, excluded: [] } }
        },
        defaultSettings: {
            mode: 'collapse',            // 'collapse' = Hinweiszeile, 'hide' = ganz ausblenden
            dailyRefresh: true,          // Bestandslisten blockierter Anbieter täglich neu laden
            autoResolve: false,          // unbekannte Anzeigen der Übersicht im Hintergrund prüfen
        },
        // Größe des Anzeigen-Index; ältere (= kleinere) Anzeigen-Nummern fallen zuerst heraus
        indexMax: 20000,
        // Bestandsliste neu laden, wenn älter als
        refreshAfterMs: 24 * 60 * 60 * 1000,
        // ... aber pro Seitenaufruf höchstens so viele Anbieter
        refreshPerVisit: 3,
        // Seiten pro Bestandsliste bzw. Shop-Seite
        scanMaxPages: 10,
        // Pause zwischen zwei Hintergrund-Anfragen
        requestGapMs: 1200,
        // Höchstens so viele Anzeigen pro Seitenaufruf im Hintergrund prüfen
        autoResolveMax: 30,
        nameMax: 80,
        noteMax: 300,
        sourceMax: 80,
        // Abonnierte Listen: so oft neu laden, pro Seitenaufruf höchstens so viele, max. Größe
        subRefreshMs: 24 * 60 * 60 * 1000,
        subsPerVisit: 2,
        subMaxBytes: 2 * 1024 * 1024,
        subTimeoutMs: 20000,
        // Link zur Bestandsliste bzw. zum Shop (Stand 10/2026)
        sellerUrl: (id) => id.startsWith('pro:')
            ? `/pro/${encodeURIComponent(id.slice(4))}`
            : `/s-bestandsliste.html?userId=${encodeURIComponent(id)}`,
        // Bereiche der Anzeigenseite, in denen der Anbieter steht (in dieser Reihenfolge;
        // gewerbliche Anbieter: #viewad-bizteaser, Stand 10/2026)
        sellerContainers: ['#viewad-contact', '#viewad-profile-box', '#viewad-bizteaser', '.userprofile-vip', '#viewad-sidebar', 'aside'],
        // Linktexte, die kein Anbietername sind
        notAName: /anzeigen|profil|bestandsliste|shop|mehr|folgen/i,
        // Ergebnisliste auf Such- und Bestandslisten-Seiten (Rückfall: größte Liste mit Anzeigen)
        resultListSelectors: ['#srchrslt-adtable'],
        // "Nächste Seite" in der Bestandsliste: Text, title/aria-label bzw. Klasse des Links
        nextPageText: /^(›|»|>|weiter|nächste)/i,
        nextPageLabel: /nächste|weiter|next/i,
        nextPageClass: /(^|[-_\s])next([-_\s]|$)/i,
        listFormat: 'kleinanzeigen-blockliste',
        listFormatVersion: 1,
    };

    // Nur auf kleinanzeigen.de laufen – zusätzlich zu @match, falls der Script-Manager
    // die Header ignoriert oder das Script manuell mit breiteren Regeln eingebunden wird.
    if (window.location.protocol !== 'https:' || window.location.hostname !== 'www.kleinanzeigen.de') return;
    if (window.top !== window.self) return;

    // Doppelt installiert? Dann arbeitet nur die zuerst gestartete Kopie.
    const docRoot = document.documentElement;
    if (docRoot.hasAttribute('data-kua')) {
        console.warn('[Nutzer ausblenden] Script läuft bereits, diese Kopie bleibt inaktiv.');
        return;
    }
    docRoot.setAttribute('data-kua', VERSION);

    const path = window.location.pathname;
    const isDetailPage = path.startsWith('/s-anzeige/');
    const isSellerPage = path === '/s-bestandsliste.html';
    const pageSellerId = isSellerPage ? normalizeUserId(window.location.href) : null;

    // ------------------------------------------------------------------
    // Helfer
    // ------------------------------------------------------------------

    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
    const clip = (v, n) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : '');
    const fmtDate = (ts) => (ts ? new Date(ts).toLocaleDateString('de-DE') : '');

    function getAdIdFromUrl(url) {
        // /s-anzeige/<slug>/<adId>-<kategorie>-<ort>
        const m = String(url || '').match(/\/s-anzeige\/[^/]+\/(\d+)/);
        return m ? m[1] : null;
    }

    const ID_RE = /^(?:\d{1,15}|pro:[a-z0-9][a-z0-9_-]{0,79})$/i;

    // Nutzer-ID aus einem Link zur Bestandsliste / zum Shop
    function userIdFromHref(href) {
        const s = String(href || '');
        let m = s.match(/s-bestandsliste\.html\?(?:[^#]*&)?userId=(\d{1,15})(?!\d)/);
        if (m) return m[1];
        m = s.match(/^(?:https:\/\/www\.kleinanzeigen\.de)?\/pro\/([a-z0-9][a-z0-9_-]{0,79})(?:[/?#]|$)/i);
        // Kleinanzeigen unterscheidet bei /pro/<Shop> nicht nach Groß-/Kleinschreibung
        // (geprüft 10/2026), daher einheitlich klein speichern
        if (m) return 'pro:' + m[1].toLowerCase();
        return null;
    }

    // Nutzer-ID aus Eingabe oder Liste: "12345678", "pro:shop-name" oder ein Link
    function normalizeUserId(raw) {
        if (raw == null) return null;
        const s = String(raw).trim();
        const fromLink = userIdFromHref(s);
        if (fromLink) return fromLink;
        const m = s.match(/[?&]userId=(\d{1,15})(?!\d)/);
        if (m) return m[1];
        return ID_RE.test(s) ? s.toLowerCase() : null;
    }

    // Adresse einer abonnierten Liste: nur https, GitHub-Dateiansicht -> Rohtext
    function normalizeListUrl(raw) {
        if (typeof raw !== 'string') return null;
        let url;
        try { url = new URL(raw.trim()); } catch (e) { return null; }
        if (url.protocol !== 'https:' || url.username || url.password) return null;
        const blob = url.hostname === 'github.com' && url.pathname.match(/^\/([^/]+)\/([^/]+)\/(?:blob|raw)\/(.+)$/);
        if (blob) url = new URL(`https://raw.githubusercontent.com/${blob[1]}/${blob[2]}/${blob[3]}`);
        url.hash = '';
        const s = url.href;
        return s.length <= 500 ? s : null;
    }

    const isShop = (id) => id.startsWith('pro:');
    const sellerPageName = (id) => (isShop(id) ? 'Shop-Seite' : 'Bestandsliste');

    // Hinweisfeld (<p class="kua-note">) setzen; ohne Text wird es ausgeblendet
    function setNote(node, msg, kind) {
        node.hidden = !msg;
        node.textContent = msg || '';
        if (kind) node.dataset.kind = kind; else delete node.dataset.kind;
    }

    function userLabel(id, fallbackName) {
        const u = state.users[id];
        const name = (u && u.name) || fallbackName;
        if (name) return name;
        return isShop(id) ? `Shop ${id.slice(4)}` : `Nutzer ${id}`;
    }

    function el(tag, props = {}, ...children) {
        const node = document.createElement(tag);
        for (const [k, v] of Object.entries(props)) {
            if (v == null || v === false) continue;
            if (k === 'dataset') Object.assign(node.dataset, v);
            else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
            else if (k in node && k !== 'list') node[k] = v;
            else node.setAttribute(k, v === true ? '' : v);
        }
        children.flat().forEach(c => c != null && c !== false && node.append(c));
        return node;
    }

    // Buttons liegen teils in komplett verlinkten Karten: Klick darf nicht zur Anzeige navigieren
    // (Bubble-Phase: Listener am selben Element, die vorher registriert wurden, laufen trotzdem.)
    function guard(node) {
        ['mousedown', 'mouseup', 'pointerdown', 'pointerup'].forEach(t => node.addEventListener(t, e => e.stopPropagation()));
        node.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); });
        return node;
    }

    function guardedButton(props, ...children) {
        return guard(el('button', { type: 'button', ...props }, ...children));
    }

    // ------------------------------------------------------------------
    // Speicher: Tampermonkey/Violentmonkey-Speicher, sonst localStorage
    // ------------------------------------------------------------------

    const hasGM = typeof GM_getValue === 'function' && typeof GM_setValue === 'function';

    function load(key, def) {
        try {
            if (hasGM) {
                const v = GM_getValue(key);
                return v === undefined ? def : v;
            }
            const raw = localStorage.getItem(key);
            return raw == null ? def : JSON.parse(raw);
        } catch (e) {
            return def;
        }
    }

    function save(key, value) {
        try {
            if (hasGM) GM_setValue(key, value);
            else localStorage.setItem(key, JSON.stringify(value));
            return true;
        } catch (e) {
            return false;
        }
    }

    // source: Name der Liste, aus der ein Eintrag übernommen wurde (fehlt bei eigenen Einträgen)
    function cleanUser(u) {
        const o = isObj(u) ? u : {};
        const added = typeof o.added === 'number' ? o.added : Date.parse(o.added);
        const user = {
            name: clip(o.name, CONFIG.nameMax),
            note: clip(o.note, CONFIG.noteMax),
            added: Number.isFinite(added) ? added : Date.now(),
        };
        const source = clip(o.source, CONFIG.sourceMax);
        if (source) user.source = source;
        const sub = normalizeListUrl(o.sub);
        if (sub) user.sub = sub;
        return user;
    }

    function loadUsers() {
        const users = {};
        const raw = load(CONFIG.keys.users, {});
        if (isObj(raw)) {
            for (const [id, u] of Object.entries(raw)) {
                const nid = normalizeUserId(id);
                if (nid) users[nid] = cleanUser(u);
            }
        }
        return users;
    }

    function loadMap(key, valueOk) {
        const out = {};
        const raw = load(key, {});
        if (isObj(raw)) {
            for (const [k, v] of Object.entries(raw)) if (valueOk(k, v)) out[k] = v;
        }
        return out;
    }

    function loadIndex() {
        const index = loadMap(CONFIG.keys.index, (k, v) => /^\d{1,15}$/.test(k) && typeof v === 'string' && ID_RE.test(v));
        Object.keys(index).forEach(k => { index[k] = index[k].toLowerCase(); });
        return index;
    }

    function loadState() {
        const settings = { ...CONFIG.defaultSettings };
        const rawSettings = load(CONFIG.keys.settings, {});
        if (isObj(rawSettings)) {
            if (rawSettings.mode === 'hide' || rawSettings.mode === 'collapse') settings.mode = rawSettings.mode;
            if (typeof rawSettings.dailyRefresh === 'boolean') settings.dailyRefresh = rawSettings.dailyRefresh;
            if (typeof rawSettings.autoResolve === 'boolean') settings.autoResolve = rawSettings.autoResolve;
        }
        // IDs vereinheitlichen (0.1.3 hat Shop-IDs in Originalschreibweise gespeichert)
        const index = loadIndex();
        const scanned = {};
        Object.entries(loadMap(CONFIG.keys.scanned, (k, v) => ID_RE.test(k) && typeof v === 'number'))
            .forEach(([k, v]) => { scanned[k.toLowerCase()] = v; });
        return {
            users: loadUsers(),
            ads: loadMap(CONFIG.keys.ads, (k, v) => /^\d{1,15}$/.test(k) && typeof v === 'number'),
            index,
            scanned,
            settings,
            subs: loadSubs(),
        };
    }

    function loadSubs() {
        const subs = {};
        const raw = load(CONFIG.keys.subs, {});
        if (!isObj(raw)) return subs;
        for (const [rawUrl, v] of Object.entries(raw)) {
            const url = normalizeListUrl(rawUrl);
            if (!url || !isObj(v)) continue;
            const num = (x) => (typeof x === 'number' ? x : 0);
            subs[url] = {
                title: clip(v.title, CONFIG.sourceMax),
                added: num(v.added) || Date.now(),
                lastCheck: num(v.lastCheck),
                lastSuccess: num(v.lastSuccess),
                error: clip(v.error, 200),
                excluded: Array.isArray(v.excluded) ? v.excluded.map(normalizeUserId).filter(Boolean) : [],
            };
        }
        return subs;
    }

    let state = loadState();

    const saveUsers = () => save(CONFIG.keys.users, state.users);
    const saveAds = () => save(CONFIG.keys.ads, state.ads);
    const saveScanned = () => save(CONFIG.keys.scanned, state.scanned);
    const saveSettings = () => save(CONFIG.keys.settings, state.settings);
    const saveSubs = () => save(CONFIG.keys.subs, state.subs);

    // Neue Zuordnungen sammeln und gebündelt speichern. Vor dem Speichern mit dem
    // gespeicherten Stand zusammenführen, damit parallel offene Tabs nichts überschreiben.
    let pendingIndex = {};

    function learn(adId, userId) {
        if (!adId || !userId || !ID_RE.test(userId)) return false;
        if (state.index[adId] === userId) return false;
        state.index[adId] = userId;
        pendingIndex[adId] = userId;
        return true;
    }

    function flushIndex() {
        if (!Object.keys(pendingIndex).length) return;
        const merged = { ...loadIndex(), ...pendingIndex };
        const keys = Object.keys(merged);
        if (keys.length > CONFIG.indexMax) {
            keys.sort((a, b) => Number(a) - Number(b))
                .slice(0, keys.length - CONFIG.indexMax)
                .forEach(k => { delete merged[k]; });
        }
        pendingIndex = {};
        state.index = merged;
        save(CONFIG.keys.index, merged);
    }

    // ------------------------------------------------------------------
    // Anbieter erkennen
    // ------------------------------------------------------------------

    // Anbieter einer Anzeigenseite (live oder per fetch geladen): { id, name, el }
    function findSeller(doc) {
        const collect = (root) => {
            const found = new Map();
            root.querySelectorAll('a[href]').forEach(a => {
                if (a.closest('.kua-ui')) return;
                const id = userIdFromHref(a.getAttribute('href'));
                if (!id) return;
                const entry = found.get(id) || { id, name: '', el: a, count: 0 };
                entry.count++;
                const text = clip(a.textContent, CONFIG.nameMax);
                // Profilbild mit Initiale ("K") ist kein Name: dort nicht den Button einsetzen
                if (!entry.name && text.length > 1 && !CONFIG.notAName.test(text)) {
                    entry.name = text;
                    entry.el = a;
                }
                found.set(id, entry);
            });
            return Array.from(found.values()).sort((a, b) => b.count - a.count);
        };
        for (const sel of CONFIG.sellerContainers) {
            const box = doc.querySelector(sel);
            if (!box) continue;
            const hits = collect(box);
            if (hits.length) return hits[0];
        }
        // Rückfall: im ganzen Dokument genau ein Anbieter-Link (Bestandsliste vor Shop)
        const all = collect(doc);
        const regular = all.filter(e => !isShop(e.id));
        if (regular.length === 1) return regular[0];
        if (!regular.length && all.length === 1) return all[0];
        return null;
    }

    // Anzeigen-Nummern der Ergebnisliste (Such- oder Bestandslisten-Seite). Bewusst nur die
    // größte Liste – Empfehlungen anderer Anbieter am Rand sollen nicht im Index landen.
    function mainListAdIds(doc) {
        let scope = null;
        for (const sel of CONFIG.resultListSelectors) {
            scope = doc.querySelector(sel);
            if (scope) break;
        }
        const groups = new Map();
        (scope || doc).querySelectorAll('article[data-adid], a[href*="/s-anzeige/"]').forEach(node => {
            const adId = node.getAttribute('data-adid') || getAdIdFromUrl(node.getAttribute('href'));
            if (!adId || !/^\d{1,15}$/.test(adId)) return;
            const list = scope || node.closest('ul, ol') || doc;
            if (!groups.has(list)) groups.set(list, new Set());
            groups.get(list).add(adId);
        });
        let best = new Set();
        groups.forEach(set => { if (set.size > best.size) best = set; });
        return Array.from(best);
    }

    async function fetchDoc(url) {
        const res = await fetch(url, { credentials: 'same-origin' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return new DOMParser().parseFromString(await res.text(), 'text/html');
    }

    // Anbieter einer Anzeige über ihre Seite ermitteln (eine Anfrage, wie beim Öffnen)
    async function resolveSeller(info) {
        const doc = await fetchDoc(info.href.split('#')[0]);
        const seller = findSeller(doc);
        if (seller) {
            learn(info.adId, seller.id);
            flushIndex();
        }
        return seller;
    }

    // Seitenzahl aus einer Adresse: ?pageNum=2 / ?page=2 / ?seite=2 oder .../seite:2/...
    function pageNumber(url) {
        for (const [k, v] of url.searchParams) {
            if (/^(pagenum|page|seite)$/i.test(k) && /^\d+$/.test(v)) return Number(v);
        }
        const m = url.pathname.match(/\/seite:(\d+)(?:\/|$)/);
        return m ? Number(m[1]) : 1;
    }

    // Adresse der nächsten Seite einer Bestandsliste/Shop-Seite, oder null.
    // 1. ausgezeichneter "Weiter"-Link (rel="next", Text, title/aria-label, Klasse "…next…"),
    // 2. sonst der Link mit der nächsthöheren Seitenzahl.
    function nextPageUrl(doc, userId, visited, currentUrl) {
        const toSellerUrl = (href) => {
            if (!href) return null;
            let url;
            try { url = new URL(href, window.location.origin); } catch (e) { return null; }
            if (url.origin !== window.location.origin || normalizeUserId(url.href) !== userId) return null;
            return url;
        };
        const fresh = (url) => url && !visited.has(url.pathname + url.search);

        const marked = [
            ...doc.querySelectorAll('link[rel="next"], a[rel="next"]'),
            ...Array.from(doc.querySelectorAll('a[href]')).filter(a =>
                CONFIG.nextPageText.test(clip(a.textContent, 20))
                || CONFIG.nextPageLabel.test(a.getAttribute('aria-label') || '')
                || CONFIG.nextPageLabel.test(a.getAttribute('title') || '')
                || CONFIG.nextPageClass.test(a.getAttribute('class') || '')),
        ];
        for (const a of marked) {
            const url = toSellerUrl(a.getAttribute('href'));
            if (fresh(url)) return url.pathname + url.search;
        }

        const current = pageNumber(new URL(currentUrl, window.location.origin));
        for (const a of doc.querySelectorAll('a[href]')) {
            const url = toSellerUrl(a.getAttribute('href'));
            if (fresh(url) && pageNumber(url) === current + 1) return url.pathname + url.search;
        }
        return null;
    }

    // Bestandsliste bzw. Shop-Seite eines Anbieters laden und seine Anzeigen im Index vermerken
    const scanning = new Set();

    async function scanSeller(userId) {
        if (scanning.has(userId)) return 0;
        scanning.add(userId);
        try {
            const visited = new Set();
            let url = CONFIG.sellerUrl(userId);
            let count = 0;
            for (let page = 0; url && page < CONFIG.scanMaxPages; page++) {
                if (page) await sleep(CONFIG.requestGapMs);
                visited.add(url);
                const doc = await fetchDoc(url);
                const ids = mainListAdIds(doc);
                ids.forEach(adId => learn(adId, userId));
                count += ids.length;
                url = ids.length ? nextPageUrl(doc, userId, visited, url) : null;
            }
            state.scanned[userId] = Date.now();
            saveScanned();
            flushIndex();
            return count;
        } finally {
            scanning.delete(userId);
        }
    }

    async function refreshBlockedSellers() {
        if (!state.settings.dailyRefresh) return;
        const now = Date.now();
        const due = Object.keys(state.users)
            .filter(id => now - (state.scanned[id] || 0) > CONFIG.refreshAfterMs)
            .sort((a, b) => (state.scanned[a] || 0) - (state.scanned[b] || 0))
            .slice(0, CONFIG.refreshPerVisit);
        for (const id of due) {
            // Inzwischen schon eingelesen (z. B. direkt nach dem Blockieren) oder freigegeben?
            if (!state.users[id] || Date.now() - (state.scanned[id] || 0) <= CONFIG.refreshAfterMs) continue;
            try {
                await scanSeller(id);
                refreshPage();
            } catch (e) {
                console.warn(`[Nutzer ausblenden] ${sellerPageName(id)} nicht geladen:`, id, e);
            }
            await sleep(CONFIG.requestGapMs);
        }
    }

    // ------------------------------------------------------------------
    // Blockieren / Freigeben
    // ------------------------------------------------------------------

    let refreshPage = () => {};

    function blockUser(id, name, note) {
        state.users[id] = cleanUser({ name, note, added: Date.now() });
        saveUsers();
        refreshPage();
        const label = userLabel(id);
        const undo = { label: 'Rückgängig', onClick: () => { unblockUser(id); hideToast(); } };
        showToast(`„${label}“ blockiert.`, 'ok', [undo], 8000);
        scanSeller(id).then(n => {
            refreshPage();
            if (state.users[id]) {
                showToast(`„${label}“ blockiert, ${n} Anzeige${n === 1 ? '' : 'n'} auf der ${sellerPageName(id)} gefunden.`, 'ok', [undo], 6000);
            }
        }).catch(e => {
            console.warn(`[Nutzer ausblenden] ${sellerPageName(id)} nicht geladen:`, id, e);
        });
    }

    function unblockUser(id) {
        const u = state.users[id];
        if (!u) return;
        // Aus einem Abo: als Ausnahme merken, sonst käme der Eintrag beim nächsten Abgleich zurück
        const sub = u.sub && state.subs[u.sub];
        if (sub && !sub.excluded.includes(id)) {
            sub.excluded.push(id);
            saveSubs();
        }
        delete state.users[id];
        saveUsers();
        refreshPage();
    }

    function hideAd(adId) {
        state.ads[adId] = Date.now();
        saveAds();
        refreshPage();
    }

    function unhideAd(adId) {
        delete state.ads[adId];
        saveAds();
        refreshPage();
    }

    // ------------------------------------------------------------------
    // Abonnierte Listen
    // ------------------------------------------------------------------

    // Lädt die Liste ohne Cookies. GM_xmlhttpRequest umgeht die Sicherheitsregeln der Seite
    // (Tampermonkey fragt beim ersten Abruf einer neuen Adresse ggf. nach); ohne fetch().
    function fetchListText(url) {
        return new Promise((resolve, reject) => {
            const check = (text) => (text.length > CONFIG.subMaxBytes
                ? reject(new Error('Die Liste ist zu groß (max. 2 MB).')) : resolve(text));
            if (typeof GM_xmlhttpRequest === 'function') {
                GM_xmlhttpRequest({
                    method: 'GET', url, anonymous: true, timeout: CONFIG.subTimeoutMs,
                    headers: { 'Cache-Control': 'no-cache' },
                    onload: (r) => (r.status >= 200 && r.status < 300 ? check(r.responseText || '') : reject(new Error(`HTTP ${r.status}`))),
                    onerror: () => reject(new Error('Adresse nicht erreichbar oder Zugriff nicht erlaubt')),
                    ontimeout: () => reject(new Error('Zeitüberschreitung')),
                });
            } else {
                fetch(url, { credentials: 'omit', cache: 'no-cache' })
                    .then(r => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))))
                    .then(check, () => reject(new Error('Adresse nicht erreichbar')));
            }
        });
    }

    // Gleicht ein Abo mit der Blockliste ab: neue Anbieter dazu, nicht mehr gelistete weg.
    // Eigene Einträge und Einträge aus anderen Listen bleiben unberührt, Ausnahmen werden übersprungen.
    // Einzelne Anzeigen (anzeige:...) werden bei Abos nicht übernommen.
    const syncing = new Set();

    async function syncSub(url) {
        const sub = state.subs[url];
        if (!sub || syncing.has(url)) return null;
        syncing.add(url);
        try {
            sub.lastCheck = Date.now();
            let list;
            try {
                list = parseList(await fetchListText(url));
            } catch (e) {
                sub.error = clip(e.message, 200);
                saveSubs();
                throw e;
            }
            const title = list.title || sub.title || new URL(url).hostname;
            const wanted = new Map(list.users.filter(u => !sub.excluded.includes(u.id)).map(u => [u.id, u]));
            const result = { added: 0, removed: 0, total: wanted.size, title };
            for (const [id, u] of Object.entries(state.users)) {
                if (u.sub === url && !wanted.has(id)) { delete state.users[id]; result.removed++; }
            }
            for (const [id, u] of wanted) {
                const cur = state.users[id];
                if (!cur) {
                    state.users[id] = cleanUser({ ...u, added: Date.now(), source: title, sub: url });
                    result.added++;
                } else if (cur.sub === url) {
                    state.users[id] = cleanUser({ ...u, added: cur.added, source: title, sub: url });
                }
            }
            Object.assign(sub, { title, lastSuccess: Date.now(), error: '' });
            saveUsers();
            saveSubs();
            refreshPage();
            return result;
        } finally {
            syncing.delete(url);
        }
    }

    // Fällige Abos nacheinander aktualisieren (beim Seitenaufruf)
    async function refreshSubs() {
        const now = Date.now();
        const due = Object.keys(state.subs)
            .filter(url => now - state.subs[url].lastCheck > CONFIG.subRefreshMs)
            .sort((a, b) => state.subs[a].lastCheck - state.subs[b].lastCheck)
            .slice(0, CONFIG.subsPerVisit);
        for (const url of due) {
            try { await syncSub(url); } catch (e) { console.warn('[Nutzer ausblenden] Abo nicht geladen:', url, e); }
        }
    }

    function removeSub(url) {
        Object.keys(state.users).forEach(id => { if (state.users[id].sub === url) delete state.users[id]; });
        delete state.subs[url];
        saveUsers();
        saveSubs();
        refreshPage();
    }

    // ------------------------------------------------------------------
    // Styles
    // ------------------------------------------------------------------

    const blockSvg = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><line x1="5.6" y1="5.6" x2="18.4" y2="18.4"/></svg>`;

    const styleEl = document.createElement('style');

    // Die Seite baut Teile des Dokuments nach dem Laden neu auf; dann die Styles erneut einhängen
    function ensureStyles() {
        if (!styleEl.isConnected) (document.head || document.documentElement).appendChild(styleEl);
    }

    // Ruft fn gebündelt (einmal pro Frame) auf, sobald sich das Dokument ändert.
    // Beobachtet <html> statt <body>, falls die Seite den <body> selbst austauscht.
    function watchPage(fn) {
        let scheduled = false;
        new MutationObserver(() => {
            if (scheduled) return;
            scheduled = true;
            requestAnimationFrame(() => { scheduled = false; fn(); });
        }).observe(document.documentElement, { childList: true, subtree: true });
    }

    function injectStyles() {
        styleEl.textContent = `
            [data-kua-hidden] { display: none !important; }
            [data-kua-state="collapsed"] > :not(.kua-note-bar) { display: none !important; }
            [data-kua-state="collapsed"] { min-height: 0 !important; height: auto !important; }
            .kua-price-row { display: flex !important; align-items: center; flex-wrap: wrap; gap: 8px; }
            .kua-wrap { margin-left: auto; display: block; }
            .kx-btn-row { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 8px; margin: 6px 0 0; }
            .klm-price-row .klm-wrap + .kua-wrap, .kua-price-row .kua-wrap + .klm-wrap { margin-left: 0; }
            .kua-btn {
                display: inline-flex; align-items: center; gap: 5px;
                padding: 4px 10px; border-radius: 999px;
                border: 1px solid #d0d0cc; background: #fff; color: #555;
                font: inherit; font-size: 13px; font-weight: 600; line-height: 20px;
                cursor: pointer; white-space: nowrap; text-decoration: none;
                transition: background-color .15s, border-color .15s, color .15s;
            }
            .kua-btn:hover, .kua-btn:focus-visible { border-color: #1e1e1e; color: #1e1e1e; background: #f2f1ee; outline: none; }
            .kua-btn[data-state="blocked"] { border-color: #1e1e1e; background: #1e1e1e; color: #fff; }
            .kua-btn svg { flex: none; }
            /* Anzeigenseite: nie strecken (der Anbieter-Kasten ist teils ein Flex-Layout), rot abgesetzt */
            .kua-btn.kua-detail-btn {
                flex: none !important; align-self: flex-start !important; width: auto !important; height: auto !important;
                max-width: max-content; border-color: #c62828; color: #c62828; background: #fdecea;
            }
            .kua-btn.kua-detail-btn:hover, .kua-btn.kua-detail-btn:focus-visible { background: #c62828; border-color: #c62828; color: #fff; }
            .kua-btn.kua-detail-btn[data-state="blocked"] { border-color: #1e1e1e; background: #1e1e1e; color: #fff; }

            .kua-note-bar {
                display: flex; align-items: center; flex-wrap: wrap; gap: 6px 10px;
                padding: 8px 12px; margin: 0; border: 1px dashed #c9c7c2; border-radius: 8px;
                background: #f7f6f3; color: #555; font-size: 13px; line-height: 1.4; text-align: left;
            }
            .kua-note-bar[data-kind="revealed"] { border-style: solid; margin-bottom: 6px; }
            .kua-note-bar .kua-note-text { flex: 1 1 200px; min-width: 0; }
            .kua-note-bar button {
                padding: 2px 10px; border-radius: 999px; border: 1px solid #c9c7c2; background: #fff;
                color: #1e1e1e; font: inherit; font-size: 12px; font-weight: 600; cursor: pointer;
            }
            .kua-note-bar button:hover, .kua-note-bar button:focus-visible { border-color: #1e1e1e; outline: none; }

            .kua-pill {
                position: fixed; left: 16px; bottom: 16px; z-index: 2147482500;
                display: inline-flex; align-items: center; gap: 6px;
                padding: 6px 12px; border-radius: 999px; border: 1px solid #d0d0cc;
                background: #fff; color: #1e1e1e; font: inherit; font-size: 13px; font-weight: 600;
                box-shadow: 0 4px 14px rgba(0,0,0,.15); cursor: pointer;
            }
            .kua-pill:hover, .kua-pill:focus-visible { border-color: #1e1e1e; outline: none; }

            .kua-toast, .kua-bar {
                position: fixed; left: 50%; transform: translateX(-50%);
                z-index: 2147483000; max-width: min(620px, calc(100vw - 32px)); box-sizing: border-box;
                display: flex; align-items: center; flex-wrap: wrap; gap: 8px 12px;
                padding: 10px 14px; border-radius: 10px;
                background: #1e1e1e; color: #fff; font: inherit; font-size: 14px; line-height: 1.4;
                box-shadow: 0 8px 24px rgba(0,0,0,.25);
            }
            .kua-toast { bottom: 76px; }
            .kua-bar { bottom: 16px; z-index: 2147482900; }
            .kua-toast[data-kind="ok"] { background: #2e7d32; }
            .kua-toast[data-kind="warn"] { background: #8a4b00; }
            .kua-toast-text { flex: 1 1 220px; }
            .kua-toast button, .kua-bar button {
                padding: 4px 10px; border-radius: 6px; border: 1px solid rgba(255,255,255,.6);
                background: transparent; color: inherit; font: inherit; font-size: 13px; cursor: pointer;
            }
            .kua-toast button:hover, .kua-bar button:hover { background: rgba(255,255,255,.15); }

            .kua-pop, .kua-panel {
                box-sizing: border-box; background: #fff; color: #1e1e1e;
                border: 1px solid #d0d0cc; border-radius: 12px; box-shadow: 0 12px 32px rgba(0,0,0,.22);
                font: inherit; font-size: 14px; line-height: 1.4; text-align: left;
            }
            .kua-pop { position: absolute; z-index: 2147482000; max-height: calc(100vh - 32px); overflow: auto; }
            .kua-pop *, .kua-panel *, .kua-pop *::before, .kua-panel *::before, .kua-pop *::after, .kua-panel *::after { box-sizing: border-box; }
            .kua-overlay {
                position: fixed; inset: 0; z-index: 2147483100; background: rgba(0,0,0,.4);
                display: grid; place-items: center; padding: 16px;
            }
            .kua-panel { width: min(640px, 100%); max-height: calc(100vh - 32px); overflow: auto; }
            .kua-head {
                position: sticky; top: 0; z-index: 1; display: flex; align-items: center; gap: 8px;
                padding: 10px 10px 10px 14px; background: #fff; border-bottom: 1px solid #eceae6;
            }
            .kua-title { flex: 1; min-width: 0; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
            .kua-body { padding: 12px 14px 14px; display: grid; gap: 12px; }
            .kua-section { display: grid; gap: 8px; padding-top: 12px; border-top: 1px solid #eceae6; }
            section.kua-section:first-of-type { padding-top: 0; border-top: 0; }
            .kua-section h3 { margin: 0; font-size: 15px; font-weight: 700; }
            .kua-pop button, .kua-pop input, .kua-pop textarea,
            .kua-panel button, .kua-panel input, .kua-panel textarea { font: inherit; font-size: 14px; color: inherit; }
            .kua-icon-btn {
                flex: none; width: 32px; height: 32px; display: inline-grid; place-items: center;
                border: 0; border-radius: 8px; background: transparent; cursor: pointer; font-size: 18px; line-height: 1;
            }
            .kua-icon-btn:hover, .kua-icon-btn:focus-visible { background: #f2f1ee; outline: none; }
            .kua-field { display: grid; gap: 4px; }
            .kua-field > span { font-size: 12px; font-weight: 600; color: #555; }
            .kua-input { width: 100%; padding: 8px 10px; border: 1px solid #c9c7c2; border-radius: 8px; background: #fff; }
            .kua-input:focus { outline: 2px solid #1e1e1e; outline-offset: -1px; }
            textarea.kua-input { resize: vertical; min-height: 80px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace !important; font-size: 12px !important; }
            .kua-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
            .kua-row .kua-input { flex: 1 1 160px; width: auto; }
            .kua-spacer { flex: 1; }
            .kua-action {
                padding: 7px 14px; border-radius: 999px; border: 1px solid #c9c7c2; background: #fff;
                font-weight: 600; cursor: pointer; white-space: nowrap;
            }
            .kua-action:hover:not(:disabled), .kua-action:focus-visible { border-color: #1e1e1e; outline: none; }
            .kua-action[data-primary] { background: #1e1e1e; border-color: #1e1e1e; color: #fff; }
            .kua-action[data-primary]:hover:not(:disabled) { background: #000; }
            .kua-action[data-danger]:hover:not(:disabled) { border-color: #c62828; color: #c62828; }
            .kua-action:disabled { opacity: .45; cursor: not-allowed; }
            .kua-link { padding: 0; border: 0; background: none; color: #555; text-decoration: underline; font-size: 13px; cursor: pointer; }
            .kua-link:hover { color: #1e1e1e; }
            .kua-hint, .kua-muted { margin: 0; font-size: 12px; color: #6b6b6b; }
            .kua-note { margin: 0; padding: 8px 10px; border-radius: 8px; background: #f2f1ee; font-size: 13px; }
            .kua-note[data-kind="error"] { background: #fdecea; color: #8e1c1c; }
            .kua-note[data-kind="ok"] { background: #edf7ee; color: #1f5e23; }
            .kua-check { display: flex; gap: 8px; align-items: flex-start; font-size: 13px; cursor: pointer; }
            .kua-check input { margin: 2px 0 0; accent-color: #1e1e1e; flex: none; }
            .kua-users { display: grid; gap: 6px; max-height: 320px; overflow: auto; }
            .kua-user { display: flex; gap: 8px; align-items: flex-start; padding: 8px 10px; border: 1px solid #e3e1dc; border-radius: 8px; }
            .kua-user-main { flex: 1; min-width: 0; display: grid; gap: 4px; }
            .kua-user-main a { font-weight: 600; color: inherit; overflow-wrap: anywhere; }
            .kua-user .kua-input { padding: 4px 8px; font-size: 13px; }
            .kua-preview[hidden] { display: none; }
            .kua-preview { display: grid; gap: 8px; padding: 10px; border: 1px solid #c9c7c2; border-radius: 8px; background: #faf9f7; }
            .kua-pick-list { display: grid; gap: 2px; max-height: 240px; overflow: auto; padding: 4px; border: 1px solid #e3e1dc; border-radius: 8px; background: #fff; }
            .kua-pick { padding: 4px 6px; border-radius: 6px; }
            .kua-pick:hover { background: #f2f1ee; }
            .kua-pick a { color: #555; font-size: 12px; }
            .kua-sources { display: grid; gap: 4px; padding-top: 4px; }
        `;
        ensureStyles();
    }

    // ------------------------------------------------------------------
    // Hinweise (Toast) und feste Leiste
    // ------------------------------------------------------------------

    let toastTimer = null;

    function showToast(text, kind, actions = [], autoHideMs = 0) {
        hideToast();
        const toast = el('div', { className: 'kua-ui kua-toast', role: 'status', dataset: kind ? { kind } : null },
            el('span', { className: 'kua-toast-text' }, text),
            actions.map(a => el('button', { type: 'button', onclick: a.onClick }, a.label)),
            el('button', { type: 'button', 'aria-label': 'Hinweis schließen', onclick: hideToast }, '×'));
        document.body.appendChild(toast);
        if (autoHideMs) toastTimer = setTimeout(hideToast, autoHideMs);
    }

    function hideToast() {
        clearTimeout(toastTimer);
        document.querySelectorAll('.kua-toast').forEach(t => t.remove());
    }

    function setBar(content) {
        document.querySelectorAll('.kua-bar').forEach(b => b.remove());
        if (content) document.body.appendChild(el('div', { className: 'kua-ui kua-bar', role: 'status' }, content));
    }

    // ------------------------------------------------------------------
    // Menü an einer Anzeige (Ausblenden / Blockieren)
    // ------------------------------------------------------------------

    let pop = null; // { root, btn, cleanup }

    function closePopover() {
        if (!pop) return;
        pop.cleanup();
        pop.root.remove();
        const btn = pop.btn;
        pop = null;
        if (btn.isConnected) btn.focus({ preventScroll: true });
    }

    function positionPopover() {
        const { root, btn } = pop;
        const r = btn.getBoundingClientRect();
        const vw = document.documentElement.clientWidth;
        const vh = window.innerHeight;
        const width = Math.min(380, vw - 32);
        root.style.width = width + 'px';
        const left = Math.min(Math.max(16, r.right - width), vw - 16 - width);
        const h = root.offsetHeight;
        const below = r.bottom + 8;
        const top = (below + h > vh - 8 && r.top - 8 - h > 8) ? r.top - 8 - h : below;
        root.style.left = (left + window.scrollX) + 'px';
        root.style.top = (top + window.scrollY) + 'px';
    }

    function headBar(title, onClose) {
        return el('div', { className: 'kua-head' },
            el('span', { className: 'kua-title', title }, title),
            el('button', { type: 'button', className: 'kua-icon-btn', 'aria-label': 'Schließen', title: 'Schließen', onclick: onClose }, '×'));
    }

    // info: { adId, href, title, userId?, sellerName? }
    function openPopover(info, btn) {
        if (pop && pop.btn === btn) { closePopover(); return; }
        closePopover();
        closePanel();

        const root = el('div', { className: 'kua-ui kua-pop', role: 'dialog', 'aria-label': 'Ausblenden oder blockieren' });
        const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); closePopover(); } };
        const onOutside = (e) => { if (pop && !root.contains(e.target) && !btn.contains(e.target)) closePopover(); };
        const onResize = () => pop && positionPopover();
        document.addEventListener('keydown', onKey, true);
        document.addEventListener('pointerdown', onOutside, true);
        window.addEventListener('resize', onResize);
        pop = {
            root, btn,
            cleanup: () => {
                document.removeEventListener('keydown', onKey, true);
                document.removeEventListener('pointerdown', onOutside, true);
                window.removeEventListener('resize', onResize);
            },
        };
        document.body.appendChild(root);

        const name = el('input', { className: 'kua-input', type: 'text', maxLength: CONFIG.nameMax, placeholder: 'Name (optional)' });
        const note = el('input', { className: 'kua-input', type: 'text', maxLength: CONFIG.noteMax, placeholder: 'z. B. Lockpreise, Betrugsverdacht' });
        const status = el('p', { className: 'kua-note', role: 'status', hidden: true });
        let resolving = false;

        const render = () => {
            if (!pop || pop.root !== root) return;
            const uid = info.userId;
            const blocked = uid && state.users[uid];
            const adHidden = info.adId && state.ads[info.adId];
            const sellerText = uid
                ? `Anbieter: ${userLabel(uid, info.sellerName)}${isShop(uid) ? ' (Shop)' : ` (ID ${uid})`}`
                : resolving ? 'Anbieter wird ermittelt …' : 'Anbieter unbekannt';

            const parts = [el('p', { className: 'kua-muted' }, sellerText)];
            if (blocked) {
                parts.push(el('p', { className: 'kua-note', dataset: { kind: 'ok' } },
                    `Blockiert seit ${fmtDate(blocked.added)}${blocked.note ? ` · ${blocked.note}` : ''}`
                    + (blocked.source ? ` · aus ${blocked.sub ? 'Abo ' : ''}„${blocked.source}“` : '')));
                parts.push(el('div', { className: 'kua-row' },
                    el('span', { className: 'kua-spacer' }),
                    el('button', { type: 'button', className: 'kua-action', onclick: () => { unblockUser(uid); render(); } }, 'Anbieter freigeben')));
            } else {
                if (!name.value && info.sellerName) name.value = info.sellerName;
                parts.push(
                    el('label', { className: 'kua-field' }, el('span', {}, 'Name in deiner Liste'), name),
                    el('label', { className: 'kua-field' }, el('span', {}, 'Notiz (nur für dich)'), note),
                    el('div', { className: 'kua-row' },
                        el('span', { className: 'kua-spacer' }),
                        el('button', { type: 'button', className: 'kua-action', dataset: { primary: '' }, disabled: !uid,
                            onclick: () => { blockUser(uid, name.value, note.value); closePopover(); } }, 'Anbieter blockieren')));
            }
            parts.push(status);
            if (info.adId && !isDetailPage) {
                parts.push(el('div', { className: 'kua-row' },
                    adHidden
                        ? el('button', { type: 'button', className: 'kua-link', onclick: () => { unhideAd(info.adId); closePopover(); } }, 'Diese Anzeige nicht mehr ausblenden')
                        : el('button', { type: 'button', className: 'kua-link', onclick: () => { hideAd(info.adId); closePopover(); } }, 'Nur diese Anzeige ausblenden')));
            }
            parts.push(el('div', { className: 'kua-row' },
                el('button', { type: 'button', className: 'kua-link', onclick: () => { closePopover(); openPanel(); } }, 'Blockliste verwalten …')));

            root.replaceChildren(headBar(info.title ? `Ausblenden: ${info.title}` : 'Ausblenden', closePopover),
                el('div', { className: 'kua-body' }, parts));
            positionPopover();
        };

        render();
        root.scrollIntoView({ block: 'nearest' });
        (root.querySelector('[data-primary]:not(:disabled)') || root.querySelector('.kua-icon-btn')).focus({ preventScroll: true });

        if (!info.userId && info.href) {
            resolving = true;
            render();
            resolveSeller(info).then(seller => {
                resolving = false;
                if (seller) {
                    info.userId = seller.id;
                    info.sellerName = seller.name;
                    refreshPage();
                } else {
                    setNote(status, 'Der Anbieter ließ sich auf der Anzeigenseite nicht erkennen. Du kannst die Anzeige trotzdem einzeln ausblenden.', 'error');
                }
                render();
            }).catch(() => {
                resolving = false;
                setNote(status, 'Die Anzeigenseite konnte nicht geladen werden. Du kannst die Anzeige trotzdem einzeln ausblenden.', 'error');
                render();
            });
        }
    }

    // ------------------------------------------------------------------
    // Übersicht: Karten finden, ausblenden, Buttons einfügen
    // ------------------------------------------------------------------

    function findAdCards() {
        const cards = new Set();

        // Klassisches Layout
        document.querySelectorAll('article.aditem[data-adid]').forEach(c => cards.add(c));

        // Generisch: vom Anzeigen-Link so weit nach oben laufen, wie der Container
        // nur Links auf genau diese eine Anzeige enthält -> das ist die Karte.
        document.querySelectorAll('a[href*="/s-anzeige/"]').forEach(link => {
            if (link.closest('.kua-ui, article.aditem[data-adid]')) return;
            const adId = getAdIdFromUrl(link.href);
            if (!adId) return;
            let card = null;
            let node = link.parentElement;
            while (node && node !== document.body && containsOnlyAd(node, adId)) {
                card = node;
                node = node.parentElement;
            }
            if (card) cards.add(card);
        });

        return Array.from(cards);
    }

    function containsOnlyAd(node, adId) {
        return Array.from(node.querySelectorAll('a[href*="/s-anzeige/"]'))
            .every(a => getAdIdFromUrl(a.href) === adId);
    }

    const cardInfos = new WeakMap();

    function getCardInfo(card) {
        if (cardInfos.has(card)) return cardInfos.get(card);
        const link = card.querySelector('a[href*="/s-anzeige/"]');
        const rawHref = card.dataset.href || (link ? link.getAttribute('href') : null);
        const href = rawHref ? new URL(rawHref, window.location.origin).href : null;
        const adId = card.dataset.adid || getAdIdFromUrl(href);
        if (!href || !adId) return null;
        const titleEl = card.querySelector('h2, h3, .text-module-begin a, .ellipsis');
        const title = clip(titleEl ? titleEl.textContent : (link ? link.textContent : ''), 120);
        // Falls die Karte selbst auf den Anbieter verlinkt, gleich übernehmen
        const cardSeller = Array.from(card.querySelectorAll('a[href]'))
            .map(a => userIdFromHref(a.getAttribute('href'))).find(Boolean) || null;
        const info = { href, adId, title, cardSeller };
        cardInfos.set(card, info);
        return info;
    }

    // Preis-Bestandteile: "2 €", "3.399 €", "VB", "Zu verschenken", "ab"
    const pricePartsRe = /\d[\d.,]*\s*€|zu verschenken|VB|ab/gi;

    function isPriceOnly(text) {
        const t = text.trim();
        // „VB“ allein (Verhandlungsbasis ohne Betrag) zählt auch als Preis
        return t.length > 0 && (/€|zu verschenken/i.test(t) || /^vb$/i.test(t)) && t.replace(pricePartsRe, '').replace(/\s+/g, '') === '';
    }

    // Buttons dieses und anderer Scripts (Anzeige melden, Superscript) beim Lesen des Preises
    // ignorieren. Sonst findet das zweite Script die Preiszeile nicht mehr, sobald das erste seinen
    // Button hineingesetzt hat, und setzt keinen Button.
    const FOREIGN_UI = '.kua-ui, .klm-wrap, .kps-ui, .kss-ui';

    function textWithoutUi(node) {
        let text = node.textContent;
        node.querySelectorAll(FOREIGN_UI).forEach(ui => { text = text.split(ui.textContent).join(''); });
        return text;
    }

    function findPriceRow(card) {
        const classic = card.querySelector('.aditem-main--middle--price-shipping');
        if (classic) return classic;
        // Erstes reines Preis-Element: keine Kind-Elemente außer fremden Buttons, nur Preistext
        const first = Array.from(card.querySelectorAll('p, span, div, strong, b'))
            .find(n => Array.from(n.children).every(c => c.matches(FOREIGN_UI))
                && !n.closest(FOREIGN_UI) && isPriceOnly(textWithoutUi(n)));
        if (!first) return null;
        let row = first;
        while (row.parentElement && row.parentElement !== card && isPriceOnly(textWithoutUi(row.parentElement))) {
            row = row.parentElement;
        }
        return row;
    }

    // Rückfall ohne Preiszeile (z. B. „VB“ ohne Betrag oder „Zu verschenken“ auf der Startseite,
    // wo die Karte dann keinen Preis zeigt): eigene Button-Zeile unter dem Titel. Die Zeile
    // (.kx-btn-row) teilen sich „Anzeige melden“ und „Nutzer ausblenden“, damit beide Buttons
    // nebeneinander stehen.
    function buttonRowFallback(card) {
        const existing = card.querySelector('.kx-btn-row');
        if (existing) return existing;
        const title = card.querySelector('h2, h3, .text-module-begin a, .ellipsis');
        if (!title) return null;
        const link = title.closest('a');
        const anchor = link && link !== card && card.contains(link) ? link : title;
        const row = document.createElement('div');
        row.className = 'kx-btn-row';
        anchor.insertAdjacentElement('afterend', row);
        return row;
    }

    // Beim Ganz-Ausblenden auch das umgebende <li> ausblenden, sonst bleiben Lücken
    function hideTarget(card, adId) {
        const li = card.parentElement && card.parentElement.closest('li');
        return li && li !== card && containsOnlyAd(li, adId) ? li : card;
    }

    const revealed = new Set(); // in dieser Sitzung vorübergehend eingeblendete Anzeigen

    function cardButton(info) {
        const btn = guardedButton({ className: 'kua-btn', title: 'Anzeige oder Anbieter ausblenden',
            onclick: () => openPopover(info, btn) });
        btn.innerHTML = `${blockSvg}<span>Ausblenden</span>`;
        return btn;
    }

    function noteBar(kind, text, actions) {
        const bar = el('div', { className: 'kua-ui kua-note-bar', dataset: { kind } },
            el('span', { className: 'kua-note-text' }, text),
            actions.map(a => guardedButton({ onclick: a.onClick }, a.label)));
        guard(bar);
        return bar;
    }

    function applyCard(card) {
        const info = getCardInfo(card);
        if (!info) return null;
        if (info.cardSeller) learn(info.adId, info.cardSeller);
        info.userId = info.cardSeller || state.index[info.adId] || null;

        let reason = null;
        if (info.userId && state.users[info.userId] && info.userId !== pageSellerId) reason = 'user';
        else if (state.ads[info.adId]) reason = 'ad';

        const mode = !reason ? 'visible' : revealed.has(info.adId) ? 'revealed' : state.settings.mode === 'hide' ? 'hidden' : 'collapsed';
        const label = reason === 'user' ? userLabel(info.userId) : '';
        const sig = [mode, reason, info.userId, label].join('|');

        // Button neben dem Preis – erneut einsetzen, falls die Seite die Karte neu aufgebaut hat
        const wrap = card.querySelector(':scope .kua-wrap');
        if (!wrap) {
            const row = findPriceRow(card) || buttonRowFallback(card);
            if (row) {
                row.classList.add('kua-price-row');
                row.appendChild(el('span', { className: 'kua-ui kua-wrap' }, cardButton(info)));
            }
        } else if (!wrap.parentElement.classList.contains('kua-price-row')) {
            wrap.parentElement.classList.add('kua-price-row');
        }

        // Neu zeichnen, wenn sich der Zustand geändert hat oder die Seite unsere Änderungen entfernt hat
        const bar = card.querySelector(':scope > .kua-note-bar');
        const intact = card.dataset.kuaSig === sig
            && (card.dataset.kuaState || 'visible') === (mode === 'hidden' ? 'visible' : mode)
            && !!bar === (mode === 'collapsed' || mode === 'revealed')
            && hideTarget(card, info.adId).hasAttribute('data-kua-hidden') === (mode === 'hidden');
        if (!intact) {
            card.dataset.kuaSig = sig;
            card.removeAttribute('data-kua-state');
            hideTarget(card, info.adId).removeAttribute('data-kua-hidden');
            card.querySelectorAll(':scope > .kua-note-bar').forEach(b => b.remove());

            const unblock = reason === 'user'
                ? { label: 'Anbieter freigeben', onClick: () => unblockUser(info.userId) }
                : { label: 'Nicht mehr ausblenden', onClick: () => unhideAd(info.adId) };
            const what = reason === 'user' ? `Anzeige von „${label}“ (blockiert)` : `„${info.title || 'Anzeige ' + info.adId}“`;

            if (mode === 'hidden') {
                hideTarget(card, info.adId).setAttribute('data-kua-hidden', '');
            } else if (mode === 'collapsed') {
                card.dataset.kuaState = 'collapsed';
                card.prepend(noteBar('collapsed', `Ausgeblendet: ${what}`, [
                    { label: 'Kurz zeigen', onClick: () => { revealed.add(info.adId); refreshPage(); } },
                    unblock,
                ]));
            } else if (mode === 'revealed') {
                card.dataset.kuaState = 'revealed';
                card.prepend(noteBar('revealed', reason === 'user' ? `Von „${label}“ (blockiert)` : 'Von dir ausgeblendet', [
                    { label: 'Wieder einklappen', onClick: () => { revealed.delete(info.adId); refreshPage(); } },
                    unblock,
                ]));
            }
        }
        return { info, mode };
    }

    let pill = null;

    function updatePill(hiddenCount) {
        if (!pill) pill = el('button', { type: 'button', className: 'kua-ui kua-pill', onclick: () => openPanel() });
        if (!pill.isConnected) document.body.appendChild(pill);
        const text = hiddenCount ? `${hiddenCount} ausgeblendet` : 'Blockliste';
        if (pill.dataset.text !== text) {
            pill.dataset.text = text;
            pill.innerHTML = blockSvg;
            pill.append(el('span', {}, text));
            pill.title = 'Blockliste verwalten';
        }
    }

    // Unbekannte Anbieter im Hintergrund ermitteln (nur, wenn eingeschaltet)
    const resolveQueue = [];
    const queued = new Set();
    let resolveBusy = false;

    async function pumpResolveQueue() {
        if (resolveBusy) return;
        resolveBusy = true;
        try {
            while (resolveQueue.length && state.settings.autoResolve) {
                const info = resolveQueue.shift();
                if (!state.index[info.adId]) {
                    try { await resolveSeller(info); } catch (e) { /* nächste */ }
                    refreshPage();
                    await sleep(CONFIG.requestGapMs);
                }
            }
        } finally {
            resolveBusy = false;
        }
    }

    function applyOverview() {
        ensureStyles();
        let hiddenCount = 0;
        for (const card of findAdCards()) {
            const res = applyCard(card);
            if (!res) continue;
            if (res.mode === 'hidden' || res.mode === 'collapsed') hiddenCount++;
            if (!res.info.userId && state.settings.autoResolve && !queued.has(res.info.adId) && queued.size < CONFIG.autoResolveMax) {
                queued.add(res.info.adId);
                resolveQueue.push(res.info);
            }
        }
        flushIndex();
        updatePill(hiddenCount);
        if (resolveQueue.length) pumpResolveQueue();
        if (isSellerPage) renderSellerBar();
    }

    function renderSellerBar() {
        if (!pageSellerId) return;
        const blocked = state.users[pageSellerId];
        const key = blocked ? 'b' : 'u';
        const bar = document.querySelector('.kua-bar');
        if (bar && bar.dataset.key === key) return;
        const info = { adId: null, href: null, title: userLabel(pageSellerId), userId: pageSellerId };
        const btn = el('button', { type: 'button' }, blocked ? 'Freigeben' : 'Anbieter blockieren');
        btn.addEventListener('click', () => (blocked ? unblockUser(pageSellerId) : openPopover(info, btn)));
        setBar([
            el('span', { className: 'kua-toast-text' }, blocked
                ? `Diesen Anbieter hast du blockiert (seit ${fmtDate(blocked.added)}). Seine Anzeigen werden in der Suche ausgeblendet.`
                : 'Bestandsliste dieses Anbieters.'),
            btn,
            el('button', { type: 'button', onclick: () => openPanel() }, 'Blockliste'),
        ]);
        document.querySelector('.kua-bar').dataset.key = key;
    }

    function runOverview() {
        // Auf der Bestandsliste gehören alle Anzeigen der Liste zu diesem Anbieter
        if (pageSellerId) mainListAdIds(document).forEach(adId => learn(adId, pageSellerId));

        refreshPage = () => { closeStalePopover(); applyOverview(); };
        applyOverview();
        watchPage(applyOverview);

        setTimeout(() => refreshSubs().then(refreshBlockedSellers), 3000);
    }

    // Das Menü bleibt offen, solange sein Button noch auf der Seite ist
    function closeStalePopover() {
        if (pop && !pop.btn.isConnected) closePopover();
    }

    // ------------------------------------------------------------------
    // Anzeigenseite
    // ------------------------------------------------------------------

    // Der Anbieter-Kasten kann nach dem Laden noch nachgerendert werden: kurz darauf warten
    function runDetail() {
        if (findSeller(document)) { setupDetail(); return; }
        const obs = new MutationObserver(() => {
            if (!findSeller(document)) return;
            obs.disconnect();
            clearTimeout(timer);
            setupDetail();
        });
        obs.observe(document.documentElement, { childList: true, subtree: true });
        const timer = setTimeout(() => obs.disconnect(), 15000);
    }

    function setupDetail() {
        const adId = getAdIdFromUrl(window.location.href);
        const seller = findSeller(document);
        if (!seller) return;
        learn(adId, seller.id);
        flushIndex();

        const h1 = document.querySelector('#viewad-title, h1');
        const info = {
            adId, href: window.location.href.split('#')[0],
            title: clip(h1 ? h1.textContent : '', 120),
            userId: seller.id, sellerName: seller.name,
        };

        // Zwei Bedienelemente: ein Button am Anbieter-Namen und ein fester Button unten links.
        // Der feste Button hängt direkt am <body> und funktioniert auch dann, wenn die Seite
        // den Anbieter-Kasten neu aufbaut und den Button dort wieder entfernt.
        const btn = guardedButton({ className: 'kua-ui kua-btn kua-detail-btn', style: 'margin-left:8px;vertical-align:middle',
            onclick: () => openPopover(info, btn) });
        const fab = el('button', { type: 'button', className: 'kua-ui kua-pill', onclick: () => openPopover(info, fab) });
        let barClosed = false;
        let reinserts = 0;

        const paint = () => {
            const blocked = state.users[seller.id];
            const label = blocked ? 'Blockiert' : 'Blockieren';
            btn.dataset.state = blocked ? 'blocked' : 'idle';
            btn.innerHTML = `${blockSvg}<span>${label}</span>`;
            btn.title = blocked ? 'Du hast diesen Anbieter blockiert' : 'Diesen Anbieter blockieren';
            fab.innerHTML = blockSvg;
            fab.append(el('span', {}, blocked ? 'Anbieter blockiert' : 'Anbieter blockieren'));
            fab.title = btn.title;
            setBar(blocked && !barClosed ? [
                el('span', { className: 'kua-toast-text' }, `Diese Anzeige stammt von „${userLabel(seller.id, seller.name)}“, den du blockiert hast.`),
                el('button', { type: 'button', onclick: () => unblockUser(seller.id) }, 'Freigeben'),
                el('button', { type: 'button', onclick: () => openPanel() }, 'Blockliste'),
                el('button', { type: 'button', 'aria-label': 'Hinweis schließen', onclick: () => { barClosed = true; setBar(null); } }, '×'),
            ] : null);
        };

        // Fehlt etwas (Styles, Buttons, Leiste), wieder einsetzen. Entfernt die Seite den Button
        // am Namen immer wieder, wird es nach 20 Versuchen dort aufgegeben (der feste Button bleibt).
        const ensure = () => {
            ensureStyles();
            if (!fab.isConnected) document.body.appendChild(fab);
            if (!btn.isConnected && reinserts < 20) {
                const again = findSeller(document);
                if (again && again.id === seller.id) {
                    again.el.insertAdjacentElement('afterend', btn);
                    reinserts++;
                }
            }
            if (state.users[seller.id] && !barClosed && !document.querySelector('.kua-bar')) paint();
        };

        seller.el.insertAdjacentElement('afterend', btn);
        refreshPage = () => { closeStalePopover(); paint(); ensure(); };
        refreshPage();
        watchPage(ensure);
    }

    // ------------------------------------------------------------------
    // Blockliste: Export / Import
    // ------------------------------------------------------------------

    // Exportiert wird nur die eigene Liste (inkl. zusammengeführter Listen), keine Abo-Einträge
    const ownUsers = () => Object.entries(state.users).filter(([, u]) => !u.sub);

    function exportJson() {
        const users = ownUsers()
            .sort((a, b) => a[1].added - b[1].added)
            .map(([id, u]) => ({ id, name: u.name, note: u.note, added: new Date(u.added).toISOString(), ...(u.source ? { source: u.source } : {}) }));
        return JSON.stringify({
            format: CONFIG.listFormat,
            version: CONFIG.listFormatVersion,
            title: 'Meine Kleinanzeigen-Blockliste',
            exported: new Date().toISOString(),
            users,
            ads: Object.keys(state.ads),
        }, null, 2) + '\n';
    }

    function exportText() {
        const lines = [
            '! Titel: Meine Kleinanzeigen-Blockliste',
            `! Format: ${CONFIG.listFormat} ${CONFIG.listFormatVersion}`,
            `! Exportiert: ${new Date().toISOString()}`,
            '# Eine Zeile pro Anbieter: <Nutzer-ID> [Name] [# Notiz]',
            '# Einzelne Anzeigen: anzeige:<Anzeigen-Nr>',
        ];
        ownUsers()
            .sort((a, b) => a[1].added - b[1].added)
            .forEach(([id, u]) => {
                let line = id;
                if (u.name) line += ' ' + u.name.replace(/#/g, '');
                if (u.note) line += '  # ' + u.note;
                lines.push(line);
            });
        Object.keys(state.ads).forEach(adId => lines.push(`anzeige:${adId}`));
        return lines.join('\n') + '\n';
    }

    // Liest JSON- oder Textlisten. Liefert { title, users: [{id,name,note,added,source?}], ads: [], invalid }.
    // Mehrfach vorkommende Anbieter/Anzeigen werden nur einmal übernommen.
    function parseList(input) {
        const text = String(input || '').replace(/^\uFEFF/, '').trim();
        const out = { title: '', users: [], ads: [], invalid: 0 };
        const seenUsers = new Set();
        const seenAds = new Set();
        const pushUser = (id, entry) => {
            if (seenUsers.has(id)) return;
            seenUsers.add(id);
            out.users.push({ id, ...cleanUser(entry) });
        };
        const addUser = (raw) => {
            const entry = typeof raw === 'string' ? { id: raw } : raw;
            const id = isObj(entry) ? normalizeUserId(entry.id) : null;
            if (!id) { out.invalid++; return; }
            pushUser(id, entry);
        };
        const addAd = (raw) => {
            const adId = /^\d{1,15}$/.test(String(raw)) ? String(raw) : getAdIdFromUrl(raw);
            if (!adId) { out.invalid++; return; }
            if (!seenAds.has(adId)) { seenAds.add(adId); out.ads.push(adId); }
        };

        if (text.startsWith('{') || text.startsWith('[')) {
            let data;
            try { data = JSON.parse(text); } catch (e) { throw new Error('Die JSON-Datei ist fehlerhaft.'); }
            if (Array.isArray(data)) data = { users: data };
            if (!isObj(data)) throw new Error('Unbekanntes Format.');
            if (data.format && data.format !== CONFIG.listFormat) throw new Error(`Unbekanntes Listenformat „${String(data.format).slice(0, 40)}“.`);
            out.title = clip(data.title, 120);
            (Array.isArray(data.users) ? data.users : []).forEach(addUser);
            (Array.isArray(data.ads) ? data.ads : []).forEach(addAd);
            return out;
        }

        for (const rawLine of text.split(/\r?\n/)) {
            const line = rawLine.trim();
            if (!line) continue;
            if (line.startsWith('!')) {
                const m = line.match(/^!\s*(?:titel|title)\s*:\s*(.+)$/i);
                if (m) out.title = clip(m[1], 120);
                continue;
            }
            if (line.startsWith('#')) continue;
            const hash = line.indexOf('#');
            const main = (hash >= 0 ? line.slice(0, hash) : line).trim();
            const note = hash >= 0 ? line.slice(hash + 1).trim() : '';
            const token = main.split(/\s+/)[0];
            const adMatch = token.match(/^anzeige:(\d{1,15})$/i);
            if (adMatch || getAdIdFromUrl(token)) { addAd(adMatch ? adMatch[1] : token); continue; }
            const id = normalizeUserId(token);
            if (!id) { out.invalid++; continue; }
            pushUser(id, { name: main.slice(token.length), note });
        }
        return out;
    }

    // Führt eine Liste mit der eigenen zusammen (oder ersetzt sie).
    // opts: { replace, selected: Set der zu übernehmenden IDs, includeAds, source }
    // Vorhandene Einträge bleiben unverändert; nur leerer Name/leere Notiz werden ergänzt.
    function importList(list, opts = {}) {
        const result = { added: 0, existing: 0, ads: 0 };
        if (opts.replace) {
            state.users = {};
            state.ads = {};
        }
        const source = clip(opts.source, CONFIG.sourceMax);
        for (const u of list.users) {
            const cur = state.users[u.id];
            if (cur) {
                result.existing++;
                if (!cur.name && u.name) cur.name = u.name;
                if (!cur.note && u.note) cur.note = u.note;
            } else if (!opts.selected || opts.selected.has(u.id)) {
                state.users[u.id] = cleanUser({ ...u, source: source || u.source });
                result.added++;
            }
        }
        if (opts.includeAds !== false) {
            for (const adId of list.ads) {
                if (!state.ads[adId]) { state.ads[adId] = Date.now(); result.ads++; }
            }
        }
        saveUsers();
        saveAds();
        refreshPage();
        return result;
    }

    function download(filename, text, type) {
        const url = URL.createObjectURL(new Blob([text], { type }));
        const a = el('a', { href: url, download: filename, style: 'display:none' });
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
    }

    async function copyText(text) {
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch (e) {
            const ta = el('textarea', { value: text, style: 'position:fixed;left:-9999px;top:0' });
            document.body.appendChild(ta);
            ta.select();
            let ok = false;
            try { ok = document.execCommand('copy'); } catch (e2) { ok = false; }
            ta.remove();
            return ok;
        }
    }

    // ------------------------------------------------------------------
    // Verwaltung (Dialog)
    // ------------------------------------------------------------------

    let panel = null; // { overlay, box, note, preview, cleanup }

    function closePanel() {
        if (!panel) return;
        panel.cleanup();
        panel.overlay.remove();
        panel = null;
    }

    function openPanel() {
        closePopover();
        closePanel();
        const box = el('div', { className: 'kua-panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Blockliste' });
        const overlay = el('div', { className: 'kua-ui kua-overlay' }, box);
        overlay.addEventListener('pointerdown', e => { if (e.target === overlay) closePanel(); });
        const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); closePanel(); } };
        document.addEventListener('keydown', onKey, true);
        panel = { overlay, box, note: null, preview: null, cleanup: () => document.removeEventListener('keydown', onKey, true) };
        document.body.appendChild(overlay);
        renderPanel();
        const first = box.querySelector('input');
        if (first) first.focus();
    }

    function renderPanel() {
        if (!panel) return;
        const { box } = panel;
        const scrollTop = box.scrollTop;
        const ids = Object.keys(state.users).filter(id => !state.users[id].sub);
        const adCounts = {};
        Object.values(state.index).forEach(uid => { if (state.users[uid]) adCounts[uid] = (adCounts[uid] || 0) + 1; });

        // --- Anbieter hinzufügen
        const addId = el('input', { className: 'kua-input', type: 'text', placeholder: 'Nutzer-ID oder Link zum Anbieter', 'aria-label': 'Nutzer-ID oder Link zum Anbieter' });
        const addName = el('input', { className: 'kua-input', type: 'text', maxLength: CONFIG.nameMax, placeholder: 'Name (optional)', 'aria-label': 'Name' });
        const addStatus = el('p', { className: 'kua-note', role: 'status', hidden: true });
        const doAdd = () => {
            const id = normalizeUserId(addId.value);
            if (!id) {
                setNote(addStatus, 'Keine gültige Nutzer-ID. Erwartet wird z. B. 12345678, ein Link wie …/s-bestandsliste.html?userId=12345678 oder ein Shop-Link wie …/pro/shop-name.', 'error');
                return;
            }
            if (state.users[id]) {
                setNote(addStatus, `„${userLabel(id)}“ ist bereits blockiert.`, 'ok');
                return;
            }
            blockUser(id, addName.value, '');
            renderPanel();
        };
        addId.addEventListener('keydown', e => { if (e.key === 'Enter') doAdd(); });

        // --- Liste
        const filter = el('input', { className: 'kua-input', type: 'search', placeholder: 'Liste durchsuchen', 'aria-label': 'Liste durchsuchen' });
        const listBox = el('div', { className: 'kua-users' });
        const drawList = () => {
            const q = filter.value.trim().toLowerCase();
            const rows = ids
                .filter(id => state.users[id])
                .sort((a, b) => state.users[b].added - state.users[a].added)
                .filter(id => !q || [id, state.users[id].name, state.users[id].note, state.users[id].source].join(' ').toLowerCase().includes(q))
                .map(id => {
                    const u = state.users[id];
                    const noteInput = el('input', { className: 'kua-input', type: 'text', value: u.note, maxLength: CONFIG.noteMax,
                        placeholder: 'Notiz', 'aria-label': `Notiz zu ${userLabel(id)}`,
                        onchange: (e) => { if (state.users[id]) { state.users[id].note = clip(e.target.value, CONFIG.noteMax); saveUsers(); } } });
                    const known = adCounts[id] || 0;
                    return el('div', { className: 'kua-user' },
                        el('div', { className: 'kua-user-main' },
                            el('a', { href: CONFIG.sellerUrl(id), target: '_blank', rel: 'noopener' }, userLabel(id)),
                            el('span', { className: 'kua-muted' },
                                `${isShop(id) ? 'Shop' : 'ID ' + id} · seit ${fmtDate(u.added)} · ${known} bekannte Anzeige${known === 1 ? '' : 'n'}`
                                + (state.scanned[id] ? ` · ${sellerPageName(id)} geprüft ${fmtDate(state.scanned[id])}` : '')
                                + (u.source ? ` · aus „${u.source}“` : '')),
                            noteInput),
                        el('button', { type: 'button', className: 'kua-action', dataset: { danger: '' },
                            onclick: () => { unblockUser(id); renderPanel(); } }, 'Freigeben'));
                });
            listBox.replaceChildren(...(rows.length ? rows : [el('p', { className: 'kua-hint' },
                ids.length ? 'Keine Treffer.' : 'Noch niemand blockiert. Nutze „Ausblenden“ an einer Anzeige oder füge oben eine Nutzer-ID hinzu.')]));
        };
        filter.addEventListener('input', drawList);
        drawList();

        // --- Einzelne Anzeigen
        const hiddenAds = Object.keys(state.ads).length;

        // --- Einstellungen
        const setting = (key, value) => { state.settings[key] = value; saveSettings(); refreshPage(); };
        const modeRadio = (value, text) => el('label', { className: 'kua-check' },
            el('input', { type: 'radio', name: 'kua-mode', value, checked: state.settings.mode === value,
                onchange: () => setting('mode', value) }), el('span', {}, text));
        const checkbox = (key, text) => el('label', { className: 'kua-check' },
            el('input', { type: 'checkbox', checked: state.settings[key], onchange: (e) => setting(key, e.target.checked) }),
            el('span', {}, text));

        // --- Liste hinzufügen: erst prüfen (Vorschau mit Auswahl), dann zusammenführen
        const importText = el('textarea', { className: 'kua-input', rows: 4, spellcheck: false,
            placeholder: 'Liste hier einfügen (JSON oder eine Nutzer-ID pro Zeile)', 'aria-label': 'Liste zum Hinzufügen' });
        const ioStatus = el('p', { className: 'kua-note', role: 'status', hidden: true });
        const showIo = (msg, kind) => setNote(ioStatus, msg, kind);
        const startPreview = (text, fallbackTitle) => {
            let list;
            try { list = parseList(text); } catch (e) { showIo(e.message, 'error'); return; }
            if (!list.users.length && !list.ads.length) {
                showIo(`Keine Einträge gefunden${list.invalid ? ` (${list.invalid} ungültige Zeilen)` : ''}.`, 'error');
                return;
            }
            panel.preview = {
                list,
                source: list.title || fallbackTitle || 'Importierte Liste',
                selected: new Set(list.users.filter(u => !state.users[u.id]).map(u => u.id)),
                includeAds: true,
                replace: false,
            };
            panel.note = null;
            renderPanel();
            const target = panel.box.querySelector('.kua-preview');
            if (target) target.scrollIntoView({ block: 'nearest' });
        };
        const fileInput = el('input', { type: 'file', accept: '.json,.txt,application/json,text/plain', hidden: true,
            onchange: async (e) => {
                const file = e.target.files && e.target.files[0];
                if (!file) return;
                if (file.size > 2 * 1024 * 1024) { showIo('Die Datei ist zu groß (max. 2 MB).', 'error'); return; }
                startPreview(await file.text(), file.name.replace(/\.(json|txt)$/i, ''));
                e.target.value = '';
            } });

        const previewBox = el('div', { className: 'kua-preview', hidden: true });
        const drawPreview = () => {
            const pv = panel.preview;
            previewBox.hidden = !pv;
            if (!pv) { previewBox.replaceChildren(); return; }
            const { list } = pv;
            // Beim Hinzufügen nur Anbieter zur Auswahl stellen, die noch nicht in der Liste sind
            const candidates = pv.replace ? list.users : list.users.filter(u => !state.users[u.id]);
            const known = list.users.length - candidates.length;
            const summary = `${list.title ? `„${list.title}“: ` : ''}${list.users.length} Anbieter`
                + (pv.replace ? '' : ` (${candidates.length} neu, ${known} schon in deiner Liste)`)
                + (list.ads.length ? `, ${list.ads.length} einzelne Anzeige${list.ads.length === 1 ? '' : 'n'}` : '')
                + (list.invalid ? `, ${list.invalid} ungültige Zeile${list.invalid === 1 ? '' : 'n'} übersprungen` : '') + '.';

            const mergeBtn = el('button', { type: 'button', className: 'kua-action', dataset: { primary: '' } });
            const updateMergeBtn = () => {
                const n = candidates.filter(u => pv.selected.has(u.id)).length;
                mergeBtn.textContent = pv.replace ? `Liste ersetzen (${n} Anbieter)` : `${n} Anbieter hinzufügen`;
                mergeBtn.disabled = !n && !(pv.includeAds && list.ads.length);
            };
            const select = (all) => {
                candidates.forEach(u => (all ? pv.selected.add(u.id) : pv.selected.delete(u.id)));
                drawPreview();
            };
            const rows = candidates.map(u => el('label', { className: 'kua-check kua-pick' },
                el('input', { type: 'checkbox', checked: pv.selected.has(u.id),
                    onchange: (e) => { if (e.target.checked) pv.selected.add(u.id); else pv.selected.delete(u.id); updateMergeBtn(); } }),
                el('span', {},
                    el('strong', {}, userLabel(u.id, u.name)),
                    ` · ${isShop(u.id) ? 'Shop' : 'ID ' + u.id}${u.note ? ` · ${u.note}` : ''} `,
                    el('a', { href: CONFIG.sellerUrl(u.id), target: '_blank', rel: 'noopener' }, 'ansehen'))));
            const modeRadio = (replace, text) => el('label', { className: 'kua-check' },
                el('input', { type: 'radio', name: 'kua-merge-mode', checked: pv.replace === replace,
                    onchange: () => {
                        pv.replace = replace;
                        pv.selected = new Set((replace ? list.users : list.users.filter(u => !state.users[u.id])).map(u => u.id));
                        drawPreview();
                    } }),
                el('span', {}, text));

            mergeBtn.addEventListener('click', () => {
                if (pv.replace && !window.confirm('Deine bisherige Blockliste wird vollständig durch diese Liste ersetzt. Fortfahren?')) return;
                const r = importList(list, { replace: pv.replace, selected: pv.selected, includeAds: pv.includeAds,
                    source: pv.replace ? '' : pv.source });
                panel.preview = null;
                renderPanel();
                const name = pv.replace ? list.title : (clip(pv.source, CONFIG.sourceMax) || list.title);
                showPanelNote(`${pv.replace ? 'Liste ersetzt' : 'Liste zusammengeführt'}${name ? ` („${name}“)` : ''}: `
                    + `${r.added} Anbieter hinzugefügt${r.existing ? `, ${r.existing} ${r.existing === 1 ? 'war' : 'waren'} schon in deiner Liste` : ''}`
                    + `${r.ads ? `, ${r.ads} einzelne Anzeige${r.ads === 1 ? '' : 'n'}` : ''}.`
                    + (r.added ? ` Die Anzeigen der neuen Anbieter werden nach und nach eingelesen (bis zu ${CONFIG.refreshPerVisit} Anbieter pro Seitenaufruf).` : ''), 'ok');
                if (r.added) refreshBlockedSellers().then(() => renderPanel());
            });

            previewBox.replaceChildren(
                el('p', { className: 'kua-note' }, summary),
                modeRadio(false, 'Zu meiner Liste hinzufügen (empfohlen): deine Einträge bleiben, nur neue Anbieter kommen dazu'),
                modeRadio(true, 'Meine Liste ersetzen: die bisherige Blockliste wird gelöscht'),
                pv.replace ? null : el('label', { className: 'kua-field' },
                    el('span', {}, 'Herkunft (wird bei den neuen Einträgen vermerkt, damit du sie später gemeinsam entfernen kannst)'),
                    el('input', { className: 'kua-input', type: 'text', value: pv.source, maxLength: CONFIG.sourceMax,
                        oninput: (e) => { pv.source = e.target.value; } })),
                candidates.length ? el('div', { className: 'kua-row' },
                    el('span', { className: 'kua-spacer kua-muted' }, pv.replace ? 'Anbieter der Liste' : 'Neue Anbieter'),
                    el('button', { type: 'button', className: 'kua-link', onclick: () => select(true) }, 'Alle'),
                    el('button', { type: 'button', className: 'kua-link', onclick: () => select(false) }, 'Keine')) : null,
                candidates.length ? el('div', { className: 'kua-pick-list' }, rows)
                    : el('p', { className: 'kua-hint' }, 'Alle Anbieter dieser Liste sind schon in deiner Liste.'),
                list.ads.length ? el('label', { className: 'kua-check' },
                    el('input', { type: 'checkbox', checked: pv.includeAds, onchange: (e) => { pv.includeAds = e.target.checked; updateMergeBtn(); } }),
                    el('span', {}, `${list.ads.length} einzeln ausgeblendete Anzeige${list.ads.length === 1 ? '' : 'n'} übernehmen`)) : null,
                el('div', { className: 'kua-row' },
                    el('span', { className: 'kua-spacer' }),
                    el('button', { type: 'button', className: 'kua-action', onclick: () => { panel.preview = null; drawPreview(); } }, 'Abbrechen'),
                    mergeBtn));
            updateMergeBtn();
        };
        drawPreview();

        // --- Übernommene Listen (Herkunft) mit "Alle freigeben"
        const sources = {};
        ids.forEach(id => { const src = state.users[id].source; if (src) sources[src] = (sources[src] || 0) + 1; });
        const removeSource = (src) => {
            let n = 0;
            Object.keys(state.users).forEach(id => { if (state.users[id].source === src) { delete state.users[id]; n++; } });
            saveUsers();
            refreshPage();
            renderPanel();
            showPanelNote(`${n} Anbieter aus „${src}“ freigegeben.`, 'ok');
        };
        const sourcesBox = Object.keys(sources).length ? el('div', { className: 'kua-sources' },
            el('span', { className: 'kua-muted' }, 'Übernommene Listen:'),
            Object.entries(sources).sort((a, b) => b[1] - a[1]).map(([src, n]) => el('div', { className: 'kua-row' },
                el('span', { className: 'kua-spacer' }, `„${src}“ · ${n} Anbieter`),
                el('button', { type: 'button', className: 'kua-action', dataset: { danger: '' },
                    onclick: () => {
                        if (!window.confirm(`Alle ${n} Anbieter aus „${src}“ freigeben? Deine eigenen Einträge bleiben erhalten.`)) return;
                        removeSource(src);
                    } }, 'Alle freigeben')))) : null;
        // --- Abonnierte Listen
        const subUrl = el('input', { className: 'kua-input', type: 'url', placeholder: 'https://… (Adresse der Liste)', 'aria-label': 'Adresse der Liste' });
        const subStatus = el('p', { className: 'kua-note', role: 'status', hidden: true });
        const subCounts = {};
        Object.values(state.users).forEach(u => { if (u.sub) subCounts[u.sub] = (subCounts[u.sub] || 0) + 1; });
        const subResultText = (r) => `„${r.title}“: ${r.total} Anbieter in der Liste`
            + (r.added || r.removed ? ` (${r.added} neu, ${r.removed} entfernt)` : ', keine Änderungen') + '.';
        const doSubscribe = async () => {
            const url = normalizeListUrl(subUrl.value);
            if (!url) { setNote(subStatus, 'Bitte eine vollständige https-Adresse angeben, z. B. https://raw.githubusercontent.com/…/liste.txt.', 'error'); return; }
            if (state.subs[url]) { setNote(subStatus, 'Diese Liste ist bereits abonniert.', 'ok'); return; }
            state.subs[url] = { title: '', added: Date.now(), lastCheck: 0, lastSuccess: 0, error: '', excluded: [] };
            setNote(subStatus, 'Liste wird geladen …');
            try {
                const r = await syncSub(url);
                renderPanel();
                showPanelNote(`Abonniert: ${subResultText(r)}`
                    + (r.added ? ` Die Anzeigen der neuen Anbieter werden nach und nach eingelesen (bis zu ${CONFIG.refreshPerVisit} Anbieter pro Seitenaufruf).` : ''), 'ok');
                if (r.added) refreshBlockedSellers().then(() => renderPanel());
            } catch (e) {
                delete state.subs[url];
                saveSubs();
                setNote(subStatus, `Die Liste konnte nicht geladen werden: ${e.message}. Nichts wurde abonniert.`, 'error');
            }
        };
        subUrl.addEventListener('keydown', e => { if (e.key === 'Enter') doSubscribe(); });
        const fmtTime = (ts) => (ts ? new Date(ts).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' }) : 'nie');
        const subRows = Object.entries(state.subs).sort((a, b) => a[1].added - b[1].added).map(([url, sub]) => {
            const n = subCounts[url] || 0;
            const update = async () => {
                try {
                    const r = await syncSub(url);
                    renderPanel();
                    if (r) showPanelNote(`Aktualisiert: ${subResultText(r)}`, 'ok');
                    if (r && r.added) refreshBlockedSellers().then(() => renderPanel());
                } catch (e) {
                    renderPanel();
                    showPanelNote(`„${sub.title || url}“ konnte nicht geladen werden: ${e.message}.`, 'error');
                }
            };
            return el('div', { className: 'kua-user' },
                el('div', { className: 'kua-user-main' },
                    el('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, sub.title || url),
                    el('span', { className: 'kua-muted' }, `${n} Anbieter · zuletzt aktualisiert ${fmtTime(sub.lastSuccess)}`
                        + (sub.excluded.length ? ` · ${sub.excluded.length} Ausnahme${sub.excluded.length === 1 ? '' : 'n'}` : '')),
                    sub.error ? el('span', { className: 'kua-muted', style: 'color:#8e1c1c' }, `Letzter Abruf fehlgeschlagen: ${sub.error}`) : null,
                    sub.excluded.length ? el('button', { type: 'button', className: 'kua-link', style: 'justify-self:start',
                        onclick: () => { sub.excluded = []; saveSubs(); update(); } }, 'Ausnahmen zurücksetzen') : null),
                el('div', { className: 'kua-row', style: 'flex-direction:column;align-items:stretch;gap:4px' },
                    el('button', { type: 'button', className: 'kua-action', onclick: update }, 'Aktualisieren'),
                    el('button', { type: 'button', className: 'kua-action', dataset: { danger: '' },
                        onclick: () => {
                            if (!window.confirm(`Abo „${sub.title || url}“ entfernen? Die ${n} Anbieter daraus werden freigegeben, deine eigenen Einträge bleiben.`)) return;
                            removeSub(url);
                            renderPanel();
                            showPanelNote(`Abo entfernt, ${n} Anbieter freigegeben.`, 'ok');
                        } }, 'Entfernen')));
        });
        const subCount = Object.keys(state.subs).length;
        const subTotal = Object.values(subCounts).reduce((a, b) => a + b, 0);

        const stamp = new Date().toISOString().slice(0, 10);
        const exportStatus = el('p', { className: 'kua-note', role: 'status', hidden: true });

        const body = el('div', { className: 'kua-body' },
            el('div', { className: 'kua-note', role: 'status', hidden: !panel.note, dataset: panel.note && panel.note.kind ? { slot: 'note', kind: panel.note.kind } : { slot: 'note' } },
                panel.note ? panel.note.msg : ''),
            el('section', { className: 'kua-section' },
                el('h3', {}, `Blockierte Anbieter (${ids.length})`),
                el('div', { className: 'kua-row' }, addId, addName,
                    el('button', { type: 'button', className: 'kua-action', dataset: { primary: '' }, onclick: doAdd }, 'Blockieren')),
                addStatus,
                ids.length > 5 ? filter : null,
                listBox,
                sourcesBox),
            el('section', { className: 'kua-section' },
                el('h3', {}, `Abonnierte Listen (${subCount})`),
                el('p', { className: 'kua-hint' }, 'Eine Liste unter einer festen Adresse abonnieren, z. B. eine Datei in einem GitHub-Repo. '
                    + 'Sie wird einmal täglich neu geladen: neue Anbieter kommen dazu, entfernte fallen weg. Gibst du einen Anbieter aus einem Abo frei, bleibt er freigegeben. '
                    + 'Beim Abruf sieht der Server der Liste deine IP-Adresse; es werden keine Daten mitgeschickt.'),
                el('div', { className: 'kua-row' }, subUrl,
                    el('button', { type: 'button', className: 'kua-action', dataset: { primary: '' }, onclick: doSubscribe }, 'Abonnieren')),
                subStatus,
                subRows.length ? el('div', { className: 'kua-users' }, subRows) : null,
                subTotal ? el('p', { className: 'kua-hint' }, `Zusammen ${subTotal} Anbieter aus Abos. Sie stehen nicht in der Liste oben und werden nicht exportiert.`) : null),
            el('section', { className: 'kua-section' },
                el('h3', {}, 'Einzeln ausgeblendete Anzeigen'),
                el('div', { className: 'kua-row' },
                    el('span', { className: 'kua-spacer' }, `${hiddenAds} Anzeige${hiddenAds === 1 ? '' : 'n'}`),
                    el('button', { type: 'button', className: 'kua-action', disabled: !hiddenAds,
                        onclick: () => {
                            if (!window.confirm('Alle einzeln ausgeblendeten Anzeigen wieder einblenden?')) return;
                            state.ads = {}; saveAds(); refreshPage(); renderPanel();
                        } }, 'Alle wieder einblenden'))),
            el('section', { className: 'kua-section' },
                el('h3', {}, 'Darstellung'),
                modeRadio('collapse', 'Einklappen: eine Hinweiszeile bleibt stehen (mit „Kurz zeigen“ und „Freigeben“)'),
                modeRadio('hide', 'Ganz ausblenden: die Anzeige verschwindet aus der Liste'),
                el('h3', {}, 'Erkennung'),
                checkbox('dailyRefresh', 'Bestandslisten bzw. Shop-Seiten blockierter Anbieter einmal täglich neu einlesen, damit auch neue Anzeigen erkannt werden (empfohlen)'),
                checkbox('autoResolve', 'Unbekannte Anzeigen der Übersicht im Hintergrund prüfen (lädt dafür bis zu 30 Anzeigenseiten pro Seitenaufruf)')),
            el('section', { className: 'kua-section' },
                el('h3', {}, 'Liste hinzufügen (zusammenführen)'),
                el('p', { className: 'kua-hint' }, 'Eine fremde oder eigene Liste (JSON oder Textliste) prüfen und mit deiner Blockliste zusammenführen. Vor dem Übernehmen siehst du, welche Anbieter neu dazukommen.'),
                el('div', { className: 'kua-row' },
                    el('button', { type: 'button', className: 'kua-action', onclick: () => fileInput.click() }, 'Datei wählen …'),
                    fileInput),
                importText,
                el('div', { className: 'kua-row' },
                    el('span', { className: 'kua-spacer' }),
                    el('button', { type: 'button', className: 'kua-action', onclick: () => startPreview(importText.value, '') }, 'Eingefügte Liste prüfen')),
                ioStatus,
                previewBox),
            el('section', { className: 'kua-section' },
                el('h3', {}, 'Export'),
                el('div', { className: 'kua-row' },
                    el('button', { type: 'button', className: 'kua-action',
                        onclick: () => download(`kleinanzeigen-blockliste-${stamp}.json`, exportJson(), 'application/json') }, 'Als JSON speichern'),
                    el('button', { type: 'button', className: 'kua-action',
                        onclick: () => download(`kleinanzeigen-blockliste-${stamp}.txt`, exportText(), 'text/plain') }, 'Als Textliste speichern'),
                    el('button', { type: 'button', className: 'kua-action',
                        onclick: async () => setNote(exportStatus, await copyText(exportText()) ? 'Textliste in die Zwischenablage kopiert.' : 'Kopieren nicht möglich.') }, 'Kopieren')),
                exportStatus,
                el('p', { className: 'kua-hint' }, 'Gespeichert wird nur lokal in deinem Browser bzw. in deinem Userscript-Manager. Es werden keine Daten an fremde Server gesendet.')),
            el('p', { className: 'kua-hint' }, `Nutzer ausblenden ${VERSION} · `,
                el('a', { href: 'https://github.com/RainbowLabsInc/Kleinanzeigen.de-User_ausblenden', target: '_blank', rel: 'noopener' }, 'Projektseite')));

        box.replaceChildren(headBar('Blockliste', closePanel), body);
        box.scrollTop = scrollTop;
    }

    // Bleibt beim Neuzeichnen stehen (z. B. wenn danach Bestandslisten fertig geladen sind)
    function showPanelNote(msg, kind) {
        if (!panel) return;
        panel.note = { msg, kind };
        const slot = panel.box.querySelector('[data-slot="note"]');
        if (!slot) return;
        setNote(slot, msg, kind);
        panel.box.scrollTop = 0;
    }

    // ------------------------------------------------------------------
    // Änderungen aus anderen Tabs übernehmen
    // ------------------------------------------------------------------

    function onExternalChange() {
        const pending = pendingIndex;
        state = loadState();
        Object.assign(state.index, pending);
        refreshPage();
        if (panel) renderPanel();
    }

    function watchStorage() {
        const keys = [CONFIG.keys.users, CONFIG.keys.ads, CONFIG.keys.settings, CONFIG.keys.subs];
        if (hasGM && typeof GM_addValueChangeListener === 'function') {
            keys.forEach(k => GM_addValueChangeListener(k, (name, oldValue, newValue, remote) => { if (remote) onExternalChange(); }));
        } else if (!hasGM) {
            window.addEventListener('storage', e => { if (keys.includes(e.key)) onExternalChange(); });
        }
    }

    // ------------------------------------------------------------------
    // Start
    // ------------------------------------------------------------------

    injectStyles();
    watchStorage();
    if (typeof GM_registerMenuCommand === 'function') {
        GM_registerMenuCommand('Blockliste verwalten', () => openPanel());
    }

    if (isDetailPage) {
        runDetail();
    } else {
        runOverview();
    }
})();
});

// ========================================================================
// Modul „Preisverlauf & Gesehen“ 0.2.3: src/preisverlauf.js
// Nur im Superscript
// ========================================================================
KS.module("preisverlauf", {"label":"Preisverlauf & Gesehen","version":"0.2.3","description":"Preisänderungen, „Neu“ seit dem letzten Besuch einer Suche und schon gesehene Anzeigen markieren."}, function () {
/*
 * Modul: Preisverlauf & Gesehen
 * -----------------------------
 * Merkt sich lokal jede Anzeige, die in deinen Suchergebnissen auftaucht: Preis (nur bei
 * Änderungen, mit Datum), wann du sie zum ersten Mal gesehen und wann du sie geöffnet hast.
 * Es stellt dafür keine Anfragen an Kleinanzeigen, sondern liest nur, was ohnehin auf der
 * Seite steht.
 *
 * 1. Übersicht (Suchergebnisse, Bestandslisten, /s-..., und die Startseite): Unter dem Preis jeder Karte
 *    erscheinen kleine Markierungen:
 *      - „↓ vorher 120 €“ / „↑ vorher 95 €“, wenn sich der Preis seit dem letzten Sehen
 *        geändert hat (Klick: kompletter Verlauf mit Datum),
 *      - „Neu“ für Anzeigen, die bei deinem letzten Besuch derselben Suche noch nicht da waren
 *        (nicht auf der Startseite, sie ist keine Suche),
 *      - „Gesehen“ / „Geöffnet“ für Anzeigen, die du schon kennst. Diese lassen sich
 *        zusätzlich abdunkeln (außer, ihr Preis hat sich gerade geändert).
 * 2. Anzeigenseite (/s-anzeige/...): merkt sich das Öffnen und den Preis; unter dem Preis
 *    steht der bisherige Verlauf.
 *
 * „Gesehen“ heißt: Die Karte war mindestens zur Hälfte im sichtbaren Bereich. Ein Besuch einer
 * Suche endet nach 30 Minuten ohne Seitenaufruf in diesem Tab; Seite 2, 3 … zählen zur selben Suche.
 */

(function () {
    'use strict';

    const CONFIG = {
        keys: {
            ads: 'kps-ads',             // { <adId>: { f, l, o, p: [[Zeit, Preistext], ...] } }
            searches: 'kps-searches',   // { <Suche>: <Beginn des letzten Besuchs> }
            settings: 'kps-settings',
        },
        defaultSettings: {
            priceBadges: true,          // Preisänderungen an der Karte zeigen
            newBadges: true,            // „Neu“ seit dem letzten Besuch derselben Suche
            seenLabels: true,           // „Gesehen“ / „Geöffnet“
            dim: 'seen',                // 'seen' = gesehene + geöffnete, 'opened' = nur geöffnete, 'off'
        },
        // So viele Anzeigen merken; zuerst fallen die heraus, die am längsten nicht mehr auftauchten
        adsMax: 20000,
        searchesMax: 300,
        // Preisänderungen pro Anzeige
        historyMax: 12,
        // Besuch einer Suche endet nach so langer Pause (pro Tab)
        visitIdleMs: 30 * 60 * 1000,
        visitKeyPrefix: 'kps-visit:',
        // Anteil der Karte, der sichtbar sein muss, damit sie als gesehen gilt
        seenThreshold: 0.5,
        flushDelayMs: 1500,
        // Preis auf der Anzeigenseite (Stand 10/2026, Rückfall: reiner Preistext nahe der Überschrift)
        detailPriceSelectors: ['#viewad-price'],
        // Bedienelemente anderer Module, die beim Lesen des Preises ignoriert werden
        foreignUi: '.kps-ui, .klm-wrap, .klm-menu, .kua-ui',
    };

    const { el, load, save, isObj } = KS;

    const path = window.location.pathname;
    const isDetailPage = path.startsWith('/s-anzeige/');

    // ------------------------------------------------------------------
    // Helfer
    // ------------------------------------------------------------------

    const clip = (v, n) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : '');
    const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
    const fmtDate = (ts) => new Date(ts).toLocaleDateString('de-DE');
    const fmtDay = (ts) => new Date(ts).toLocaleDateString('de-DE', { day: 'numeric', month: 'numeric' });
    const fmtTime = (ts) => new Date(ts).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });

    function getAdIdFromUrl(url) {
        // /s-anzeige/<slug>/<adId>-<kategorie>-<ort>
        const m = String(url || '').match(/\/s-anzeige\/[^/]+\/(\d+)/);
        return m ? m[1] : null;
    }

    // Klicks in komplett verlinkten Karten dürfen nicht zur Anzeige navigieren
    function guard(node) {
        ['mousedown', 'mouseup', 'pointerdown', 'pointerup'].forEach(t => node.addEventListener(t, e => e.stopPropagation()));
        node.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); });
        return node;
    }

    // ------------------------------------------------------------------
    // Preise lesen
    // ------------------------------------------------------------------

    // Preis-Bestandteile: "2 €", "3.399 €", "VB", "Zu verschenken", "ab"
    const pricePartsRe = /\d[\d.,]*\s*€|zu verschenken|VB|ab/gi;

    function isPriceOnly(text) {
        const t = text.trim();
        // „VB“ allein (Verhandlungsbasis ohne Betrag) zählt auch als Preis
        return t.length > 0 && (/€|zu verschenken/i.test(t) || /^vb$/i.test(t)) && t.replace(pricePartsRe, '').replace(/\s+/g, '') === '';
    }

    // Text eines Elements ohne die Buttons anderer Module ("Melden", "Ausblenden")
    function textWithoutUi(node) {
        let text = node.textContent;
        node.querySelectorAll(CONFIG.foreignUi).forEach(ui => { text = text.split(ui.textContent).join(''); });
        return text;
    }

    // Durchgestrichener Altpreis, z. B. "3.399 €" neben "2 € VB"
    function isStruck(node, stop) {
        for (let n = node, i = 0; n && n !== stop && i < 5; n = n.parentElement, i++) {
            if (/^(S|DEL|STRIKE)$/.test(n.tagName)) return true;
            if ((getComputedStyle(n).textDecorationLine || '').includes('line-through')) return true;
        }
        return false;
    }

    // Element ohne eigene Kind-Elemente; Buttons anderer Module zählen nicht mit (die Blockliste
    // setzt ihren Button je nach Layout direkt in das Preis-Element)
    const isLeaf = (n) => Array.from(n.children).every(c => c.matches(CONFIG.foreignUi));

    // Reines Preis-Element (Text ohne fremde Buttons), nicht selbst Teil eines Buttons
    const isPriceLeaf = (n) => isLeaf(n) && !n.closest(CONFIG.foreignUi) && isPriceOnly(textWithoutUi(n));

    // Erstes reines Preis-Element in node (oder node selbst), ohne durchgestrichenen Altpreis
    function currentPriceEl(node) {
        return [node, ...node.querySelectorAll('*')].find(n => isPriceLeaf(n) && !isStruck(n, node.parentElement)) || null;
    }

    // Preiszeile einer Karte; gleiche Logik wie in "Anzeige melden", damit alle Module dieselbe Zeile finden
    function findPriceRow(card) {
        const classic = card.querySelector('.aditem-main--middle--price-shipping');
        if (classic) return classic;
        const first = Array.from(card.querySelectorAll('p, span, div, strong, b')).find(isPriceLeaf);
        if (!first) return null;
        let row = first;
        while (row.parentElement && row.parentElement !== card && isPriceOnly(textWithoutUi(row.parentElement))) {
            row = row.parentElement;
        }
        return row;
    }

    // "1.234,50 € VB" -> { cents: 123450, vb: true }; "Zu verschenken" -> { cents: 0 }; "VB" -> { cents: null }
    function parsePrice(text) {
        const t = String(text || '');
        const vb = /\bVB\b/.test(t);
        if (/zu verschenken/i.test(t)) return { cents: 0, vb };
        const m = t.match(/(\d[\d.]*)(?:,(\d{1,2}))?\s*€/);
        if (!m) return { cents: null, vb };
        const euros = Number(m[1].replace(/\./g, ''));
        const cents = m[2] ? Number(m[2].padEnd(2, '0')) : 0;
        return { cents: Number.isFinite(euros) ? euros * 100 + cents : null, vb };
    }

    // Zwei Preistexte gelten als gleich, wenn Betrag und VB übereinstimmen (Schreibweise egal)
    const priceKey = (text) => { const p = parsePrice(text); return `${p.cents}|${p.vb ? 1 : 0}`; };

    // ------------------------------------------------------------------
    // Speicher
    // ------------------------------------------------------------------

    function cleanEntry(raw) {
        if (!isObj(raw)) return null;
        const e = { p: [] };
        if (num(raw.f)) e.f = raw.f;
        if (num(raw.l)) e.l = raw.l;
        if (num(raw.o)) e.o = raw.o;
        if (Array.isArray(raw.p)) {
            e.p = raw.p.filter(x => Array.isArray(x) && num(x[0]) && typeof x[1] === 'string')
                .map(x => [x[0], clip(x[1], 40)]);
        }
        return e;
    }

    function loadAds() {
        const out = {};
        const raw = load(CONFIG.keys.ads, {});
        if (isObj(raw)) {
            for (const [id, v] of Object.entries(raw)) {
                const e = /^\d{1,15}$/.test(id) && cleanEntry(v);
                if (e) out[id] = e;
            }
        }
        return out;
    }

    function loadSettings() {
        const s = { ...CONFIG.defaultSettings };
        const raw = load(CONFIG.keys.settings, {});
        if (isObj(raw)) {
            ['priceBadges', 'newBadges', 'seenLabels'].forEach(k => { if (typeof raw[k] === 'boolean') s[k] = raw[k]; });
            if (['seen', 'opened', 'off'].includes(raw.dim)) s.dim = raw.dim;
        }
        return s;
    }

    let ads = loadAds();
    let settings = loadSettings();
    const dirty = new Set(); // geänderte Anzeigen, noch nicht gespeichert

    // Preisverlauf: sortiert, aufeinanderfolgende gleiche Preise zusammengefasst, gekürzt
    function tidyHistory(list) {
        const out = [];
        list.slice().sort((a, b) => a[0] - b[0]).forEach(x => {
            const last = out[out.length - 1];
            if (!last || priceKey(last[1]) !== priceKey(x[1])) out.push(x);
        });
        return out.slice(-CONFIG.historyMax);
    }

    function mergeEntry(a, b) {
        if (!a) return b;
        if (!b) return a;
        const min = (x, y) => (x && y ? Math.min(x, y) : x || y);
        const max = (x, y) => Math.max(x || 0, y || 0) || undefined;
        return cleanEntry({ f: min(a.f, b.f), l: max(a.l, b.l), o: max(a.o, b.o), p: tidyHistory([...a.p, ...b.p]) });
    }

    // Vor dem Speichern mit dem gespeicherten Stand zusammenführen, damit parallel offene Tabs
    // nichts überschreiben
    function mergeWithStored() {
        const stored = loadAds();
        dirty.forEach(id => { stored[id] = mergeEntry(stored[id], ads[id]); });
        return stored;
    }

    function prune(map, max, age) {
        const keys = Object.keys(map);
        if (keys.length <= max) return;
        keys.sort((a, b) => age(map[a]) - age(map[b]))
            .slice(0, keys.length - max)
            .forEach(k => { delete map[k]; });
    }

    let flushTimer = null;

    function flush() {
        clearTimeout(flushTimer);
        flushTimer = null;
        if (!dirty.size) return;
        const merged = mergeWithStored();
        prune(merged, CONFIG.adsMax, e => e.l || e.o || e.f || 0);
        dirty.clear();
        ads = merged;
        save(CONFIG.keys.ads, merged);
    }

    function scheduleFlush() {
        if (dirty.size && !flushTimer) flushTimer = setTimeout(flush, CONFIG.flushDelayMs);
    }

    const entry = (adId) => ads[adId] || (ads[adId] = { p: [] });

    // Preis beobachten: nur Änderungen landen im Verlauf
    function observe(adId, priceText) {
        const e = entry(adId);
        e.l = Date.now();
        const text = clip(priceText, 40);
        const last = e.p[e.p.length - 1];
        if (text && (!last || priceKey(last[1]) !== priceKey(text))) {
            e.p.push([Date.now(), text]);
            e.p = e.p.slice(-CONFIG.historyMax);
        }
        dirty.add(adId);
        scheduleFlush();
    }

    function markSeen(adId) {
        const e = entry(adId);
        if (e.f) return;
        e.f = Date.now();
        dirty.add(adId);
        scheduleFlush();
    }

    function clearHistory() {
        ads = {};
        dirty.clear();
        save(CONFIG.keys.ads, {});
        save(CONFIG.keys.searches, {});
        try {
            Object.keys(sessionStorage).filter(k => k.startsWith(CONFIG.visitKeyPrefix)).forEach(k => sessionStorage.removeItem(k));
        } catch (e) { /* egal */ }
        visit = null;
    }

    // ------------------------------------------------------------------
    // Besuch einer Suche
    // ------------------------------------------------------------------

    let visit = null; // { start, prev, touched }

    // Beginn dieses Besuchs und des vorherigen (pro Tab im sessionStorage, damit Seite 2 und
    // Neuladen zum selben Besuch zählen)
    function beginVisit() {
        const now = Date.now();
        // Die Startseite ist keine Suche: dort kein „Neu“, nur „Gesehen“ und Preise
        if (!path.startsWith('/s-')) return { start: now, prev: 0, touched: now };
        const key = KS.searchKey(window.location.href);
        const sk = CONFIG.visitKeyPrefix + key;
        let v = null;
        try { v = JSON.parse(sessionStorage.getItem(sk) || 'null'); } catch (e) { v = null; }
        if (!isObj(v) || !num(v.start) || now - num(v.touched) > CONFIG.visitIdleMs) {
            const raw = load(CONFIG.keys.searches, {});
            const searches = isObj(raw) ? raw : {};
            v = { start: now, prev: num(searches[key]) };
            searches[key] = now;
            prune(searches, CONFIG.searchesMax, ts => num(ts));
            save(CONFIG.keys.searches, searches);
        }
        v.touched = now;
        try { sessionStorage.setItem(sk, JSON.stringify(v)); } catch (e) { /* gilt nur für diesen Seitenaufruf */ }
        return v;
    }

    // ------------------------------------------------------------------
    // Styles
    // ------------------------------------------------------------------

    const styleEl = document.createElement('style');
    styleEl.textContent = `
        [data-kps-dim] { opacity: .5; transition: opacity .15s; }
        [data-kps-dim]:hover, [data-kps-dim]:focus-within { opacity: 1; }
        .kps-badges { display: flex; flex-wrap: wrap; gap: 4px; margin: 4px 0; font-size: 12px; line-height: 18px; }
        .kps-badge {
            display: inline-flex; align-items: center; gap: 4px; padding: 0 8px; border-radius: 999px;
            border: 1px solid #d0d0cc; background: #fff; color: #555;
            font: inherit; font-size: 12px; font-weight: 600; line-height: 18px; white-space: nowrap;
        }
        button.kps-badge { cursor: pointer; }
        button.kps-badge:hover, button.kps-badge:focus-visible { border-color: #1e1e1e; outline: none; }
        .kps-badge[data-kind="down"] { border-color: #a5d6a7; background: #edf7ee; color: #1f5e23; }
        .kps-badge[data-kind="up"] { border-color: #f3c58f; background: #fff4e5; color: #8a4b00; }
        .kps-badge[data-kind="new"] { border-color: #1e88e5; background: #1e88e5; color: #fff; }
        .kps-badge[data-kind="seen"], .kps-badge[data-kind="opened"] { border-style: dashed; }

        .kps-pop {
            position: absolute; z-index: 2147482000; box-sizing: border-box; max-height: calc(100vh - 32px); overflow: auto;
            background: #fff; color: #1e1e1e; border: 1px solid #d0d0cc; border-radius: 12px;
            box-shadow: 0 12px 32px rgba(0,0,0,.22); font: inherit; font-size: 14px; line-height: 1.4; text-align: left;
        }
        .kps-pop *, .kps-pop *::before, .kps-pop *::after { box-sizing: border-box; }
        .kps-pop-head {
            position: sticky; top: 0; display: flex; align-items: center; gap: 8px;
            padding: 8px 8px 8px 14px; background: #fff; border-bottom: 1px solid #eceae6;
        }
        .kps-pop-title { flex: 1; min-width: 0; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .kps-pop-body { padding: 10px 14px 12px; display: grid; gap: 8px; }
        .kps-pop button { font: inherit; color: inherit; }
        .kps-icon-btn {
            flex: none; width: 30px; height: 30px; display: inline-grid; place-items: center;
            border: 0; border-radius: 8px; background: transparent; cursor: pointer; font-size: 18px; line-height: 1;
        }
        .kps-icon-btn:hover, .kps-icon-btn:focus-visible { background: #f2f1ee; outline: none; }
        .kps-history { margin: 0; padding: 0; list-style: none; display: grid; gap: 2px; font-size: 13px; }
        .kps-history li { display: flex; gap: 12px; justify-content: space-between; padding: 3px 0; border-bottom: 1px dotted #e3e1dc; }
        .kps-history li:last-child { border-bottom: 0; font-weight: 700; }
        .kps-history time { color: #6b6b6b; font-variant-numeric: tabular-nums; }
        .kps-muted { margin: 0; font-size: 12px; color: #6b6b6b; }
        .kps-link { justify-self: start; padding: 0; border: 0; background: none; color: #555; text-decoration: underline; font-size: 13px; cursor: pointer; }
        .kps-link:hover { color: #1e1e1e; }

        .kps-detail {
            display: grid; gap: 2px; margin: 6px 0 10px; padding: 8px 12px;
            border: 1px dashed #c9c7c2; border-radius: 8px; background: #f7f6f3; color: #555;
            font-size: 13px; line-height: 1.4; font-weight: 400;
        }
        .kps-detail strong { color: #1e1e1e; }
    `;
    const ensureStyles = () => { if (!styleEl.isConnected) (document.head || document.documentElement).appendChild(styleEl); };

    // Ruft fn gebündelt (einmal pro Frame) auf, sobald sich das Dokument ändert
    function watchPage(fn) {
        let scheduled = false;
        new MutationObserver(() => {
            if (scheduled) return;
            scheduled = true;
            requestAnimationFrame(() => { scheduled = false; fn(); });
        }).observe(document.documentElement, { childList: true, subtree: true });
    }

    // ------------------------------------------------------------------
    // Verlauf als Popover
    // ------------------------------------------------------------------

    let pop = null; // { root, btn, cleanup }

    function closePopover() {
        if (!pop) return;
        pop.cleanup();
        pop.root.remove();
        const btn = pop.btn;
        pop = null;
        if (btn.isConnected) btn.focus({ preventScroll: true });
    }

    function positionPopover() {
        const { root, btn } = pop;
        const r = btn.getBoundingClientRect();
        const vw = document.documentElement.clientWidth;
        const vh = window.innerHeight;
        const width = Math.min(320, vw - 32);
        root.style.width = width + 'px';
        const left = Math.min(Math.max(16, r.left), vw - 16 - width);
        const h = root.offsetHeight;
        const below = r.bottom + 6;
        const top = (below + h > vh - 8 && r.top - 6 - h > 8) ? r.top - 6 - h : below;
        root.style.left = (left + window.scrollX) + 'px';
        root.style.top = (top + window.scrollY) + 'px';
    }

    function historyList(e) {
        return el('ol', { className: 'kps-history' },
            e.p.map(([ts, text]) => el('li', {}, el('time', { dateTime: new Date(ts).toISOString(), title: fmtTime(ts) }, fmtDate(ts)), el('span', {}, text))));
    }

    function sightingText(e) {
        return [
            e.f ? `Zuerst gesehen am ${fmtDate(e.f)}` : '',
            e.o ? `zuletzt geöffnet am ${fmtDate(e.o)}` : '',
        ].filter(Boolean).join(', ');
    }

    function openPopover(adId, title, btn) {
        if (pop && pop.btn === btn) { closePopover(); return; }
        closePopover();
        const e = ads[adId];
        if (!e) return;
        const root = el('div', { className: 'kps-ui kps-pop', role: 'dialog', 'aria-label': 'Preisverlauf' });
        const onKey = (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); closePopover(); } };
        const onOutside = (ev) => { if (pop && !root.contains(ev.target) && !btn.contains(ev.target)) closePopover(); };
        const onResize = () => pop && positionPopover();
        document.addEventListener('keydown', onKey, true);
        document.addEventListener('pointerdown', onOutside, true);
        window.addEventListener('resize', onResize);
        pop = {
            root, btn,
            cleanup: () => {
                document.removeEventListener('keydown', onKey, true);
                document.removeEventListener('pointerdown', onOutside, true);
                window.removeEventListener('resize', onResize);
            },
        };
        const seen = sightingText(e);
        root.append(
            el('div', { className: 'kps-pop-head' },
                el('span', { className: 'kps-pop-title', title: title || '' }, title ? `Preisverlauf: ${title}` : 'Preisverlauf'),
                el('button', { type: 'button', className: 'kps-icon-btn', 'aria-label': 'Schließen', title: 'Schließen', onclick: closePopover }, '×')),
            el('div', { className: 'kps-pop-body' },
                historyList(e),
                el('p', { className: 'kps-muted' }, 'Erfasst, wenn die Anzeige in deinen Suchergebnissen stand oder du sie geöffnet hast. '
                    + 'Änderungen dazwischen sind nicht bekannt.'),
                seen ? el('p', { className: 'kps-muted' }, seen + '.') : null,
                el('button', { type: 'button', className: 'kps-link', onclick: () => { closePopover(); KS.openSettings(); } }, 'Einstellungen …')));
        document.body.appendChild(root);
        positionPopover();
        root.querySelector('.kps-icon-btn').focus({ preventScroll: true });
    }

    // ------------------------------------------------------------------
    // Übersicht
    // ------------------------------------------------------------------

    function findAdCards() {
        const cards = new Set();
        document.querySelectorAll('article.aditem[data-adid]').forEach(c => cards.add(c));
        // Generisch: vom Anzeigen-Link so weit nach oben laufen, wie der Container
        // nur Links auf genau diese eine Anzeige enthält -> das ist die Karte.
        document.querySelectorAll('a[href*="/s-anzeige/"]').forEach(link => {
            if (link.closest(`${CONFIG.foreignUi}, article.aditem[data-adid]`)) return;
            const adId = getAdIdFromUrl(link.href);
            if (!adId) return;
            let card = null;
            let node = link.parentElement;
            while (node && node !== document.body && containsOnlyAd(node, adId)) {
                card = node;
                node = node.parentElement;
            }
            if (card) cards.add(card);
        });
        return Array.from(cards);
    }

    function containsOnlyAd(node, adId) {
        return Array.from(node.querySelectorAll('a[href*="/s-anzeige/"]'))
            .every(a => getAdIdFromUrl(a.href) === adId);
    }

    const cardInfos = new WeakMap();

    function getCardInfo(card) {
        const cached = cardInfos.get(card);
        // Die Seite baut Karten teils neu auf: dann Preiszeile neu suchen
        if (cached && (!cached.row || (cached.row.isConnected && card.contains(cached.row)))) return cached;
        const link = card.querySelector('a[href*="/s-anzeige/"]');
        const adId = card.dataset.adid || getAdIdFromUrl(card.dataset.href || (link ? link.getAttribute('href') : ''));
        if (!adId || !/^\d{1,15}$/.test(adId)) return null;
        const row = findPriceRow(card);
        const priceEl = row ? currentPriceEl(row) : null;
        const titleEl = card.querySelector('h2, h3, .text-module-begin a, .ellipsis');
        const info = {
            adId, row,
            price: priceEl ? clip(textWithoutUi(priceEl), 40) : '',
            title: clip(titleEl ? titleEl.textContent : (link ? link.textContent : ''), 120),
        };
        cardInfos.set(card, info);
        return info;
    }

    // Was an einer Karte angezeigt wird
    function viewState(e) {
        const v = { change: null, isNew: false, seen: null, dim: false };
        if (settings.priceBadges && e && e.p.length > 1) {
            const prev = e.p[e.p.length - 2];
            const cur = e.p[e.p.length - 1];
            const a = parsePrice(prev[1]).cents;
            const b = parsePrice(cur[1]).cents;
            v.change = { dir: a != null && b != null && a !== b ? (b < a ? 'down' : 'up') : 'changed', prev: prev[1], since: cur[0] };
        }
        const seenBefore = !!(e && e.f && e.f < visit.start);
        const opened = !!(e && e.o);
        v.isNew = settings.newBadges && !!visit.prev && !seenBefore && !opened;
        if (settings.seenLabels) v.seen = opened ? 'opened' : seenBefore ? 'seen' : null;
        v.dim = settings.dim === 'seen' ? (seenBefore || opened) : settings.dim === 'opened' ? opened : false;
        // Gerade geänderter Preis: nicht abdunkeln, die Anzeige ist wieder interessant
        if (v.change && v.change.since >= visit.start) v.dim = false;
        return v;
    }

    function badges(info, v, e) {
        const out = [];
        if (v.change) {
            const label = v.change.dir === 'down' ? `↓ vorher ${v.change.prev}`
                : v.change.dir === 'up' ? `↑ vorher ${v.change.prev}` : 'Preis geändert';
            const word = v.change.dir === 'down' ? 'gesenkt' : v.change.dir === 'up' ? 'erhöht' : 'geändert';
            const btn = guard(el('button', { type: 'button', className: 'kps-badge', dataset: { kind: v.change.dir },
                title: `Preis am ${fmtDate(v.change.since)} ${word} (vorher ${v.change.prev}). Klicken für den ganzen Verlauf.` }, label));
            btn.addEventListener('click', () => openPopover(info.adId, info.title, btn));
            out.push(btn);
        }
        if (v.isNew) {
            out.push(el('span', { className: 'kps-badge', dataset: { kind: 'new' },
                title: 'Bei deinem letzten Besuch dieser Suche war die Anzeige noch nicht zu sehen' }, 'Neu'));
        }
        if (v.seen === 'opened') {
            out.push(el('span', { className: 'kps-badge', dataset: { kind: 'opened' }, title: `${sightingText(e)}.` }, `Geöffnet ${fmtDay(e.o)}`));
        } else if (v.seen === 'seen') {
            out.push(el('span', { className: 'kps-badge', dataset: { kind: 'seen' }, title: `${sightingText(e)}.` }, `Gesehen ${fmtDay(e.f)}`));
        }
        return out;
    }

    const observed = new Set();    // in diesem Seitenaufruf schon erfasste Anzeigen
    const watched = new WeakSet(); // Karten, die der IntersectionObserver beobachtet

    const seenObserver = 'IntersectionObserver' in window ? new IntersectionObserver((entries) => {
        entries.forEach(en => {
            if (!en.isIntersecting) return;
            const card = en.target;
            // Eingeklappte Anzeigen blockierter Anbieter zählen nicht als gesehen
            if (card.dataset.kuaState === 'collapsed' || card.closest('[data-kua-hidden]')) return;
            seenObserver.unobserve(card);
            if (card.dataset.kpsAdid) markSeen(card.dataset.kpsAdid);
        });
    }, { threshold: CONFIG.seenThreshold }) : null;

    function applyCard(card) {
        const info = getCardInfo(card);
        if (!info) return;
        if (!observed.has(info.adId)) {
            observed.add(info.adId);
            observe(info.adId, info.price);
        }
        if (!watched.has(card)) {
            watched.add(card);
            card.dataset.kpsAdid = info.adId;
            if (seenObserver) seenObserver.observe(card);
            else markSeen(info.adId);
        }

        const e = ads[info.adId];
        const v = viewState(e);
        const sig = JSON.stringify([v, e && e.f, e && e.o]);
        const box = card.querySelector('.kps-badges');
        const needed = !!(v.change || v.isNew || v.seen);
        // Neu zeichnen, wenn sich der Zustand geändert hat oder die Seite unsere Änderungen entfernt hat
        if (card.dataset.kpsSig === sig && !!box === needed && card.hasAttribute('data-kps-dim') === v.dim) return;
        card.dataset.kpsSig = sig;
        if (v.dim) card.setAttribute('data-kps-dim', ''); else card.removeAttribute('data-kps-dim');
        if (!needed) {
            if (box) box.remove();
            return;
        }
        const target = box || el('div', { className: 'kps-ui kps-badges' });
        target.replaceChildren(...badges(info, v, e));
        if (!box) {
            if (info.row && card.contains(info.row)) info.row.insertAdjacentElement('afterend', target);
            else card.appendChild(target);
        }
    }

    function applyOverview() {
        ensureStyles();
        if (pop && !pop.btn.isConnected) closePopover();
        const cards = findAdCards();
        if (!cards.length) return;
        if (!visit) visit = beginVisit();
        cards.forEach(applyCard);
    }

    // Zustand neu laden (anderer Tab, Zurück-Taste aus dem Cache) und neu zeichnen.
    // Nur bei der Rückkehr per Zurück-Taste zählt das als neuer Seitenaufruf der Suche.
    function reloadState(returned) {
        ads = mergeWithStored();
        settings = loadSettings();
        if (isDetailPage) return;
        if (visit && returned === true) visit = beginVisit();
        document.querySelectorAll('[data-kps-sig]').forEach(c => { delete c.dataset.kpsSig; });
        applyOverview();
    }

    function runOverview() {
        applyOverview();
        watchPage(applyOverview);
    }

    // ------------------------------------------------------------------
    // Anzeigenseite
    // ------------------------------------------------------------------

    function findDetailPrice() {
        for (const sel of CONFIG.detailPriceSelectors) {
            const node = document.querySelector(sel);
            const hit = node && currentPriceEl(node);
            if (hit) return hit;
        }
        // Rückfall: reiner Preistext in der Nähe der Überschrift, nicht in verlinkten Empfehlungen
        const h1 = document.querySelector('#viewad-title, h1');
        let scope = h1 && h1.parentElement;
        for (let i = 0; scope && i < 4; i++, scope = scope.parentElement) {
            const hit = Array.from(scope.querySelectorAll('h2, h3, p, span, div, strong, b')).find(n => isPriceLeaf(n)
                && !n.closest('a[href*="/s-anzeige/"]') && !isStruck(n, scope));
            if (hit) return hit;
        }
        return null;
    }

    function runDetail() {
        const adId = getAdIdFromUrl(window.location.href);
        if (!adId) return;
        const before = ads[adId] ? { ...ads[adId] } : null;
        const e = entry(adId);
        const now = Date.now();
        if (!e.f) e.f = now;
        e.o = now;
        dirty.add(adId);
        flush();

        let box = null;
        let priceEl = null;
        let reinserts = 0;

        const render = () => {
            const cur = ads[adId];
            if (!cur) return null;
            const lines = [];
            if (cur.p.length > 1) {
                lines.push(el('span', {}, el('strong', {}, 'Preisverlauf: '),
                    cur.p.map(([ts, text], i) => `${i ? ' → ' : ''}${text} (${fmtDay(ts)})`).join('')));
            }
            // Erstes Auftauchen: gesehen, sonst erster erfasster Preis (Karte stand in der Liste)
            const first = before && (before.f || (before.p[0] && before.p[0][0]));
            if (first) lines.push(el('span', {}, `Zuerst gesehen am ${fmtDate(first)}`
                + (before.o ? `, zuletzt geöffnet am ${fmtDate(before.o)}` : '') + '.'));
            if (!lines.length) return null;
            return el('div', { className: 'kps-ui kps-detail' }, lines);
        };

        // Der Preis kann nachgerendert werden, und die Seite baut Teile neu auf: dann wieder einsetzen
        const ensure = () => {
            ensureStyles();
            if (!priceEl || !priceEl.isConnected) {
                const found = findDetailPrice();
                if (!found) return;
                const first = !priceEl;
                priceEl = found;
                if (first) {
                    observe(adId, clip(textWithoutUi(priceEl), 40));
                    flush();
                    box = render();
                }
            }
            if (box && !box.isConnected && reinserts < 20) {
                priceEl.insertAdjacentElement('afterend', box);
                reinserts++;
            }
        };
        ensure();
        watchPage(ensure);
    }

    // ------------------------------------------------------------------
    // Einstellungen (im Superscript-Dialog)
    // ------------------------------------------------------------------

    function setSetting(key, value) {
        settings[key] = value;
        save(CONFIG.keys.settings, settings);
        if (!isDetailPage) {
            document.querySelectorAll('[data-kps-sig]').forEach(c => { delete c.dataset.kpsSig; });
            applyOverview();
        }
    }

    KS.addSettings('preisverlauf', () => {
        const all = Object.values(loadAds());
        const changed = all.filter(e => e.p.length > 1).length;
        const status = el('span', { className: 'ks-spacer ks-muted' },
            `${all.length} Anzeige${all.length === 1 ? '' : 'n'} im Verlauf, davon ${changed} mit Preisänderung.`);
        return [
            el('h3', {}, 'Preisverlauf & Gesehen'),
            KS.checkbox('Preisänderungen an der Anzeige zeigen („↓ vorher 120 €“)', settings.priceBadges, v => setSetting('priceBadges', v)),
            KS.checkbox('„Neu“ markieren: Anzeigen, die beim letzten Besuch derselben Suche noch nicht da waren', settings.newBadges, v => setSetting('newBadges', v)),
            KS.checkbox('„Gesehen“ und „Geöffnet“ markieren', settings.seenLabels, v => setSetting('seenLabels', v)),
            el('p', { className: 'ks-hint' }, 'Abdunkeln (beim Darüberfahren wieder normal):'),
            KS.radio('kps-dim', 'Gesehene und geöffnete Anzeigen abdunkeln', settings.dim === 'seen', () => setSetting('dim', 'seen')),
            KS.radio('kps-dim', 'Nur geöffnete Anzeigen abdunkeln', settings.dim === 'opened', () => setSetting('dim', 'opened')),
            KS.radio('kps-dim', 'Nichts abdunkeln', settings.dim === 'off', () => setSetting('dim', 'off')),
            el('div', { className: 'ks-row' }, status,
                el('button', { type: 'button', className: 'ks-action', dataset: { danger: '' }, disabled: !all.length,
                    onclick: (ev) => {
                        if (!window.confirm('Den gesamten Preisverlauf und alle „Gesehen“-Markierungen löschen?')) return;
                        clearHistory();
                        if (!isDetailPage) {
                            document.querySelectorAll('[data-kps-sig]').forEach(c => { delete c.dataset.kpsSig; });
                            applyOverview();
                        }
                        status.textContent = 'Verlauf gelöscht.';
                        ev.target.disabled = true;
                    } }, 'Verlauf löschen')),
            el('p', { className: 'ks-hint' }, `Es werden höchstens ${CONFIG.adsMax.toLocaleString('de-DE')} Anzeigen gemerkt; `
                + 'die am längsten nicht mehr gesehenen fallen zuerst heraus. Kleinanzeigen bekommt davon nichts mit.'),
        ];
    });

    // ------------------------------------------------------------------
    // Start
    // ------------------------------------------------------------------

    KS.onRemoteChange(CONFIG.keys.ads, () => reloadState(false));
    KS.onRemoteChange(CONFIG.keys.settings, () => reloadState(false));
    // Speichern, bevor der Tab geschlossen oder eine Anzeige geöffnet wird
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
    // Zurück-Taste: Seite kommt aus dem Cache, ohne dass das Script neu startet
    window.addEventListener('pageshow', (ev) => { if (ev.persisted) reloadState(true); });

    if (isDetailPage) runDetail();
    else runOverview();
})();
});

// ========================================================================
// Modul „Gespeicherte Suchen“ 0.2.3: src/suchen.js
// Nur im Superscript
// ========================================================================
KS.module("suchen", {"label":"Gespeicherte Suchen","version":"0.2.3","description":"Sidebar mit eigenen, benannten Suchen zum schnellen Umschalten, optional mit Zähler für neue Anzeigen."}, function () {
/*
 * Modul: Gespeicherte Suchen
 * --------------------------
 * Sidebar am rechten Rand mit eigenen, benannten Suchen. Ein Klick öffnet die Suche, die
 * Liste bleibt dabei offen; so springt man schnell zwischen „Verschenken“, „Auto“ usw. hin
 * und her. Gespeichert wird die Adresse der Ergebnisseite ohne Seitenzahl, also mit allen
 * Filtern, die Kleinanzeigen in der Adresse führt.
 *
 * - „Aktuelle Suche speichern“ mit Namensvorschlag, umbenennen, sortieren, löschen
 * - die gerade offene Suche ist hervorgehoben, dazu „besucht vor …“
 * - Tastenkürzel Alt+1 … Alt+9 für die ersten neun Suchen (abschaltbar)
 * - optional „3 neu“: lädt die erste Ergebnisseite gespeicherter Suchen im Hintergrund
 *   (standardmäßig aus, höchstens einmal pro Stunde und Suche, pro Seitenaufruf höchstens 5)
 *   und zählt Anzeigen, die beim letzten Besuch der Suche noch nicht da waren. Schon
 *   gesehene (Modul Preisverlauf) und ausgeblendete Anzeigen (Modul Nutzer ausblenden)
 *   zählen nicht mit.
 */

(function () {
    'use strict';

    const CONFIG = {
        keys: {
            searches: 'kss-searches',   // [{ id, name, url, added, visited, known: [adId], count, total, checked, error }]
            settings: 'kss-settings',
        },
        defaultSettings: {
            open: false,                // Sidebar aufgeklappt (bleibt beim Seitenwechsel so)
            newCounts: false,           // „3 neu“ im Hintergrund zählen
            shortcuts: true,            // Alt+1 … Alt+9
        },
        max: 50,
        nameMax: 60,
        // So viele Anzeigen einer Suche merken (für „neu seit dem letzten Besuch“)
        knownMax: 300,
        // Hintergrund-Zählung: Abstand pro Suche, höchstens so viele pro Seitenaufruf, Pause, Start
        checkEveryMs: 60 * 60 * 1000,
        checksPerVisit: 5,
        requestGapMs: 1500,
        checkDelayMs: 4000,
        // Ergebnisliste (Rückfall: größte Liste mit Anzeigen-Links), Stand 10/2026
        resultListSelectors: ['#srchrslt-adtable'],
        // Suchfeld der Seite für den Namensvorschlag (Rückfall: Seitentitel, dann Adresse)
        searchInputs: ['#site-search-query', 'input[name="keywords"]', 'header input[type="search"]', 'header input[type="text"]'],
        // Daten anderer Module (gleicher Speicher): gesehene, blockierte, ausgeblendete Anzeigen
        foreign: { ads: 'kps-ads', users: 'kua-users', hiddenAds: 'kua-hidden-ads', index: 'kua-ad-index' },
    };

    const { el, load, save, isObj } = KS;

    const path = window.location.pathname;
    const isDetailPage = path.startsWith('/s-anzeige/');
    // Nur Such- und Listenseiten (/s-…) sind speicherbare Suchen, nicht die Startseite
    const currentKey = path.startsWith('/s-') && !isDetailPage ? KS.searchKey(window.location.href) : null;

    // ------------------------------------------------------------------
    // Helfer
    // ------------------------------------------------------------------

    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const clip = (v, n) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : '');
    const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
    const newId = () => Math.random().toString(36).slice(2, 10);

    function relTime(ts) {
        const min = Math.round((Date.now() - ts) / 60000);
        if (min < 1) return 'gerade eben';
        if (min < 60) return `vor ${min} Min.`;
        const h = Math.round(min / 60);
        if (h < 24) return `vor ${h} Std.`;
        const d = Math.round(h / 24);
        return d === 1 ? 'gestern' : `vor ${d} Tagen`;
    }

    function getAdIdFromUrl(url) {
        // /s-anzeige/<slug>/<adId>-<kategorie>-<ort>
        const m = String(url || '').match(/\/s-anzeige\/[^/]+\/(\d+)/);
        return m ? m[1] : null;
    }

    // Nur Such- und Listenseiten von kleinanzeigen.de, gespeichert ohne Seitenzahl
    function normalizeSearchUrl(raw) {
        let url;
        try { url = new URL(String(raw || ''), window.location.origin); } catch (e) { return null; }
        if (url.origin !== window.location.origin || !url.pathname.startsWith('/s-') || url.pathname.startsWith('/s-anzeige/')) return null;
        const key = KS.searchKey(url.href);
        return key.length <= 1000 ? key : null;
    }

    // Anzeigen-Nummern der Ergebnisliste. Bewusst nur die größte Liste, damit Empfehlungen
    // am Rand nicht mitzählen (gleiche Logik wie in "Nutzer ausblenden").
    function mainListAdIds(doc) {
        let scope = null;
        for (const sel of CONFIG.resultListSelectors) {
            scope = doc.querySelector(sel);
            if (scope) break;
        }
        const groups = new Map();
        (scope || doc).querySelectorAll('article[data-adid], a[href*="/s-anzeige/"]').forEach(node => {
            if (node.closest('.kss-ui, .kps-ui, .kua-ui')) return;
            const adId = node.getAttribute('data-adid') || getAdIdFromUrl(node.getAttribute('href'));
            if (!adId || !/^\d{1,15}$/.test(adId)) return;
            const list = scope || node.closest('ul, ol') || doc;
            if (!groups.has(list)) groups.set(list, new Set());
            groups.get(list).add(adId);
        });
        let best = new Set();
        groups.forEach(set => { if (set.size > best.size) best = set; });
        return Array.from(best);
    }

    // Namensvorschlag: Suchbegriff aus dem Suchfeld, sonst Seitentitel, sonst Adresse
    function suggestName() {
        for (const sel of CONFIG.searchInputs) {
            const input = document.querySelector(sel);
            if (input && clip(input.value, CONFIG.nameMax)) return clip(input.value, CONFIG.nameMax);
        }
        const title = clip(document.title.split(/\s+[|–-]\s+/)[0], CONFIG.nameMax);
        if (title) return title;
        const seg = path.split('/').filter(s => s && !/^s-$|^k0|^c\d|^seite:/.test(s)).pop() || '';
        let word = seg.replace(/^s-/, '');
        try { word = decodeURIComponent(word); } catch (e) { /* Adresse unverändert lassen */ }
        return clip(word.replace(/[-+]/g, ' '), CONFIG.nameMax) || 'Meine Suche';
    }

    // ------------------------------------------------------------------
    // Speicher
    // ------------------------------------------------------------------

    function cleanSearch(o) {
        if (!isObj(o)) return null;
        const url = normalizeSearchUrl(o.url);
        if (!url) return null;
        return {
            id: typeof o.id === 'string' && /^[a-z0-9]{1,16}$/.test(o.id) ? o.id : newId(),
            name: clip(o.name, CONFIG.nameMax) || 'Suche',
            url,
            added: num(o.added) || Date.now(),
            visited: num(o.visited),
            known: Array.isArray(o.known) ? o.known.filter(x => typeof x === 'string' && /^\d{1,15}$/.test(x)).slice(-CONFIG.knownMax) : [],
            count: num(o.count),
            total: num(o.total),
            checked: num(o.checked),
            error: clip(o.error, 120),
        };
    }

    function loadSearches() {
        const raw = load(CONFIG.keys.searches, []);
        return Array.isArray(raw) ? raw.map(cleanSearch).filter(Boolean).slice(0, CONFIG.max) : [];
    }

    function loadSettings() {
        const s = { ...CONFIG.defaultSettings };
        const raw = load(CONFIG.keys.settings, {});
        if (isObj(raw)) Object.keys(s).forEach(k => { if (typeof raw[k] === 'boolean') s[k] = raw[k]; });
        return s;
    }

    let searches = loadSearches();
    let settings = loadSettings();

    // Ändern immer auf dem frisch geladenen Stand, damit parallel offene Tabs nichts überschreiben
    function mutate(fn) {
        searches = loadSearches();
        fn(searches);
        save(CONFIG.keys.searches, searches);
        render();
    }

    function updateSearch(id, fn) {
        mutate(list => { const s = list.find(x => x.id === id); if (s) fn(s); });
    }

    function setSetting(key, value) {
        settings = { ...loadSettings(), [key]: value };
        save(CONFIG.keys.settings, settings);
        render();
    }

    const currentSearch = () => (currentKey ? searches.find(s => s.url === currentKey) : null);

    // ------------------------------------------------------------------
    // Besuch einer gespeicherten Suche: Anzeigen merken, Zähler zurücksetzen
    // ------------------------------------------------------------------

    function noteVisit() {
        const s = currentSearch();
        if (!s) return;
        const ids = mainListAdIds(document);
        const known = new Set(s.known);
        const fresh = ids.filter(id => !known.has(id));
        const stale = Date.now() - s.visited > 60 * 1000;
        if (!fresh.length && !stale && !s.count) return;
        updateSearch(s.id, x => {
            x.visited = Date.now();
            x.count = 0;
            x.known = [...x.known.filter(id => !fresh.includes(id)), ...fresh].slice(-CONFIG.knownMax);
        });
    }

    // ------------------------------------------------------------------
    // Hintergrund-Zählung „3 neu“
    // ------------------------------------------------------------------

    async function fetchDoc(url) {
        const res = await fetch(url, { credentials: 'same-origin' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return new DOMParser().parseFromString(await res.text(), 'text/html');
    }

    // Neu = beim letzten Besuch der Suche nicht in der Liste, nicht schon woanders gesehen,
    // nicht ausgeblendet und nicht von einem blockierten Anbieter
    function countNew(s, ids) {
        const known = new Set(s.known);
        const seen = load(CONFIG.foreign.ads, {});
        const users = load(CONFIG.foreign.users, {});
        const hidden = load(CONFIG.foreign.hiddenAds, {});
        const index = load(CONFIG.foreign.index, {});
        const ok = (m) => (isObj(m) ? m : {});
        const [seenM, usersM, hiddenM, indexM] = [ok(seen), ok(users), ok(hidden), ok(index)];
        return ids.filter(id => !known.has(id)
            && !(isObj(seenM[id]) && (seenM[id].f || seenM[id].o))
            && !hiddenM[id]
            && !(indexM[id] && usersM[String(indexM[id]).toLowerCase()])).length;
    }

    let checking = false;

    async function checkSearches(force) {
        if (checking || !settings.newCounts) return;
        checking = true;
        try {
            const due = loadSearches()
                .filter(s => s.url !== currentKey && (force || Date.now() - s.checked > CONFIG.checkEveryMs))
                .sort((a, b) => a.checked - b.checked)
                .slice(0, force ? CONFIG.max : CONFIG.checksPerVisit);
            for (const s of due) {
                if (!settings.newCounts) break;
                // Prüfung anmelden, damit andere Tabs dieselbe Suche nicht gleichzeitig laden
                let claimed = false;
                updateSearch(s.id, x => {
                    if (force || Date.now() - x.checked > CONFIG.checkEveryMs) { x.checked = Date.now(); claimed = true; }
                });
                if (!claimed) continue;
                try {
                    const ids = mainListAdIds(await fetchDoc(s.url));
                    updateSearch(s.id, x => { x.count = countNew(x, ids); x.total = ids.length; x.error = ''; });
                } catch (e) {
                    updateSearch(s.id, x => { x.error = clip(e.message, 120) || 'Fehler'; });
                }
                await sleep(CONFIG.requestGapMs);
            }
        } finally {
            checking = false;
        }
    }

    // ------------------------------------------------------------------
    // Styles
    // ------------------------------------------------------------------

    const styleEl = document.createElement('style');
    styleEl.textContent = `
        .kss-tab {
            position: fixed; right: 0; top: 50%; transform: translateY(-50%); z-index: 2147482400;
            writing-mode: vertical-rl; display: inline-flex; align-items: center; gap: 6px;
            padding: 12px 6px; border: 1px solid #d0d0cc; border-right: 0; border-radius: 10px 0 0 10px;
            background: #fff; color: #1e1e1e; font: inherit; font-size: 13px; font-weight: 600;
            box-shadow: -2px 4px 14px rgba(0,0,0,.15); cursor: pointer;
        }
        .kss-tab[hidden] { display: none; }
        .kss-tab:hover, .kss-tab:focus-visible { border-color: #1e1e1e; outline: none; }
        .kss-tab-count { writing-mode: horizontal-tb; padding: 0 6px; border-radius: 999px; background: #1e88e5; color: #fff; font-size: 11px; line-height: 18px; }

        .kss-panel {
            position: fixed; right: 12px; top: 72px; z-index: 2147482400; box-sizing: border-box;
            width: min(320px, calc(100vw - 24px)); max-height: calc(100vh - 150px); overflow: auto;
            background: #fff; color: #1e1e1e; border: 1px solid #d0d0cc; border-radius: 12px;
            box-shadow: 0 12px 32px rgba(0,0,0,.22); font: inherit; font-size: 14px; line-height: 1.4; text-align: left;
        }
        .kss-panel *, .kss-panel *::before, .kss-panel *::after { box-sizing: border-box; }
        .kss-panel button, .kss-panel input { font: inherit; font-size: 14px; color: inherit; }
        .kss-head {
            position: sticky; top: 0; z-index: 1; display: flex; align-items: center; gap: 8px;
            padding: 8px 8px 8px 14px; background: #fff; border-bottom: 1px solid #eceae6;
        }
        .kss-title { flex: 1; min-width: 0; font-weight: 700; }
        .kss-body { padding: 10px 12px 12px; display: grid; gap: 10px; }
        .kss-icon-btn {
            flex: none; width: 28px; height: 28px; display: inline-grid; place-items: center;
            border: 0; border-radius: 8px; background: transparent; color: #555; cursor: pointer; font-size: 15px; line-height: 1;
        }
        .kss-icon-btn:hover:not(:disabled), .kss-icon-btn:focus-visible { background: #f2f1ee; color: #1e1e1e; outline: none; }
        .kss-icon-btn:disabled { opacity: .3; cursor: default; }
        .kss-head .kss-icon-btn { width: 32px; height: 32px; font-size: 18px; }
        .kss-save { display: grid; gap: 6px; padding: 10px; border: 1px dashed #c9c7c2; border-radius: 8px; background: #faf9f7; }
        .kss-row { display: flex; align-items: center; gap: 6px; }
        .kss-input { flex: 1; min-width: 0; width: 100%; padding: 6px 8px; border: 1px solid #c9c7c2; border-radius: 8px; background: #fff; }
        .kss-input:focus { outline: 2px solid #1e1e1e; outline-offset: -1px; }
        .kss-action {
            flex: none; padding: 6px 12px; border-radius: 999px; border: 1px solid #1e1e1e; background: #1e1e1e; color: #fff;
            font-weight: 600; cursor: pointer; white-space: nowrap;
        }
        .kss-action[data-plain] { background: #fff; color: #1e1e1e; border-color: #c9c7c2; }
        .kss-action:hover, .kss-action:focus-visible { outline: 2px solid #1e1e1e; outline-offset: 1px; }
        .kss-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
        .kss-item { display: flex; align-items: center; gap: 4px; padding: 6px 4px 6px 10px; border: 1px solid #e3e1dc; border-radius: 8px; }
        .kss-item[data-current] { border-color: #1e1e1e; background: #f7f6f3; }
        .kss-item-main { flex: 1; min-width: 0; display: grid; gap: 1px; }
        .kss-item-main a { color: #1e1e1e; font-weight: 600; text-decoration: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .kss-item-main a:hover { text-decoration: underline; }
        .kss-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 6px; font-size: 12px; color: #6b6b6b; }
        .kss-new { padding: 0 7px; border-radius: 999px; background: #1e88e5; color: #fff; font-weight: 600; line-height: 17px; }
        .kss-key { font-size: 11px; padding: 0 4px; border: 1px solid #d0d0cc; border-radius: 4px; color: #6b6b6b; }
        .kss-tools { display: flex; flex: none; }
        .kss-hint { margin: 0; font-size: 12px; color: #6b6b6b; }
        .kss-check { display: flex; gap: 8px; align-items: flex-start; font-size: 13px; cursor: pointer; }
        .kss-check input { margin: 2px 0 0; accent-color: #1e1e1e; flex: none; }
        .kss-link { padding: 0; border: 0; background: none; color: #555; text-decoration: underline; font-size: 12px; cursor: pointer; }
        .kss-link:hover { color: #1e1e1e; }
    `;
    const ensureStyles = () => { if (!styleEl.isConnected) (document.head || document.documentElement).appendChild(styleEl); };

    // ------------------------------------------------------------------
    // Sidebar
    // ------------------------------------------------------------------

    const tab = el('button', { type: 'button', className: 'kss-ui kss-tab', title: 'Gespeicherte Suchen',
        onclick: () => setSetting('open', !settings.open) });
    const panel = el('aside', { className: 'kss-ui kss-panel', 'aria-label': 'Gespeicherte Suchen' });
    let editingId = null;
    let draftName = null; // Name im Speichern-Feld, bleibt beim Neuzeichnen erhalten

    function newText(s) {
        if (!s.count) return '';
        return `${s.count}${s.total && s.count >= s.total ? '+' : ''} neu`;
    }

    function renderTab() {
        const total = searches.reduce((n, s) => n + (s.url === currentKey ? 0 : s.count), 0);
        // Ohne neue Anzeigen keine Zahl (replaceChildren würde null als Text "null" einsetzen)
        tab.replaceChildren(...[el('span', {}, '★ Suchen'), total ? el('span', { className: 'kss-tab-count' }, String(total)) : null].filter(Boolean));
        tab.setAttribute('aria-expanded', String(settings.open));
        tab.hidden = settings.open;
        if (!tab.isConnected) document.body.appendChild(tab);
    }

    function itemRow(s, i) {
        const isCurrent = s.url === currentKey;
        if (editingId === s.id) {
            const input = el('input', { className: 'kss-input', type: 'text', value: s.name, maxLength: CONFIG.nameMax, 'aria-label': 'Name der Suche' });
            const done = (keep) => {
                const name = clip(input.value, CONFIG.nameMax);
                editingId = null;
                if (keep && name) updateSearch(s.id, x => { x.name = name; }); else render();
            };
            input.addEventListener('keydown', e => {
                if (e.key === 'Enter') done(true);
                if (e.key === 'Escape') { e.stopPropagation(); done(false); }
            });
            setTimeout(() => { input.focus(); input.select(); }, 0);
            return el('li', { className: 'kss-item', dataset: isCurrent ? { current: '' } : null },
                el('div', { className: 'kss-row', style: 'flex:1' }, input,
                    el('button', { type: 'button', className: 'kss-action', onclick: () => done(true) }, 'OK')));
        }
        const meta = [
            i < 9 && settings.shortcuts ? el('span', { className: 'kss-key', title: `Tastenkürzel Alt+${i + 1}` }, `Alt+${i + 1}`) : null,
            el('span', {}, isCurrent ? 'gerade offen' : s.visited ? `besucht ${relTime(s.visited)}` : 'noch nicht besucht'),
            !isCurrent && settings.newCounts && s.count ? el('span', { className: 'kss-new', title: `Geprüft ${relTime(s.checked)}` }, newText(s)) : null,
            !isCurrent && settings.newCounts && s.error ? el('span', { title: s.error }, '⚠ nicht geprüft') : null,
        ];
        const move = (d) => mutate(list => {
            const from = list.findIndex(x => x.id === s.id);
            const to = from + d;
            if (from < 0 || to < 0 || to >= list.length) return;
            list.splice(to, 0, list.splice(from, 1)[0]);
        });
        return el('li', { className: 'kss-item', dataset: isCurrent ? { current: '' } : null },
            el('div', { className: 'kss-item-main' },
                el('a', { href: s.url, title: s.name, 'aria-current': isCurrent ? 'page' : null }, s.name),
                el('div', { className: 'kss-meta' }, meta)),
            el('div', { className: 'kss-tools' },
                el('button', { type: 'button', className: 'kss-icon-btn', title: 'Nach oben', 'aria-label': `${s.name} nach oben`, disabled: i === 0, onclick: () => move(-1) }, '↑'),
                el('button', { type: 'button', className: 'kss-icon-btn', title: 'Nach unten', 'aria-label': `${s.name} nach unten`, disabled: i === searches.length - 1, onclick: () => move(1) }, '↓'),
                el('button', { type: 'button', className: 'kss-icon-btn', title: 'Umbenennen', 'aria-label': `${s.name} umbenennen`, onclick: () => { editingId = s.id; render(); } }, '✎'),
                el('button', { type: 'button', className: 'kss-icon-btn', title: 'Löschen', 'aria-label': `${s.name} löschen`,
                    onclick: () => { if (window.confirm(`Gespeicherte Suche „${s.name}“ löschen?`)) mutate(list => { const at = list.findIndex(x => x.id === s.id); if (at >= 0) list.splice(at, 1); }); } }, '🗑')));
    }

    function saveBox() {
        if (!currentKey || !mainListAdIds(document).length) return null;
        const cur = currentSearch();
        if (cur) return null;
        if (searches.length >= CONFIG.max) return el('p', { className: 'kss-hint' }, `Höchstens ${CONFIG.max} gespeicherte Suchen.`);
        if (draftName == null) draftName = suggestName();
        const input = el('input', { className: 'kss-input', type: 'text', value: draftName, maxLength: CONFIG.nameMax,
            'aria-label': 'Name für diese Suche', oninput: (e) => { draftName = e.target.value; } });
        const doSave = () => {
            const name = clip(input.value, CONFIG.nameMax) || suggestName();
            draftName = null;
            mutate(list => {
                if (list.some(x => x.url === currentKey) || list.length >= CONFIG.max) return;
                list.push(cleanSearch({ id: newId(), name, url: currentKey, added: Date.now(), visited: Date.now(), known: mainListAdIds(document) }));
            });
        };
        input.addEventListener('keydown', e => { if (e.key === 'Enter') doSave(); });
        return el('div', { className: 'kss-save' },
            el('span', { className: 'kss-hint' }, 'Diese Suche speichern als:'),
            el('div', { className: 'kss-row' }, input, el('button', { type: 'button', className: 'kss-action', onclick: doSave }, 'Speichern')));
    }

    function render() {
        ensureStyles();
        renderTab();
        if (!settings.open) {
            panel.remove();
            return;
        }
        // Fokus im Panel merken (z. B. Häkchen), damit Tastaturnutzer nach dem Neuzeichnen nicht herausfallen
        const focused = panel.contains(document.activeElement) ? document.activeElement.getAttribute('data-focus') : null;
        const list = searches.length
            ? el('ol', { className: 'kss-list' }, searches.map(itemRow))
            : el('p', { className: 'kss-hint' }, 'Noch keine Suche gespeichert. Suche ganz normal und speichere sie hier mit einem Namen.');
        panel.replaceChildren(
            el('div', { className: 'kss-head' },
                el('span', { className: 'kss-title' }, 'Gespeicherte Suchen'),
                el('button', { type: 'button', className: 'kss-icon-btn', 'aria-label': 'Einklappen', title: 'Einklappen',
                    onclick: () => { setSetting('open', false); tab.focus(); } }, '×')),
            el('div', { className: 'kss-body' },
                saveBox(),
                list,
                el('label', { className: 'kss-check' },
                    el('input', { type: 'checkbox', checked: settings.newCounts, dataset: { focus: 'counts' },
                        onchange: (e) => { setSetting('newCounts', e.target.checked); if (e.target.checked) checkSearches(true); } }),
                    el('span', {}, 'Neue Anzeigen zählen (lädt die erste Ergebnisseite jeder Suche höchstens einmal pro Stunde im Hintergrund)')),
                settings.newCounts && searches.length ? el('div', { className: 'kss-row' },
                    el('button', { type: 'button', className: 'kss-link', onclick: () => checkSearches(true) }, checking ? 'Wird geprüft …' : 'Jetzt prüfen')) : null));
        if (!panel.isConnected) document.body.appendChild(panel);
        if (focused) {
            const again = panel.querySelector(`[data-focus="${focused}"]`);
            if (again) again.focus({ preventScroll: true });
        }
    }

    // ------------------------------------------------------------------
    // Tastenkürzel Alt+1 … Alt+9
    // ------------------------------------------------------------------

    document.addEventListener('keydown', (e) => {
        if (!settings.shortcuts || !e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
        const m = /^Digit([1-9])$/.exec(e.code);
        if (!m) return;
        const t = e.target;
        if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
        const s = searches[Number(m[1]) - 1];
        if (!s) return;
        e.preventDefault();
        window.location.href = s.url;
    }, true);

    // ------------------------------------------------------------------
    // Einstellungen (im Superscript-Dialog)
    // ------------------------------------------------------------------

    KS.addSettings('suchen', () => [
        el('h3', {}, 'Gespeicherte Suchen'),
        KS.checkbox('Neue Anzeigen zählen: lädt die erste Ergebnisseite jeder gespeicherten Suche im Hintergrund, '
            + `höchstens einmal pro Stunde und ${CONFIG.checksPerVisit} Suchen pro Seitenaufruf`, settings.newCounts, v => setSetting('newCounts', v)),
        KS.checkbox('Tastenkürzel Alt+1 … Alt+9 für die ersten neun Suchen', settings.shortcuts, v => setSetting('shortcuts', v)),
        el('p', { className: 'ks-hint' }, `${searches.length} gespeicherte Suche${searches.length === 1 ? '' : 'n'}. `
            + 'Gezählt wird nur auf der ersten Ergebnisseite; am genauesten mit der Sortierung „Neueste zuerst“. '
            + 'In Firefox unter Linux wechselt Alt+1 … Alt+9 sonst die Tabs.'),
    ]);

    // ------------------------------------------------------------------
    // Start
    // ------------------------------------------------------------------

    const reload = () => { searches = loadSearches(); settings = loadSettings(); render(); };
    KS.onRemoteChange(CONFIG.keys.searches, reload);
    KS.onRemoteChange(CONFIG.keys.settings, reload);
    // Zurück-Taste: Seite kommt aus dem Cache, ohne dass das Script neu startet
    window.addEventListener('pageshow', (e) => { if (e.persisted) { reload(); noteVisit(); } });

    render();
    noteVisit();

    // Die Seite baut Teile neu auf und lädt Ergebnisse nach: Sidebar und Besuch nachziehen
    let scheduled = false;
    new MutationObserver(() => {
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(() => {
            scheduled = false;
            if (!tab.isConnected || !styleEl.isConnected || (settings.open && !panel.isConnected)) render();
            if (currentSearch()) noteVisit();
        });
    }).observe(document.documentElement, { childList: true, subtree: true });

    setTimeout(() => { if (document.visibilityState === 'visible') checkSearches(false); }, CONFIG.checkDelayMs);
})();
});
})();

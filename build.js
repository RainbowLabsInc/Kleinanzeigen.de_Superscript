#!/usr/bin/env node
/*
 * Baut superscript.user.js aus src/ und vendor/.
 *
 *   node build.js          bauen
 *   node build.js --sync   vorher die aktuellen Einzel-Scripts von GitHub nach vendor/ laden
 *   node build.js --check  nur prüfen, ob superscript.user.js zum Quellstand passt (z. B. vor einem Commit)
 *
 * Die Einzel-Scripts werden unverändert übernommen; nur ihr ==UserScript==-Kopf wird entfernt.
 * Ohne Abhängigkeiten, Node 18 oder neuer.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const VERSION = '0.2.4';
const OUT = 'superscript.user.js';
const REPO = 'https://github.com/RainbowLabsInc/Kleinanzeigen.de_Superscript';

const MODULES = [
    {
        id: 'melden',
        file: 'vendor/anzeige-melden.user.js',
        label: 'Anzeige melden',
        description: 'Button „Melden“ neben dem Preis: Anzeigen direkt aus der Übersicht melden, mit eigenen Bausteinen.',
        guard: 'data-klm-variant',
        source: 'https://github.com/RainbowLabsInc/Kleinanzeigen.de_Anzeige_melden',
        raw: 'https://raw.githubusercontent.com/RainbowLabsInc/Kleinanzeigen.de_Anzeige_melden/main/script.user.js',
    },
    {
        id: 'blockliste',
        file: 'vendor/nutzer-ausblenden.user.js',
        label: 'Nutzer ausblenden',
        description: 'Button „Ausblenden“ neben dem Preis: Anbieter blockieren, einzelne Anzeigen ausblenden, Listen teilen und abonnieren.',
        guard: 'data-kua',
        source: 'https://github.com/RainbowLabsInc/Kleinanzeigen.de-User_ausblenden',
        raw: 'https://raw.githubusercontent.com/RainbowLabsInc/Kleinanzeigen.de-User_ausblenden/main/script.user.js',
    },
    {
        id: 'preisverlauf',
        file: 'src/preisverlauf.js',
        label: 'Preisverlauf & Gesehen',
        description: 'Preisänderungen, „Neu“ seit dem letzten Besuch einer Suche und schon gesehene Anzeigen markieren.',
    },
    {
        id: 'suchen',
        file: 'src/suchen.js',
        label: 'Gespeicherte Suchen',
        description: 'Sidebar mit eigenen, benannten Suchen zum schnellen Umschalten, optional mit Zähler für neue Anzeigen.',
    },
];

const read = (file) => fs.readFileSync(path.join(__dirname, file), 'utf8');

function headerOf(code) {
    const m = code.match(/^\/\/ ==UserScript==\r?\n[\s\S]*?^\/\/ ==\/UserScript==\r?\n/m);
    return m ? m[0] : '';
}

function versionOf(code, file) {
    const m = headerOf(code).match(/^\/\/ @version\s+(\S+)/m);
    if (!m) throw new Error(`${file}: keine @version im ==UserScript==-Kopf gefunden`);
    return m[1];
}

async function sync() {
    for (const m of MODULES.filter(x => x.raw)) {
        const res = await fetch(m.raw, { headers: { 'Cache-Control': 'no-cache' } });
        if (!res.ok) throw new Error(`${m.raw}: HTTP ${res.status}`);
        const code = await res.text();
        const before = fs.existsSync(path.join(__dirname, m.file)) ? read(m.file) : '';
        fs.writeFileSync(path.join(__dirname, m.file), code);
        console.log(`${m.file}: ${before === code ? 'unverändert' : 'aktualisiert'} (${versionOf(code, m.file)})`);
    }
}

function build() {
    const meta = read('src/meta.js').replace(/@@VERSION@@/g, VERSION).replace(/@@REPO@@/g, REPO);
    const core = read('src/core.js').replace(/@@VERSION@@/g, VERSION);
    if (!core.includes('/* @@MODULES@@ */')) throw new Error('src/core.js: Platzhalter /* @@MODULES@@ */ fehlt');

    const parts = MODULES.map(m => {
        const raw = read(m.file);
        const header = headerOf(raw);
        const version = m.raw ? versionOf(raw, m.file) : VERSION;
        const code = raw.slice(header.length).replace(/^\s+/, '').replace(/\s+$/, '');
        const info = { label: m.label, version, description: m.description };
        if (m.guard) info.guard = m.guard;
        if (m.source) info.source = m.source;
        const line = '// ' + '='.repeat(72);
        return [
            line,
            `// Modul „${m.label}“ ${version}: ${m.file}`,
            m.source ? `// Unverändert übernommen aus ${m.source}` : '// Nur im Superscript',
            line,
            `KS.module(${JSON.stringify(m.id)}, ${JSON.stringify(info)}, function () {`,
            code,
            '});',
        ].join('\n');
    });

    return meta + '\n' + core.replace('/* @@MODULES@@ */', () => parts.join('\n\n'));
}

(async () => {
    const args = process.argv.slice(2);
    if (args.includes('--sync')) await sync();
    const out = build();
    const outPath = path.join(__dirname, OUT);
    if (args.includes('--check')) {
        const current = fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf8') : '';
        if (current !== out) {
            console.error(`${OUT} ist veraltet. Bitte \`node build.js\` ausführen.`);
            process.exit(1);
        }
        console.log(`${OUT} ist aktuell.`);
        return;
    }
    fs.writeFileSync(outPath, out);
    console.log(`${OUT} gebaut (Superscript ${VERSION}, ${MODULES.map(m => m.id).join(', ')}).`);
})().catch(e => {
    console.error(e.message || e);
    process.exit(1);
});

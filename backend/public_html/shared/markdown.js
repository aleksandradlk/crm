// ============================================================
// Kleiner Markdown-Renderer für die Wissensdatenbank (ohne Bibliothek).
// Erst wird alles HTML-escaped, dann werden nur bekannte Formate erzeugt:
// Überschriften, Absätze, Listen (auch verschachtelt, mit [ ]/[x]),
// Tabellen, Zitate, Code, Trennlinien, **fett**, *kursiv*, ~~durch~~,
// `code`, [Link](https://…) und nackte Links. Emojis bleiben, wie sie sind.
// MD.render(text) → HTML · MD.abschnitte(text) → [{ titel, ebene, md }]
// ============================================================
const MD = {
  esc(s) { return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); },
  slug(s) { return String(s).toLowerCase().replace(/<[^>]+>/g, '').replace(/[ä]/g, 'ae').replace(/[ö]/g, 'oe').replace(/[ü]/g, 'ue').replace(/ß/g, 'ss').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60); },

  inline(s) {
    const codes = [];
    let t = this.esc(s).replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
    t = t
      .replace(/\[([^\]]+)\]\(((?:https?:\/\/|mailto:|tel:|#)[^\s)]+)\)/g, (_, txt, url) =>
        `<a href="${url}"${url.startsWith('#') ? '' : ' target="_blank" rel="noopener"'}>${txt}</a>`)
      .replace(/(^|[\s(])(https?:\/\/[^\s<)]+[^\s<).,;:!?])/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>')
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/__([^_]+)__/g, '<b>$1</b>')
      .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<i>$2</i>')
      .replace(/~~([^~]+)~~/g, '<s>$1</s>')
      .replace(/ {2,}$/g, '<br>');
    return t.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[i]}</code>`);
  },

  _zellen(z) { return z.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(x => x.trim().replace(/\\\|/g, '|')); },

  render(text) {
    const zeilen = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let i = 0;
    const istTabelle = j => /^\s*\|.*\|\s*$/.test(zeilen[j] || '') && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(zeilen[j + 1] || '');
    const istListe = z => /^(\s*)([-*+]|\d+[.)])\s+/.test(z);
    const blockStart = z => /^\s*(#{1,6}\s|>|```|(-{3,}|\*{3,}|_{3,})\s*$)/.test(z) || istListe(z);
    while (i < zeilen.length) {
      const z = zeilen[i];
      if (!z.trim()) { i++; continue; }
      let m;
      if ((m = /^```\s*(\w*)/.exec(z))) {
        const code = []; i++;
        while (i < zeilen.length && !/^```/.test(zeilen[i])) code.push(zeilen[i++]);
        i++; out.push(`<pre><code>${this.esc(code.join('\n'))}</code></pre>`); continue;
      }
      if ((m = /^\s*(#{1,6})\s+(.+?)\s*#*\s*$/.exec(z))) {
        const n = m[1].length, h = this.inline(m[2]);
        out.push(`<h${n} id="md-${this.slug(m[2])}">${h}</h${n}>`); i++; continue;
      }
      if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(z)) { out.push('<hr>'); i++; continue; }
      if (istTabelle(i)) {
        const kopf = this._zellen(zeilen[i]);
        const ausr = this._zellen(zeilen[i + 1]).map(a => /^:-+:$/.test(a) ? 'center' : /-+:$/.test(a) ? 'right' : '');
        const st = k => ausr[k] ? ` style="text-align:${ausr[k]}"` : '';
        i += 2;
        const rows = [];
        while (i < zeilen.length && /^\s*\|.*\|\s*$/.test(zeilen[i])) rows.push(this._zellen(zeilen[i++]));
        out.push(`<div class="md-table"><table><thead><tr>${kopf.map((c, k) => `<th${st(k)}>${this.inline(c)}</th>`).join('')}</tr></thead><tbody>${
          rows.map(r => `<tr>${kopf.map((_, k) => `<td${st(k)}>${this.inline(r[k] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
        continue;
      }
      if (/^\s*>/.test(z)) {
        const q = [];
        while (i < zeilen.length && /^\s*>/.test(zeilen[i])) q.push(zeilen[i++].replace(/^\s*>\s?/, ''));
        out.push(`<blockquote>${this.render(q.join('\n'))}</blockquote>`); continue;
      }
      if (istListe(z)) {
        const block = [];
        while (i < zeilen.length && (istListe(zeilen[i]) || (/^\s{2,}\S/.test(zeilen[i]) && block.length))) block.push(zeilen[i++]);
        out.push(this._liste(block)); continue;
      }
      const p = [];
      while (i < zeilen.length && zeilen[i].trim() && !blockStart(zeilen[i]) && !istTabelle(i)) p.push(zeilen[i++]);
      out.push(`<p>${p.map(x => this.inline(x.replace(/^\s+/, ''))).join(' ').replace(/<br> /g, '<br>')}</p>`);
    }
    return out.join('\n');
  },

  _liste(zeilen) {
    const tiefe = z => Math.floor((/^(\s*)/.exec(z)[1].replace(/\t/g, '  ').length) / 2);
    let html = '', stapel = [];
    const auf = (tag) => { html += `<${tag}>`; stapel.push(tag); };
    zeilen.forEach(z => {
      const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(z);
      if (!m) { html = html.replace(/<\/li>$/, '') + ' ' + this.inline(z.trim()) + '</li>'; return; }
      const t = tiefe(z), tag = /\d/.test(m[2]) ? 'ol' : 'ul';
      while (stapel.length > t + 1) { html += `</${stapel.pop()}></li>`; }
      if (stapel.length === t + 1 && stapel[t] !== tag) { html += `</${stapel.pop()}>`; }
      if (stapel.length < t + 1) { if (stapel.length) html = html.replace(/<\/li>$/, ''); auf(tag); }
      let inhalt = m[3], box = '';
      const cb = /^\[( |x|X)\]\s+(.*)$/.exec(inhalt);
      if (cb) { box = `<span class="md-check${cb[1] === ' ' ? '' : ' is-done'}">${cb[1] === ' ' ? '☐' : '☑'}</span> `; inhalt = cb[2]; }
      html += `<li>${box}${this.inline(inhalt)}</li>`;
    });
    while (stapel.length) { const tag = stapel.pop(); html += `</${tag}>` + (stapel.length ? '</li>' : ''); }
    return html;
  },

  // Abschnitte nach Überschriften (## oder tiefer) – für aufklappbare Listen im Anrufmodus
  abschnitte(text, minEbene = 2) {
    const zeilen = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
    const teile = []; let akt = null, vorspann = [];
    let imCode = false;
    for (const z of zeilen) {
      if (/^```/.test(z)) imCode = !imCode;
      const m = !imCode && /^\s*(#{2,6})\s+(.+?)\s*#*\s*$/.exec(z);
      if (m && m[1].length >= minEbene && m[1].length <= minEbene + 1) {
        if (akt) teile.push(akt);
        akt = { titel: m[2].replace(/\*\*/g, ''), ebene: m[1].length, md: '' };
      } else if (akt) akt.md += z + '\n';
      else vorspann.push(z);
    }
    if (akt) teile.push(akt);
    return { vorspann: vorspann.filter(z => !/^\s*#\s/.test(z)).join('\n').trim(), teile };
  },
};
if (typeof module !== 'undefined' && module.exports) module.exports = MD;
